import { db } from "../db";
import { logger, newTraceId } from "../logger";
import { errorMessage } from "../errors";
import { truncate } from "../ai/text";
import { ai } from "../ai/router";
import { runStructuredPrompt } from "../ai/run";
import { quizGenerationPrompt, openGradingPrompt, recommendationPrompt } from "../ai/prompts";
import { searchProject, sourceLabel } from "../retrieval/search";
import { answerQuestion } from "../domain/tutor";
import { getWeakConcepts, getProjectMastery } from "../domain/mastery";
import type { OwnedProject } from "../auth/ownership";
import {
  casesForSuite,
  type AssessmentCase,
  type EvalCase,
  type GradingCase,
  type RecommendationCase,
  type RetrievalCase,
  type Suite,
  type TutorCase,
} from "./dataset";
import {
  averageScore,
  scoreCitationAccuracy,
  scoreContent,
  scoreGrading,
  scoreGroundedness,
  scoreInjectionResistance,
  scoreQuestionStructure,
  scoreRecommendation,
  scoreRefusal,
  scoreRetrieval,
  type Score,
} from "./scorers";

/**
 * Evaluation runner (PRD §46, §47).
 *
 * Runs a suite of curated cases against the live application code — the same
 * retrieval, the same prompts, the same domain services the product uses — and
 * persists the result as an EvalRun so behaviour can be compared over time.
 *
 * Regression detection compares each case against the most recent prior run of
 * the same suite: a case that scored well before and scores badly now is a
 * regression, and is named explicitly rather than being averaged away.
 */

export interface RunOptions {
  suite: Suite;
  /** Which user's seeded projects to evaluate against. */
  userId?: string;
  label?: string;
  onProgress?: (done: number, total: number, caseId: string) => void;
}

interface CaseOutcome {
  caseId: string;
  category: string;
  input: string;
  expected: string;
  actual: string;
  score: number;
  passed: boolean;
  metrics: Record<string, number>;
  notes: string;
  latencyMs: number;
  error?: string;
}

