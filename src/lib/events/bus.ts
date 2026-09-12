import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { logger } from "../logger";
import { stableStringify } from "../json";
import type { DomainEventPayloads, DomainEventType } from "./types";

/**
 * Transactional outbox.
 *
 * `publish` writes a DomainEvent row; it can be handed a transaction client so
 * the event is committed atomically with the state change that caused it.
 * Nothing is delivered inline — the `event.dispatch` job drains PENDING rows.
 * That keeps interactive requests fast (PRD §33) and makes delivery survive a
 * process restart.
 *
 * Every event carries a `dedupeKey` derived from its identifying arguments, so
 * a retried producer publishes the same logical event once.
 */
export async function publish<T extends DomainEventType>(
  type: T,
  payload: DomainEventPayloads[T],
  context: { userId?: string; projectId?: string; dedupeSuffix?: string },
  client: Prisma.TransactionClient | typeof db = db,
): Promise<void> {
  const dedupeKey = eventDedupeKey(type, payload, context.dedupeSuffix);

  // Check first, then insert. The unique index is the real guarantee — this
  // just keeps the common duplicate (a workflow re-deriving the same state)
  // off the database error log, where it would look like a fault.
  const existing = await client.domainEvent.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });
  if (existing) {
    logger.debug("event_duplicate_ignored", { type, dedupeKey });
    return;
  }

  try {
    await client.domainEvent.create({
      data: {
        type,
        payload: JSON.stringify(payload),
        userId: context.userId ?? null,
        projectId: context.projectId ?? null,
        dedupeKey,
      },
    });
    logger.debug("event_published", { type, dedupeKey });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      // Already published — this is the deduplication guard doing its job.
      logger.debug("event_duplicate_ignored", { type, dedupeKey });
      return;
    }
    // An observability/workflow write must not fail the user's action.
    logger.error("event_publish_failed", { type, error });
  }
}

export function eventDedupeKey(
  type: string,
  payload: Record<string, unknown>,
  suffix?: string,
): string {
  const hash = createHash("sha1")
    .update(`${type}|${stableStringify(payload)}|${suffix ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  return `${type}:${hash}`;
}
