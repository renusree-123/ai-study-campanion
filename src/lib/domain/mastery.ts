import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { logger } from "../logger";

/**
 * Concept mastery model (PRD §29).
 *
 * The estimate is an evidence-weighted exponential moving average with a
 * separate confidence term. Three properties matter:
 *
 *  1. **Difficulty-aware targets.** Getting an easy question right does not
 *     prove mastery, and getting a hard one wrong does not disprove it. Each
 *     (difficulty, outcome) pair maps to a different target the estimate moves
 *     toward, rather than treating every answer as evidence of the same weight.
 *
 *  2. **Confidence-damped learning rate.** Early evidence moves the estimate a
 *     long way; once there is a lot of evidence the estimate is stable and a
 *     single unlucky answer cannot erase a track record. This is what keeps the
 *     display honest instead of jittering after every question.
 *
 *  3. **Asymmetry.** Evidence of *not* knowing something is weighted slightly
 *     higher than evidence of knowing it, because a wrong answer is a stronger
 *     signal than a right one (guessing exists; accidentally being wrong about
 *     something you know is rarer).
 *
 * This is deliberately a transparent heuristic rather than a full IRT/BKT
 * model. The PRD asks for an understandable representation of learning state,
 * not a psychometrically validated one, and a model a learner can reason about
 * ("I got two hard ones right and it went up a lot") is more useful here.
 */

export type Difficulty = "EASY" | "MEDIUM" | "HARD";
export type EvidenceSource = "QUIZ_MCQ" | "QUIZ_OPEN" | "TUTOR";

export interface MasteryEvidence {
  /** 0..1 — 0/1 for MCQ, graded for open answers. */
  score: number;
  difficulty: Difficulty;
  source: EvidenceSource;
}

/** Where the estimate is pulled toward, given the difficulty and the outcome. */
function targetFor(evidence: MasteryEvidence): number {
  const { score, difficulty } = evidence;
  // Ceilings: the most an answer at this difficulty can demonstrate.
  const ceiling: Record<Difficulty, number> = { EASY: 0.7, MEDIUM: 0.88, HARD: 1.0 };
  // Floors: the least a wrong answer at this difficulty implies.
  const floor: Record<Difficulty, number> = { EASY: 0.05, MEDIUM: 0.25, HARD: 0.45 };
  return floor[difficulty] + score * (ceiling[difficulty] - floor[difficulty]);
}

/** How much this evidence is allowed to move the estimate. */
function weightFor(evidence: MasteryEvidence): number {
  const bySource: Record<EvidenceSource, number> = {
    // An open answer reveals more than a 1-in-4 multiple choice guess.
    QUIZ_OPEN: 1.0,
    QUIZ_MCQ: 0.8,
    // A tutor exchange is engagement, not assessment — weak evidence only.
    TUTOR: 0.25,
  };
  const byDifficulty: Record<Difficulty, number> = { EASY: 0.8, MEDIUM: 1.0, HARD: 1.15 };
  return bySource[evidence.source] * byDifficulty[evidence.difficulty];
}

export interface MasteryUpdate {
  conceptId: string;
  previousLevel: number;
  level: number;
  confidence: number;
  delta: number;
  trend: string;
}

const BASE_LEARNING_RATE = 0.45;
const MIN_LEARNING_RATE = 0.06;
const NEGATIVE_EVIDENCE_BOOST = 1.15;

/**
 * Applies one piece of evidence to a concept's mastery.
 *
 * Idempotency (PRD §50): callers pass the answer id as `evidenceKey`. Mastery
 * is only ever updated from inside the transaction that records the answer, and
 * an answer row can only be written once (QuizAnswer.questionId is unique), so
 * a retried request cannot double-count the same answer.
 */
