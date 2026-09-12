import { db } from "../db";
import { logger, newTraceId } from "../logger";
import { parseJson } from "../json";
import { AppError } from "../errors";
import { truncate } from "../ai/text";
import { runStructuredPrompt } from "../ai/run";
import { contextDistillationPrompt } from "../ai/prompts";
import { processMaterial, markMaterialFailed } from "../materials/processing";
import { recalculateTrends, getWeakConcepts } from "../domain/mastery";
import { generateRecommendation } from "../domain/recommendations";
import { rollupDailyStats } from "../domain/analytics";
import { upsertContextItem, decayContext } from "../domain/learning-context";
import { maybeSummariseConversation } from "../domain/tutor";
import { dispatchPendingEvents } from "../events/dispatcher";
import { enqueue, dedupeKeyFor, reportProgress, type JobType } from "./queue";

/**
 * Job handlers.
 *
 * Each handler is written to be safely re-runnable: it recomputes from source
 * and upserts, rather than incrementing or appending. That is what makes
 * at-least-once delivery acceptable (PRD §50).
 *
 * A handler returns normally on success, or throws. It signals whether the
 * failure is worth retrying by throwing a `PermanentJobError` when it is not —
 * a corrupt PDF will still be corrupt on the third attempt, and burning
 * retries on it only delays the user's error message.
 */

export class PermanentJobError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface JobContext {
  jobId: string;
  attempts: number;
  traceId: string;
  progress: (percent: number, stage: string) => Promise<void>;
}

type Handler = (payload: Record<string, unknown>, context: JobContext) => Promise<void>;

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new PermanentJobError(`Job payload is missing required field "${key}".`);
  }
  return value;
}

