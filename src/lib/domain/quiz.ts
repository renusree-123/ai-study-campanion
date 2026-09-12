import { db } from "../db";
import { logger } from "../logger";
import { AppError } from "../errors";
import { parseJson } from "../json";
import { truncate } from "../ai/text";
import { runStructuredPrompt } from "../ai/run";
import { openGradingPrompt, quizGenerationPrompt, type EvidencePassage } from "../ai/prompts";
import { searchProject, sourceLabel } from "../retrieval/search";
import { getProjectMastery, type ConceptMasteryView, type Difficulty } from "./mastery";
import type { OwnedProject } from "../auth/ownership";

/**
 * Adaptive assessment (PRD §24-§28).
 *
 * The selector answers two questions before every question is generated:
 * *which concept* and *at what difficulty*. Both are scored, not branched.
 *
 * Concept selection maximises expected learning value:
 *
 *     value = uncertainty x importance x staleness x coverage
 *
 *   - uncertainty peaks at mastery ~0.5. A concept at 5% or 95% teaches you
 *     little by being tested; one you half-know is where the information is.
 *   - importance weights concepts central to the material.
 *   - staleness favours concepts not tested recently, so the quiz does not
 *     fixate on one topic.
 *   - coverage penalises concepts already asked about in this quiz.
 *
 * Difficulty targets a ~70% success probability — hard enough to be
 * informative, not so hard it is demoralising — and is nudged by the learner's
 * recent run of answers rather than by the single previous one. This is
 * explicitly *not* "wrong -> easy, right -> hard" (§26).
 */

export interface QuestionSelection {
  concept: ConceptMasteryView;
  difficulty: Difficulty;
  type: "MCQ" | "OPEN";
  reason: string;
}

export interface SelectionSignals {
  mastery: ConceptMasteryView[];
  askedConceptIds: string[];
  /** Most recent answers first: true = correct. */
  recentOutcomes: boolean[];
  lastTestedAt: Map<string, number>;
  questionIndex: number;
  plannedCount: number;
  focusConceptIds: string[];
}

export function selectNextQuestion(signals: SelectionSignals): QuestionSelection | null {
  const candidates = signals.mastery.filter((c) => c.importance > 0.05);
  if (candidates.length === 0) return null;

  const now = Date.now();
  const focus = new Set(signals.focusConceptIds);
  const askedCounts = new Map<string, number>();
  for (const id of signals.askedConceptIds) {
    askedCounts.set(id, (askedCounts.get(id) ?? 0) + 1);
  }

  const scored = candidates.map((concept) => {
    // Peaks at 0.5 mastery, falls off toward either extreme.
    const uncertainty = 1 - Math.abs(concept.level - 0.5) * 2;
    // Low-confidence estimates are worth probing regardless of level.
    const confidenceGap = 1 - concept.confidence;

    const lastTested = signals.lastTestedAt.get(concept.conceptId);
    const daysSince = lastTested ? (now - lastTested) / 86_400_000 : 30;
    const staleness = Math.min(1, 0.3 + daysSince / 14);

    const timesAsked = askedCounts.get(concept.conceptId) ?? 0;
    const coverage = 1 / (1 + timesAsked * 1.8);

    const focusBoost = focus.size > 0 ? (focus.has(concept.conceptId) ? 1.6 : 0.35) : 1;

    const value =
      (uncertainty * 0.45 + confidenceGap * 0.3 + (1 - concept.level) * 0.25) *
      (0.5 + concept.importance) *
      staleness *
      coverage *
      focusBoost;

    return { concept, value, uncertainty, staleness, timesAsked };
  });

  scored.sort((a, b) => b.value - a.value);
  const chosen = scored[0];

  // --- Difficulty ---------------------------------------------------------
  // The base band comes from the mastery estimate; a *run* of recent outcomes
  // then steps it by one band. Deliberately not "wrong -> easy, right -> hard"
  // (§26): a single answer never moves the difficulty, and the starting point
  // is the learner's modelled ability rather than the last result.
  let target = chosen.concept.level;
  // A low-confidence estimate is not worth anchoring to; start mid-range.
  if (chosen.concept.confidence < 0.25) target = Math.max(target, 0.45);

  const BANDS: Difficulty[] = ["EASY", "MEDIUM", "HARD"];
  let band = target < 0.4 ? 0 : target < 0.72 ? 1 : 2;

  const window = signals.recentOutcomes.slice(0, 3);
  const recentCorrect = window.filter(Boolean).length;
  let ramp: "up" | "down" | null = null;
  if (window.length >= 2) {
    if (recentCorrect === window.length) {
      band = Math.min(BANDS.length - 1, band + 1);
      ramp = "up";
    } else if (recentCorrect === 0) {
      band = Math.max(0, band - 1);
      ramp = "down";
    }
  }
  const difficulty: Difficulty = BANDS[band];

  // --- Question type ------------------------------------------------------
  // Open questions are where partial understanding shows, so every quiz of
  // three or more includes at least one. Beyond that, they are used where the
  // learner has enough grounding to articulate an answer.
  const isOpenSlot = signals.questionIndex % 3 === 2;
  const type: "MCQ" | "OPEN" =
    isOpenSlot || (difficulty === "HARD" && chosen.concept.level >= 0.45) ? "OPEN" : "MCQ";

  const reasons: string[] = [];
  reasons.push(
    chosen.concept.evidenceCount === 0
      ? "no assessment evidence yet"
      : `mastery ${Math.round(chosen.concept.level * 100)}% (${chosen.concept.trend.toLowerCase().replace("_", " ")})`,
  );
  if (focus.has(chosen.concept.conceptId)) reasons.push("requested focus area");
  if (chosen.staleness >= 0.9) reasons.push("not tested recently");
  if (ramp === "up") reasons.push(`raised to ${difficulty} after ${window.length} correct in a row`);
  if (ramp === "down") reasons.push(`eased to ${difficulty} after ${window.length} incorrect in a row`);
  if (type === "OPEN") reasons.push("open response to test explanation, not recognition");

  return {
    concept: chosen.concept,
    difficulty,
    type,
    reason: reasons.join("; "),
  };
}