export async function applyEvidence(
  params: {
    projectId: string;
    userId: string;
    conceptId: string;
    evidence: MasteryEvidence;
  },
  client: Prisma.TransactionClient | typeof db = db,
): Promise<MasteryUpdate> {
  const existing = await client.mastery.findUnique({
    where: { projectId_conceptId: { projectId: params.projectId, conceptId: params.conceptId } },
  });

  const currentLevel = existing?.level ?? 0.25;
  const currentConfidence = existing?.confidence ?? 0.1;

  const target = targetFor(params.evidence);
  const weight = weightFor(params.evidence);

  // Confidence damping: rate falls as evidence accumulates, with a floor so the
  // estimate never freezes and can still respond to a genuine change.
  const damped = BASE_LEARNING_RATE * (1 - currentConfidence * 0.8);
  const isNegative = target < currentLevel;
  const rate = Math.max(
    MIN_LEARNING_RATE,
    damped * weight * (isNegative ? NEGATIVE_EVIDENCE_BOOST : 1),
  );

  const level = clamp01(currentLevel + rate * (target - currentLevel));
  // Confidence approaches 1 asymptotically; heavier evidence moves it faster.
  const confidence = clamp01(1 - (1 - currentConfidence) * (1 - 0.16 * weight));

  const correct = params.evidence.score >= 0.6;
  const isAssessment = params.evidence.source !== "TUTOR";

  const record = await client.mastery.upsert({
    where: { projectId_conceptId: { projectId: params.projectId, conceptId: params.conceptId } },
    create: {
      projectId: params.projectId,
      userId: params.userId,
      conceptId: params.conceptId,
      level,
      previousLevel: currentLevel,
      confidence,
      evidenceCount: 1,
      correctCount: correct && isAssessment ? 1 : 0,
      attemptCount: isAssessment ? 1 : 0,
      trend: "NEW",
      lastEventAt: new Date(),
    },
    update: {
      level,
      previousLevel: currentLevel,
      confidence,
      evidenceCount: { increment: 1 },
      correctCount: { increment: correct && isAssessment ? 1 : 0 },
      attemptCount: { increment: isAssessment ? 1 : 0 },
      lastEventAt: new Date(),
    },
  });

  await client.masterySnapshot.create({
    data: {
      projectId: params.projectId,
      conceptId: params.conceptId,
      level,
      confidence,
      source: params.evidence.source === "TUTOR" ? "TUTOR" : "QUIZ",
    },
  });

  return {
    conceptId: params.conceptId,
    previousLevel: currentLevel,
    level,
    confidence,
    delta: level - currentLevel,
    trend: record.trend,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Trend thresholds, in absolute mastery points. */
const IMPROVING_DELTA = 0.05;
const DECLINING_DELTA = -0.05;
const ATTENTION_LEVEL = 0.5;

/**
 * Recomputes trend for every concept in a project by comparing the current
 * level against the oldest snapshot inside the comparison window.
 *
 * Trend is derived from history rather than from the single previous value so
 * it describes a direction of travel, not the last answer.
 */
export async function recalculateTrends(
  projectId: string,
  options: { windowDays?: number } = {},
): Promise<{ updated: number }> {
  const windowDays = options.windowDays ?? 14;
  const since = new Date(Date.now() - windowDays * 24 * 3600_000);

  const masteries = await db.mastery.findMany({ where: { projectId } });
  let updated = 0;

  for (const mastery of masteries) {
    const baseline = await db.masterySnapshot.findFirst({
      where: { projectId, conceptId: mastery.conceptId, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { level: true },
    });

    // With no history in the window, the current value is the only evidence.
    const from = baseline?.level ?? mastery.previousLevel;
    const delta = mastery.level - from;

    let trend: string;
    if (mastery.evidenceCount < 2) trend = "NEW";
    else if (mastery.level < ATTENTION_LEVEL && delta <= IMPROVING_DELTA) trend = "NEEDS_ATTENTION";
    else if (delta >= IMPROVING_DELTA) trend = "IMPROVING";
    else if (delta <= DECLINING_DELTA) trend = "NEEDS_ATTENTION";
    else trend = "STABLE";

    if (trend !== mastery.trend || Math.abs(from - mastery.previousLevel) > 1e-6) {
      await db.mastery.update({
        where: { id: mastery.id },
        data: { trend, previousLevel: from },
      });
      updated += 1;
    }
  }

  // Keep the project-level rollup in step so dashboards need no aggregate.
  const average =
    masteries.length > 0
      ? masteries.reduce((sum, m) => sum + m.level, 0) / masteries.length
      : 0;
  await db.project
    .update({
      where: { id: projectId },
      data: { masteryAvg: average, conceptCount: masteries.length },
    })
    .catch((error) => logger.warn("project_rollup_failed", { projectId, error }));

  return { updated };
}

export interface ConceptMasteryView {
  conceptId: string;
  name: string;
  slug: string;
  description: string;
  level: number;
  previousLevel: number;
  confidence: number;
  trend: string;
  evidenceCount: number;
  attemptCount: number;
  correctCount: number;
  accuracy: number;
  importance: number;
}

/** Every concept in a project with its current mastery, strongest first. */
export async function getProjectMastery(projectId: string): Promise<ConceptMasteryView[]> {
  const concepts = await db.concept.findMany({
    where: { projectId },
    include: { mastery: true },
    orderBy: { importance: "desc" },
  });

  return concepts.map((concept) => {
    const mastery = concept.mastery[0];
    return {
      conceptId: concept.id,
      name: concept.name,
      slug: concept.slug,
      description: concept.description,
      level: mastery?.level ?? 0,
      previousLevel: mastery?.previousLevel ?? 0,
      confidence: mastery?.confidence ?? 0,
      trend: mastery?.trend ?? "NEW",
      evidenceCount: mastery?.evidenceCount ?? 0,
      attemptCount: mastery?.attemptCount ?? 0,
      correctCount: mastery?.correctCount ?? 0,
      accuracy: mastery && mastery.attemptCount > 0 ? mastery.correctCount / mastery.attemptCount : 0,
      importance: concept.importance,
    };
  });
}

/** Concepts most in need of work: low mastery, weighted by how central they are. */
export async function getWeakConcepts(projectId: string, limit = 5) {
  const all = await getProjectMastery(projectId);
  return all
    .filter((c) => c.evidenceCount > 0 || c.importance > 0.4)
    .map((c) => ({
      ...c,
      // Unmeasured-but-important concepts should surface too, so a concept with
      // no evidence is treated as a moderate gap rather than skipped.
      priority: (1 - c.level) * (0.5 + c.importance) * (c.evidenceCount === 0 ? 0.8 : 1),
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}