export const handlers: Record<JobType, Handler> = {
  // -------------------------------------------------------------------------
  "material.process": async (payload, context) => {
    const materialId = requireString(payload, "materialId");
    try {
      const result = await processMaterial(materialId, {
        traceId: context.traceId,
        onProgress: context.progress,
      });
      logger.info("material_processed", { ...result });
    } catch (error) {
      // A malformed document is permanent; an AI/network blip is not.
      const permanent =
        error instanceof AppError &&
        (error.code === "BAD_REQUEST" || error.code === "NOT_FOUND");
      if (permanent || context.attempts >= 3) {
        await markMaterialFailed(materialId, error);
        if (permanent) throw new PermanentJobError("Document could not be parsed.", error);
      }
      throw error;
    }
  },

  // These two are folded into material.process, but kept as separate job types
  // so a single stage can be re-run in isolation from the admin surface.
  "material.extract_concepts": async (payload, context) => {
    const materialId = requireString(payload, "materialId");
    await processMaterial(materialId, { traceId: context.traceId, onProgress: context.progress });
  },

  "material.summarise": async (payload, context) => {
    const materialId = requireString(payload, "materialId");
    await processMaterial(materialId, { traceId: context.traceId, onProgress: context.progress });
  },

  // -------------------------------------------------------------------------
  "event.dispatch": async (_payload, context) => {
    const processed = await dispatchPendingEvents(context.traceId);
    if (processed > 0) logger.info("events_dispatched", { processed });
  },

  // -------------------------------------------------------------------------
  "mastery.recalculate": async (payload) => {
    const projectId = requireString(payload, "projectId");
    const result = await recalculateTrends(projectId);
    logger.debug("mastery_trends_recalculated", { projectId, ...result });
  },

  // -------------------------------------------------------------------------
  "recommendation.generate": async (payload, context) => {
    const projectId = requireString(payload, "projectId");
    const userId = requireString(payload, "userId");
    const id = await generateRecommendation({ projectId, userId, traceId: context.traceId });
    logger.debug("recommendation_generated", { projectId, recommendationId: id });
  },

  // -------------------------------------------------------------------------
  "context.distil": async (payload, context) => {
    const conversationId = requireString(payload, "conversationId");
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      include: { project: { select: { name: true } } },
    });
    if (!conversation) throw new PermanentJobError("Conversation no longer exists.");

    // Only the turns added since the last distillation.
    const messages = await db.message.findMany({
      where: { conversationId, status: "COMPLETE" },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { role: true, content: true },
    });
    if (messages.length < 2) return;

    const transcript = messages
      .reverse()
      .map((m) => `${m.role === "user" ? "Learner" : "Tutor"}: ${truncate(m.content, 600)}`)
      .join("\n\n");

    const existing = await db.learningContextItem.findMany({
      where: { userId: conversation.userId, projectId: conversation.projectId, retiredAt: null },
      select: { content: true },
      take: 20,
    });

    const result = await runStructuredPrompt(
      contextDistillationPrompt,
      {
        transcript,
        projectName: conversation.project.name,
        existing: existing.map((e) => e.content),
      },
      {
        traceId: context.traceId,
        userId: conversation.userId,
        projectId: conversation.projectId,
      },
    );

    for (const item of result.value.items) {
      await upsertContextItem({
        userId: conversation.userId,
        // Goals and preferences are about the person, so they are stored
        // globally; everything else stays scoped to this project.
        projectId: item.kind === "GOAL" || item.kind === "PREFERENCE" ? null : conversation.projectId,
        kind: item.kind,
        content: item.content,
        source: "TUTOR",
        salience: item.salience,
      });
    }

    await maybeSummariseConversation(conversationId, context.traceId);
    logger.debug("context_distilled", { conversationId, items: result.value.items.length });
  },

  // -------------------------------------------------------------------------
  "analytics.rollup": async (payload) => {
    const projectId = payload.projectId;
    if (typeof projectId === "string") {
      await rollupDailyStats(projectId);
      return;
    }
    // No project specified: refresh every project touched recently.
    const since = new Date(Date.now() - 2 * 86_400_000);
    const projects = await db.project.findMany({
      where: { archivedAt: null, OR: [{ updatedAt: { gte: since } }, { lastAccessedAt: { gte: since } }] },
      select: { id: true, userId: true },
      take: 200,
    });
    for (const project of projects) {
      await rollupDailyStats(project.id).catch((error) =>
        logger.warn("rollup_failed", { projectId: project.id, error }),
      );
    }
    const users = [...new Set(projects.map((p) => p.userId))];
    for (const userId of users) {
      await decayContext(userId).catch(() => {});
    }
    logger.info("analytics_rollup_complete", { projects: projects.length });
  },

  // -------------------------------------------------------------------------
  "quiz.finalise": async (payload, context) => {
    const quizId = requireString(payload, "quizId");
    const quiz = await db.quiz.findUnique({
      where: { id: quizId },
      include: { answers: true },
    });
    if (!quiz) throw new PermanentJobError("Quiz no longer exists.");

    // Recompute from the answers rather than trusting incremented counters.
    const answered = quiz.answers.length;
    const correct = quiz.answers.filter((a) => a.isCorrect).length;
    const score = answered > 0 ? quiz.answers.reduce((s, a) => s + a.score, 0) / answered : 0;

    await db.quiz.update({
      where: { id: quizId },
      data: {
        answeredCount: answered,
        correctCount: correct,
        score,
        status: "COMPLETED",
        completedAt: quiz.completedAt ?? new Date(),
      },
    });

    await recalculateTrends(quiz.projectId);
    await rollupDailyStats(quiz.projectId, 1);

    await enqueue({
      type: "recommendation.generate",
      payload: { projectId: quiz.projectId, userId: quiz.userId },
      dedupeKey: dedupeKeyFor("recommendation.generate", { quizId }),
      userId: quiz.userId,
      projectId: quiz.projectId,
      priority: 3,
    });

    await enqueue({
      type: "insight.generate",
      payload: { projectId: quiz.projectId, userId: quiz.userId },
      dedupeKey: dedupeKeyFor("insight.generate", { quizId }),
      userId: quiz.userId,
      projectId: quiz.projectId,
      priority: 6,
    });

    logger.info("quiz_finalised", { quizId, answered, correct, score });
  },

  // -------------------------------------------------------------------------
  /**
   * Background learning insight (PRD §33): detect repeated mistakes on the same
   * concept and write that pattern into the learner's durable context, so the
   * tutor knows about it in the next conversation without being told again.
   */
  "insight.generate": async (payload) => {
    const projectId = requireString(payload, "projectId");
    const userId = requireString(payload, "userId");

    const weak = await getWeakConcepts(projectId, 3);
    for (const concept of weak) {
      if (concept.attemptCount < 2) continue;

      const wrong = await db.quizAnswer.count({
        where: {
          userId,
          isCorrect: false,
          question: { conceptId: concept.conceptId },
        },
      });
      if (wrong < 2) continue;

      await upsertContextItem({
        userId,
        projectId,
        kind: "WEAKNESS",
        content:
          `Has answered ${wrong} assessment questions on "${concept.name}" incorrectly; ` +
          `current mastery is ${Math.round(concept.level * 100)}%. Explain this concept ` +
          `carefully and check understanding before moving on.`,
        source: "WORKFLOW",
        salience: Math.min(0.95, 0.6 + wrong * 0.08),
        dedupeKey: `WEAKNESS:concept:${concept.conceptId}`,
      });

      logger.info("repeated_mistake_pattern_recorded", {
        projectId,
        conceptId: concept.conceptId,
        occurrences: wrong,
      });
    }
  },
};

/** Convenience wrapper used by request handlers to kick off background work. */
export async function scheduleAfterUpload(materialId: string, userId: string, projectId: string) {
  return enqueue({
    type: "material.process",
    payload: { materialId },
    // One processing job per material, ever, unless it reaches a terminal state.
    dedupeKey: dedupeKeyFor("material.process", { materialId }),
    userId,
    projectId,
    priority: 2,
    maxAttempts: 3,
  });
}

export function newJobTraceId(): string {
  return newTraceId();
}

export { parseJson, reportProgress };