/** Gathers the signals the selector needs and picks the next question. */
export async function planNextQuestion(
  quizId: string,
  projectId: string,
): Promise<QuestionSelection | null> {
  const [quiz, mastery, asked, answers] = await Promise.all([
    db.quiz.findUnique({ where: { id: quizId } }),
    getProjectMastery(projectId),
    db.quizQuestion.findMany({
      where: { quizId },
      select: { conceptId: true, prompt: true },
    }),
    db.quizAnswer.findMany({
      where: { quiz: { projectId } },
      orderBy: { answeredAt: "desc" },
      take: 40,
      select: {
        isCorrect: true,
        answeredAt: true,
        quizId: true,
        question: { select: { conceptId: true } },
      },
    }),
  ]);
  if (!quiz) throw new AppError("NOT_FOUND", "Quiz not found.");

  const lastTestedAt = new Map<string, number>();
  for (const answer of answers) {
    const conceptId = answer.question.conceptId;
    if (!conceptId || lastTestedAt.has(conceptId)) continue;
    lastTestedAt.set(conceptId, answer.answeredAt.getTime());
  }

  return selectNextQuestion({
    mastery,
    askedConceptIds: asked.map((q) => q.conceptId).filter((id): id is string => Boolean(id)),
    // Outcomes within this quiz drive the difficulty ramp.
    recentOutcomes: answers.filter((a) => a.quizId === quizId).map((a) => a.isCorrect),
    lastTestedAt,
    questionIndex: asked.length,
    plannedCount: quiz.plannedCount,
    focusConceptIds: parseJson<string[]>(quiz.focusConcepts, []),
  });
}

/**
 * Generates and persists the next question.
 *
 * Idempotency (PRD §50): the (quizId, index) pair is unique, so a retried
 * request that races with the first cannot create a second question at the
 * same position — the loser returns the existing row.
 */