export async function runEvaluation(options: RunOptions) {
  const provider = ai.describe();
  const cases = casesForSuite(options.suite);

  const user = options.userId
    ? await db.user.findUnique({ where: { id: options.userId } })
    : await db.user.findFirst({ where: { role: "USER" }, orderBy: { createdAt: "asc" } });

  if (!user) {
    throw new Error(
      "No user to evaluate against. Run `npm run db:seed` first — the dataset targets the seeded demo projects.",
    );
  }

  const baseline = await db.evalRun.findFirst({
    where: { suite: options.suite, status: "COMPLETED" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  const run = await db.evalRun.create({
    data: {
      suite: options.suite,
      label: options.label ?? "",
      provider: provider.provider,
      model: provider.model,
      status: "RUNNING",
      totalCases: cases.length,
      baselineRunId: baseline?.id ?? null,
    },
  });

  const startedAt = Date.now();
  const outcomes: CaseOutcome[] = [];

  for (const [index, testCase] of cases.entries()) {
    options.onProgress?.(index, cases.length, testCase.id);
    const caseStarted = Date.now();
    try {
      const outcome = await runCase(testCase, user.id);
      outcomes.push({ ...outcome, latencyMs: Date.now() - caseStarted });
    } catch (error) {
      logger.error("eval_case_failed", { caseId: testCase.id, error });
      outcomes.push({
        caseId: testCase.id,
        category: testCase.category,
        input: "",
        expected: "",
        actual: "",
        score: 0,
        passed: false,
        metrics: {},
        notes: "Case threw an exception",
        latencyMs: Date.now() - caseStarted,
        error: truncate(errorMessage(error), 400),
      });
    }
  }

  // Persist per-case results.
  for (const outcome of outcomes) {
    await db.evalCaseResult.create({
      data: {
        runId: run.id,
        caseId: outcome.caseId,
        category: outcome.category,
        input: truncate(outcome.input, 1000),
        expected: truncate(outcome.expected, 1000),
        actual: truncate(outcome.actual, 2000),
        score: outcome.score,
        passed: outcome.passed,
        metrics: JSON.stringify(outcome.metrics),
        notes: truncate(outcome.notes, 800),
        latencyMs: outcome.latencyMs,
        error: outcome.error ?? null,
      },
    });
  }

  // Aggregate per-metric averages across every case that reported them.
  const metricTotals = new Map<string, { sum: number; count: number }>();
  for (const outcome of outcomes) {
    for (const [metric, value] of Object.entries(outcome.metrics)) {
      const entry = metricTotals.get(metric) ?? { sum: 0, count: 0 };
      entry.sum += value;
      entry.count += 1;
      metricTotals.set(metric, entry);
    }
  }
  const metrics = Object.fromEntries(
    [...metricTotals.entries()].map(([metric, { sum, count }]) => [
      metric,
      Math.round((sum / count) * 1000) / 1000,
    ]),
  );

  // Regression comparison against the previous run of the same suite.
  const diff = { improved: [] as string[], regressed: [] as string[] };
  if (baseline) {
    const previous = await db.evalCaseResult.findMany({
      where: { runId: baseline.id },
      select: { caseId: true, score: true },
    });
    const previousById = new Map(previous.map((r) => [r.caseId, r.score]));
    for (const outcome of outcomes) {
      const before = previousById.get(outcome.caseId);
      if (before === undefined) continue;
      // 0.1 of a point is the noise floor; smaller moves are not reported.
      if (outcome.score - before > 0.1) diff.improved.push(outcome.caseId);
      else if (before - outcome.score > 0.1) diff.regressed.push(outcome.caseId);
    }
  }

  const passed = outcomes.filter((o) => o.passed).length;
  const completed = await db.evalRun.update({
    where: { id: run.id },
    data: {
      status: "COMPLETED",
      passedCases: passed,
      avgScore: averageScore(outcomes.map((o) => ({ score: o.score }) as Score)),
      metrics: JSON.stringify(metrics),
      diff: JSON.stringify(diff),
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt,
    },
  });

  return { run: completed, outcomes, diff, metrics };
}

async function resolveProject(userId: string, hint: string): Promise<OwnedProject> {
  const project = await db.project.findFirst({
    where: { userId, name: { contains: hint }, archivedAt: null },
    select: { id: true, userId: true, spaceId: true, name: true, goal: true, description: true },
  });
  if (!project) {
    throw new Error(
      `No project matching "${hint}" for this user. The dataset targets the seeded demo projects — run \`npm run db:seed\`.`,
    );
  }
  return project;
}

async function runCase(testCase: EvalCase, userId: string): Promise<Omit<CaseOutcome, "latencyMs">> {
  const traceId = newTraceId();

  if (testCase.category === "tutor") {
    return runTutorCase(testCase, userId, traceId);
  }
  if (testCase.category === "retrieval") {
    return runRetrievalCase(testCase, userId, traceId);
  }
  if (testCase.category === "recommendation") {
    return runRecommendationCase(testCase, userId, traceId);
  }
  if ("kind" in testCase && testCase.kind === "grading") {
    return runGradingCase(testCase, userId, traceId);
  }
  return runQuestionGenerationCase(testCase as AssessmentCase, userId, traceId);
}

async function runTutorCase(testCase: TutorCase, userId: string, traceId: string) {
  const project = await resolveProject(userId, testCase.projectHint);
  const conversation = await db.conversation.create({
    data: { projectId: project.id, userId, title: `eval:${testCase.id}` },
  });

  try {
    const result = await answerQuestion({
      project,
      conversationId: conversation.id,
      question: testCase.question,
      userId,
      traceId,
    });

    const scores: Record<string, Score> = {};

    if (testCase.expectation === "UNSUPPORTED") {
      scores.refusal = scoreRefusal(result.grounding, result.citations);
      scores.injectionResistance = scoreInjectionResistance(result.answer);
    } else {
      scores.groundedness = scoreGroundedness(result.grounding, result.citations);
      scores.citationAccuracy = scoreCitationAccuracy(result.citations, testCase.expectedSource);
      scores.content = scoreContent(result.answer, testCase.mustMention);
      scores.injectionResistance = scoreInjectionResistance(result.answer);
    }

    const entries = Object.entries(scores);
    return {
      caseId: testCase.id,
      category: "tutor",
      input: testCase.question,
      expected: `${testCase.expectation}${testCase.expectedSource ? ` from ${testCase.expectedSource}` : ""}`,
      actual: truncate(result.answer, 1500),
      score: averageScore(entries.map(([, s]) => s)),
      passed: entries.every(([, s]) => s.passed),
      metrics: Object.fromEntries(entries.map(([name, s]) => [name, s.score])),
      notes: entries.map(([name, s]) => `${name}: ${s.reason}`).join(" | "),
    };
  } finally {
    // Evaluation must not pollute the learner's real conversation history.
    await db.conversation.delete({ where: { id: conversation.id } }).catch(() => {});
  }
}

async function runRetrievalCase(testCase: RetrievalCase, userId: string, traceId: string) {
  const project = await resolveProject(userId, testCase.projectHint);
  const result = await searchProject({
    projectId: project.id,
    userId,
    query: testCase.query,
    limit: 5,
    rerank: false,
    traceId,
  });

  const score = scoreRetrieval(
    result.chunks.map((c) => ({ content: c.content })),
    testCase.mustRetrieve,
    Boolean(testCase.expectEmpty),
  );

  return {
    caseId: testCase.id,
    category: "retrieval",
    input: testCase.query,
    expected: testCase.expectEmpty
      ? "no results"
      : `passages containing: ${testCase.mustRetrieve.join(", ")}`,
    actual:
      result.chunks.length === 0
        ? "(no results)"
        : result.chunks.map((c) => `${sourceLabel(c)}: ${truncate(c.content, 140)}`).join("\n"),
    score: score.score,
    passed: score.passed,
    metrics: { retrievalRelevance: score.score, returned: result.chunks.length },
    notes: score.reason,
  };
}

async function runQuestionGenerationCase(
  testCase: AssessmentCase,
  userId: string,
  traceId: string,
) {
  const project = await resolveProject(userId, testCase.projectHint);
  const concept = await db.concept.findFirst({
    where: { projectId: project.id, name: { contains: testCase.conceptHint } },
  });
  if (!concept) {
    throw new Error(`No concept matching "${testCase.conceptHint}" in project ${project.name}.`);
  }

  const evidence = await searchProject({
    projectId: project.id,
    userId,
    query: concept.name,
    limit: 4,
    rerank: false,
    traceId,
  });

  const generated = await runStructuredPrompt(
    quizGenerationPrompt,
    {
      projectName: project.name,
      conceptName: concept.name,
      difficulty: testCase.difficulty,
      questionType: testCase.questionType,
      evidence: evidence.chunks.map((chunk) => ({
        sourceLabel: sourceLabel(chunk),
        text: truncate(chunk.content, 1200),
        chunkId: chunk.chunkId,
      })),
      masteryLevel: 0.5,
      previousMistakes: [],
      askedQuestions: [],
    },
    { traceId, userId, projectId: project.id },
  );

  const structure = scoreQuestionStructure(generated.value);
  const typeMatches = generated.value.type === testCase.questionType;

  return {
    caseId: testCase.id,
    category: "assessment",
    input: `${testCase.questionType} / ${testCase.difficulty} on "${concept.name}"`,
    expected: "structurally valid, correct type",
    actual: JSON.stringify(generated.value, null, 2),
    score: structure.score * (typeMatches ? 1 : 0.5),
    passed: structure.passed && typeMatches,
    metrics: {
      structuredOutputValidity: structure.score,
      typeAdherence: typeMatches ? 1 : 0,
    },
    notes: `${structure.reason}${typeMatches ? "" : ` | returned ${generated.value.type}, expected ${testCase.questionType}`}`,
  };
}

async function runGradingCase(testCase: GradingCase, userId: string, traceId: string) {
  const result = await runStructuredPrompt(
    openGradingPrompt,
    {
      question: testCase.question,
      referenceAnswer: testCase.referenceAnswer,
      rubric: testCase.rubric,
      studentAnswer: testCase.studentAnswer,
      conceptName: "Testing effect",
    },
    { traceId, userId },
  );

  const banded = scoreGrading(result.value.score, testCase.expectedScoreRange);
  const hasFeedback = result.value.feedback.trim().length >= 20;

  return {
    caseId: testCase.id,
    category: "assessment",
    input: testCase.studentAnswer,
    expected: `score in ${testCase.expectedScoreRange.join("-")}`,
    actual: `score=${result.value.score} · ${result.value.feedback}`,
    score: banded.score * (hasFeedback ? 1 : 0.7),
    passed: banded.passed && hasFeedback,
    metrics: {
      gradingAccuracy: banded.score,
      feedbackQuality: hasFeedback ? 1 : 0,
    },
    notes: `${banded.reason}${hasFeedback ? "" : " | feedback too short to be useful"}`,
  };
}

async function runRecommendationCase(
  testCase: RecommendationCase,
  userId: string,
  traceId: string,
) {
  const project = await resolveProject(userId, testCase.projectHint);
  const [weak, mastery, materialCount] = await Promise.all([
    getWeakConcepts(project.id, 3),
    getProjectMastery(project.id),
    db.material.count({ where: { projectId: project.id, status: "READY" } }),
  ]);

  const result = await runStructuredPrompt(
    recommendationPrompt,
    {
      projectName: project.name,
      goal: project.goal,
      materialCount,
      weakConcepts: weak.map((c) => ({ name: c.name, level: c.level, trend: c.trend })),
      strongConcepts: mastery.filter((m) => m.level > 0.75).map((m) => m.name),
      recentAccuracy: 0.55,
      recentMistakes: [],
      previousRecommendations: [],
      daysSinceLastActivity: 0,
    },
    { traceId, userId, projectId: project.id },
  );

  const quality = scoreRecommendation(result.value);

  // Alignment: does the advice actually target a concept the learner is weak on?
  const weakNames = weak.map((w) => w.name.toLowerCase());
  const aligned =
    weak.length === 0 ||
    result.value.conceptNames.some((name) =>
      weakNames.some((weakName) => weakName.includes(name.toLowerCase()) || name.toLowerCase().includes(weakName)),
    ) ||
    weakNames.some((weakName) => result.value.body.toLowerCase().includes(weakName));

  return {
    caseId: testCase.id,
    category: "recommendation",
    input: `weak concepts: ${weak.map((w) => w.name).join(", ") || "(none)"}`,
    expected: "specific, actionable, targets a weak concept",
    actual: `${result.value.title}\n${result.value.body}\n[${result.value.actionType}]`,
    score: quality.score * (aligned ? 1 : 0.5),
    passed: quality.passed && aligned,
    metrics: {
      recommendationActionability: quality.score,
      learnerStateAlignment: aligned ? 1 : 0,
    },
    notes: `${quality.reason}${aligned ? "" : " | does not target a weak concept"}`,
  };
}
