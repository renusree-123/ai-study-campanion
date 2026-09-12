import { db } from "../db";
import { logger } from "../logger";
import { parseJson } from "../json";
import { errorMessage } from "../errors";
import { dedupeKeyFor, enqueue } from "../jobs/queue";
import type { DomainEventType } from "./types";

/**
 * Event dispatcher (PRD §38).
 *
 * Drains PENDING DomainEvent rows and fans each one out to the workflows that
 * react to it. Reactions are enqueued as jobs rather than executed inline, so a
 * slow workflow cannot stall the dispatcher and each reaction gets its own
 * retry budget.
 *
 * Delivery is at-least-once. Duplicate protection lives in two places: the
 * event's own unique `dedupeKey` (a producer cannot publish the same logical
 * event twice) and each downstream job's `dedupeKey` (a redelivered event
 * cannot enqueue the same work twice).
 */

const MAX_EVENT_ATTEMPTS = 5;
const BATCH_SIZE = 25;

type Reaction = (payload: Record<string, unknown>, event: EventRow) => Promise<void>;

interface EventRow {
  id: string;
  type: string;
  userId: string | null;
  projectId: string | null;
}

/**
 * The reaction table. This is the product's "when X happens, do Y" wiring, in
 * one readable place — adding a workflow is a new entry here, not a change to
 * whatever code published the event.
 */
const reactions: Partial<Record<DomainEventType, Reaction[]>> = {
  MATERIAL_PROCESSED: [
    async (payload, event) => {
      // New knowledge changes what the learner should do next.
      await enqueue({
        type: "recommendation.generate",
        payload: { projectId: payload.projectId, userId: event.userId },
        dedupeKey: dedupeKeyFor("recommendation.generate", {
          materialId: payload.materialId,
        }),
        userId: event.userId ?? undefined,
        projectId: event.projectId ?? undefined,
        priority: 4,
      });
    },
    async (payload) => {
      await enqueue({
        type: "analytics.rollup",
        payload: { projectId: payload.projectId },
        dedupeKey: dedupeKeyFor("analytics.rollup", {
          projectId: payload.projectId,
          day: new Date().toISOString().slice(0, 10),
        }),
        projectId: String(payload.projectId),
        priority: 7,
      });
    },
  ],

  QUIZ_COMPLETED: [
    async (payload, event) => {
      // Evaluate -> update mastery -> generate insight -> recommend.
      await enqueue({
        type: "quiz.finalise",
        payload: { quizId: payload.quizId },
        dedupeKey: dedupeKeyFor("quiz.finalise", { quizId: payload.quizId }),
        userId: event.userId ?? undefined,
        projectId: event.projectId ?? undefined,
        priority: 2,
      });
    },
  ],

  QUESTION_ANSWERED: [
    async (payload) => {
      await enqueue({
        type: "mastery.recalculate",
        payload: { projectId: payload.projectId },
        dedupeKey: dedupeKeyFor("mastery.recalculate", {
          projectId: payload.projectId,
          // Coalesce a burst of answers into one recalculation per minute.
          minute: Math.floor(Date.now() / 60_000),
        }),
        projectId: String(payload.projectId),
        priority: 5,
      });
    },
  ],

  TUTOR_INTERACTION_COMPLETED: [
    async (payload, event) => {
      await enqueue({
        type: "context.distil",
        payload: { conversationId: payload.conversationId },
        dedupeKey: dedupeKeyFor("context.distil", {
          conversationId: payload.conversationId,
          messageId: payload.messageId,
        }),
        userId: event.userId ?? undefined,
        projectId: event.projectId ?? undefined,
        priority: 6,
      });
    },
    async (payload) => {
      await enqueue({
        type: "analytics.rollup",
        payload: { projectId: payload.projectId },
        dedupeKey: dedupeKeyFor("analytics.rollup", {
          projectId: payload.projectId,
          day: new Date().toISOString().slice(0, 10),
        }),
        projectId: String(payload.projectId),
        priority: 8,
      });
    },
  ],

  PROJECT_CREATED: [
    async (payload, event) => {
      // Give a brand-new project a first "what to do next" immediately.
      await enqueue({
        type: "recommendation.generate",
        payload: { projectId: payload.projectId, userId: event.userId },
        dedupeKey: dedupeKeyFor("recommendation.generate", {
          projectId: payload.projectId,
          reason: "created",
        }),
        userId: event.userId ?? undefined,
        projectId: event.projectId ?? undefined,
        priority: 4,
      });
    },
  ],

  MATERIAL_FAILED: [
    async (payload) => {
      logger.warn("material_failed_event", {
        materialId: payload.materialId,
        reason: payload.reason,
      });
    },
  ],
};

export async function dispatchPendingEvents(traceId: string): Promise<number> {
  const pending = await db.domainEvent.findMany({
    where: { status: "PENDING", attempts: { lt: MAX_EVENT_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  let processed = 0;

  for (const event of pending) {
    // Claim the row so a second dispatcher pass cannot pick it up.
    const claimed = await db.domainEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    const payload = parseJson<Record<string, unknown>>(event.payload, {});
    const handlers = reactions[event.type as DomainEventType] ?? [];

    try {
      // Reactions run in sequence; one failing marks the whole event for retry.
      // Because every reaction is itself deduped, a redelivery re-runs the
      // successful ones harmlessly.
      for (const reaction of handlers) {
        await reaction(payload, {
          id: event.id,
          type: event.type,
          userId: event.userId,
          projectId: event.projectId,
        });
      }
      await db.domainEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
      });
      processed += 1;
    } catch (error) {
      const message = errorMessage(error);
      const exhausted = event.attempts + 1 >= MAX_EVENT_ATTEMPTS;
      await db.domainEvent.update({
        where: { id: event.id },
        data: {
          status: exhausted ? "FAILED" : "PENDING",
          lastError: message.slice(0, 500),
        },
      });
      logger.error("event_dispatch_failed", {
        traceId,
        eventId: event.id,
        type: event.type,
        exhausted,
        error,
      });
    }
  }

  return processed;
}

/** Event pipeline health for the admin dashboard. */
export async function eventStats() {
  const rows = await db.domainEvent.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = { PENDING: 0, PROCESSING: 0, PROCESSED: 0, FAILED: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}