export async function generateNextQuestion(params: {
  quizId: string;
  project: OwnedProject;
  userId: string;
  traceId: string;
}) {
  const existingUnanswered = await db.quizQuestion.findFirst({
    where: { quizId: params.quizId, answer: null },
    orderBy: { index: "asc" },
    include: { concept: true },
  });
  // Never generate ahead of the learner: one open question at a time.
  if (existingUnanswered) return existingUnanswered;

  const selection = await planNextQuestion(params.quizId, params.project.id);
  if (!selection) {
    throw new AppError(
      "CONFLICT",
      "No concepts are available to build a question from.",
      {
        userMessage:
          "This project has no concepts to quiz on yet. Upload a material and wait for it to finish processing.",
      },
    );
  }

  const index = await db.quizQuestion.count({ where: { quizId: params.quizId } });

  // Evidence: prefer chunks explicitly linked to the concept; fall back to a
  // search when the link table has nothing (short or unusual materials).
  const evidence = await evidenceForConcept({
    projectId: params.project.id,
    userId: params.userId,
    conceptId: selection.concept.conceptId,
    conceptName: selection.concept.name,
    traceId: params.traceId,
  });

  if (evidence.length === 0) {
    throw new AppError("CONFLICT", "No source material found for the selected concept.", {
      userMessage:
        "We could not find material to build a question from. Try uploading more content to this project.",
    });
  }

  const [previousMistakes, askedQuestions] = await Promise.all([
    db.quizAnswer.findMany({
      where: {
        userId: params.userId,
        isCorrect: false,
        question: { conceptId: selection.concept.conceptId },
      },
      orderBy: { answeredAt: "desc" },
      take: 3,
      select: { question: { select: { prompt: true } }, rawAnswer: true },
    }),
    db.quizQuestion.findMany({
      where: { quiz: { projectId: params.project.id }, conceptId: selection.concept.conceptId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { prompt: true },
    }),
  ]);

  const generated = await runStructuredPrompt(
    quizGenerationPrompt,
    {
      projectName: params.project.name,
      conceptName: selection.concept.name,
      difficulty: selection.difficulty,
      questionType: selection.type,
      evidence,
      masteryLevel: selection.concept.level,
      previousMistakes: previousMistakes.map(
        (m) => `Asked "${truncate(m.question.prompt, 120)}" — answered "${truncate(m.rawAnswer, 120)}"`,
      ),
      askedQuestions: askedQuestions.map((q) => truncate(q.prompt, 160)),
    },
    { traceId: params.traceId, userId: params.userId, projectId: params.project.id },
  );

  const question = generated.value;

  // Validate the model's structure against our own invariants before it is
  // shown to a learner — a 3-option MCQ or an out-of-range index is a bug we
  // catch here rather than render (PRD §42).
  if (question.type === "MCQ") {
    if (question.options.length !== 4) {
      throw new AppError(
        "AI_INVALID_OUTPUT",
        `Generated MCQ had ${question.options.length} options, expected 4.`,
      );
    }
    if (
      question.correctIndex === null ||
      question.correctIndex < 0 ||
      question.correctIndex >= question.options.length
    ) {
      throw new AppError("AI_INVALID_OUTPUT", "Generated MCQ had an invalid correct index.");
    }
  } else if (question.rubric.length === 0) {
    throw new AppError("AI_INVALID_OUTPUT", "Generated open question had no rubric points.");
  }

  try {
    return await db.quizQuestion.create({
      data: {
        quizId: params.quizId,
        index,
        type: question.type,
        prompt: question.prompt,
        options: JSON.stringify(question.type === "MCQ" ? question.options : []),
        correctIndex: question.type === "MCQ" ? question.correctIndex : null,
        referenceAnswer: question.referenceAnswer,
        rubric: JSON.stringify(question.rubric),
        explanation: question.explanation,
        conceptId: selection.concept.conceptId,
        difficulty: selection.difficulty,
        sources: JSON.stringify(
          evidence.map((e) => ({ label: e.sourceLabel, chunkId: e.chunkId })),
        ),
        promptVersion: `${quizGenerationPrompt.id}@${quizGenerationPrompt.version}`,
        selectionReason: selection.reason,
      },
      include: { concept: true },
    });
  } catch (error) {
    // Lost a race on the unique (quizId, index) — return the winner's row.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      const winner = await db.quizQuestion.findFirst({
        where: { quizId: params.quizId, index },
        include: { concept: true },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

async function evidenceForConcept(params: {
  projectId: string;
  userId: string;
  conceptId: string;
  conceptName: string;
  traceId: string;
}): Promise<EvidencePassage[]> {
  const linked = await db.conceptChunk.findMany({
    where: { conceptId: params.conceptId },
    orderBy: { weight: "desc" },
    take: 4,
    include: {
      chunk: {
        select: {
          id: true,
          content: true,
          page: true,
          material: { select: { filename: true, status: true } },
        },
      },
    },
  });

  const fromLinks = linked
    .filter((link) => link.chunk.material.status === "READY")
    .map((link) => ({
      sourceLabel: sourceLabel({
        materialName: link.chunk.material.filename,
        page: link.chunk.page,
      }),
      text: truncate(link.chunk.content, 1400),
      chunkId: link.chunk.id,
    }));

  if (fromLinks.length >= 2) return fromLinks;

  const search = await searchProject({
    projectId: params.projectId,
    userId: params.userId,
    query: params.conceptName,
    limit: 4,
    rerank: false,
    traceId: params.traceId,
  });

  const merged = [...fromLinks];
  for (const chunk of search.chunks) {
    if (merged.some((m) => m.chunkId === chunk.chunkId)) continue;
    merged.push({
      sourceLabel: sourceLabel(chunk),
      text: truncate(chunk.content, 1400),
      chunkId: chunk.chunkId,
    });
  }
  return merged.slice(0, 4);
}

export interface EvaluationOutcome {
  score: number;
  isCorrect: boolean;
  feedback: string;
  coveredPoints: string[];
  missingPoints: string[];
  evaluatedBy: string;
  latencyMs: number;
}

/**
 * Evaluates an answer. MCQ is decided by the application (never the model);
 * open answers are graded by the model against the stored rubric (§28).
 */
export async function evaluateAnswer(params: {
  question: {
    id: string;
    type: string;
    prompt: string;
    options: string;
    correctIndex: number | null;
    referenceAnswer: string;
    rubric: string;
    explanation: string;
    conceptId: string | null;
  };
  conceptName: string;
  rawAnswer: string;
  selectedIndex: number | null;
  userId: string;
  projectId: string;
  traceId: string;
}): Promise<EvaluationOutcome> {
  const started = Date.now();

  if (params.question.type === "MCQ") {
    const isCorrect =
      params.selectedIndex !== null && params.selectedIndex === params.question.correctIndex;
    const options = parseJson<string[]>(params.question.options, []);
    const correctText = options[params.question.correctIndex ?? -1] ?? "";
    return {
      score: isCorrect ? 1 : 0,
      isCorrect,
      feedback: isCorrect
        ? `Correct. ${params.question.explanation}`
        : `Not quite. The correct answer is "${truncate(correctText, 200)}". ${params.question.explanation}`,
      coveredPoints: isCorrect ? [params.conceptName] : [],
      missingPoints: isCorrect ? [] : [params.conceptName],
      evaluatedBy: "rule",
      latencyMs: Date.now() - started,
    };
  }

  const rubric = parseJson<string[]>(params.question.rubric, []);
  try {
    const result = await runStructuredPrompt(
      openGradingPrompt,
      {
        question: params.question.prompt,
        referenceAnswer: params.question.referenceAnswer,
        rubric,
        studentAnswer: params.rawAnswer,
        conceptName: params.conceptName,
      },
      { traceId: params.traceId, userId: params.userId, projectId: params.projectId },
    );
    return {
      score: result.value.score,
      isCorrect: result.value.isCorrect,
      feedback: result.value.feedback,
      coveredPoints: result.value.coveredPoints,
      missingPoints: result.value.missingPoints,
      evaluatedBy: result.model,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    // Grading failed. Recording a 0 would corrupt the learner's mastery based
    // on our outage, so the answer is stored unscored and excluded from
    // mastery until it can be regraded (PRD §49).
    logger.error("open_grading_failed", { questionId: params.question.id, error });
    throw new AppError("AI_PROVIDER_ERROR", "Could not grade this answer.", {
      userMessage:
        "We could not grade that answer right now. Your answer was not recorded — please try submitting it again in a moment.",
      cause: error,
    });
  }
}
