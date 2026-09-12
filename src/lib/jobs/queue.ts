import { createHash, randomUUID } from "node:crypto";
import { db } from "../db";
import { logger } from "../logger";
import { stableStringify } from "../json";

/**
 * Durable, database-backed job queue (PRD §14, §50).
 *
 * Why the database rather than Redis/BullMQ or a hosted queue: the prototype
 * already requires a transactional database, and putting the queue in it buys
 * exactly-once *enqueue* semantics for free — a job can be inserted in the same
 * transaction as the state change that justifies it, so there is no window
 * where the row exists but the job was lost (or vice versa). It also means one
 * fewer service to run, and the admin dashboard can query job health with a
 * plain SQL aggregate. The trade-off (polling latency, single-writer contention
 * under SQLite) is documented in docs/DECISIONS.md.
 *
 * Guarantees:
 *   - at-most-once enqueue per `dedupeKey`
 *   - at-least-once execution, with leases so a crashed worker's jobs are
 *     recovered rather than stranded in RUNNING
 *   - bounded retries with exponential backoff, then a terminal DEAD state
 */

export type JobType =
  | "material.process"
  | "material.extract_concepts"
  | "material.summarise"
  | "event.dispatch"
  | "mastery.recalculate"
  | "recommendation.generate"
  | "context.distil"
  | "analytics.rollup"
  | "quiz.finalise"
  | "insight.generate";

export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "DEAD"
  | "CANCELLED";

export interface EnqueueOptions {
  type: JobType;
  payload: Record<string, unknown>;
  /**
   * Idempotency key. A second enqueue with the same key while an earlier job
   * is still pending or running is a no-op — this is what stops a retried HTTP
   * request or a duplicated domain event from processing a document twice.
   */
  dedupeKey?: string;
  priority?: number;
  delayMs?: number;
  maxAttempts?: number;
  userId?: string;
  projectId?: string;
}

/** Deterministic dedupe key from a type plus its identifying arguments. */
export function dedupeKeyFor(type: string, args: Record<string, unknown>): string {
  const hash = createHash("sha1").update(stableStringify(args)).digest("hex").slice(0, 24);
  return `${type}:${hash}`;
}

export async function enqueue(options: EnqueueOptions): Promise<string | null> {
  const runAt = new Date(Date.now() + (options.delayMs ?? 0));
  const data = {
    type: options.type,
    payload: JSON.stringify(options.payload),
    priority: options.priority ?? 5,
    maxAttempts: options.maxAttempts ?? 3,
    runAt,
    dedupeKey: options.dedupeKey ?? null,
    userId: options.userId ?? null,
    projectId: options.projectId ?? null,
  };

  if (!options.dedupeKey) {
    const job = await db.job.create({ data });
    logger.debug("job_enqueued", { jobId: job.id, type: options.type });
    return job.id;
  }

  // Dedupe semantics: a key is "held" only while the job is not yet in a
  // terminal state. Once it has succeeded or died, the same logical work can be
  // requested again (e.g. re-running analytics tomorrow).
  const existing = await db.job.findUnique({ where: { dedupeKey: options.dedupeKey } });
  if (existing) {
    if (existing.status === "QUEUED" || existing.status === "RUNNING") {
      logger.debug("job_deduped", { jobId: existing.id, type: options.type });
      return null;
    }
    const job = await db.job.update({
      where: { id: existing.id },
      data: {
        ...data,
        status: "QUEUED",
        attempts: 0,
        progress: 0,
        stage: "",
        lastError: null,
        startedAt: null,
        finishedAt: null,
        lockedBy: null,
        lockedAt: null,
      },
    });
    return job.id;
  }

  try {
    const job = await db.job.create({ data });
    return job.id;
  } catch (error) {
    // Lost a race against a concurrent enqueue with the same key — that is the
    // dedupe working, not a failure.
    if (isUniqueViolation(error)) {
      logger.debug("job_dedupe_race", { type: options.type });
      return null;
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "P2002"
  );
}

export interface LeasedJob {
  id: string;
  type: string;
  payload: string;
  attempts: number;
  maxAttempts: number;
  userId: string | null;
  projectId: string | null;
}

/** How long a worker may hold a job before it is considered crashed. */
export const LEASE_MS = 5 * 60_000;

/**
 * Atomically claims the next runnable job.
 *
 * The claim is a conditional UPDATE (`status = QUEUED` in the WHERE clause), so
 * two workers racing for the same row produce one winner and one zero-row
 * update — no transaction or row lock needed, and it behaves identically on
 * SQLite and Postgres.
 */
export async function claimNextJob(workerId: string): Promise<LeasedJob | null> {
  const now = new Date();

  const candidates = await db.job.findMany({
    where: { status: "QUEUED", runAt: { lte: now } },
    orderBy: [{ priority: "asc" }, { runAt: "asc" }],
    take: 5,
    select: { id: true },
  });

  for (const candidate of candidates) {
    const claimed = await db.job.updateMany({
      where: { id: candidate.id, status: "QUEUED" },
      data: {
        status: "RUNNING",
        lockedBy: workerId,
        lockedAt: now,
        startedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 1) {
      const job = await db.job.findUnique({
        where: { id: candidate.id },
        select: {
          id: true,
          type: true,
          payload: true,
          attempts: true,
          maxAttempts: true,
          userId: true,
          projectId: true,
        },
      });
      if (job) return job;
    }
  }
  return null;
}

/** Returns expired leases to the queue so a crashed worker loses no work. */
export async function recoverStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - LEASE_MS);
  const stuck = await db.job.findMany({
    where: { status: "RUNNING", lockedAt: { lt: cutoff } },
    select: { id: true, attempts: true, maxAttempts: true, type: true },
  });

  let recovered = 0;
  for (const job of stuck) {
    const exhausted = job.attempts >= job.maxAttempts;
    await db.job.update({
      where: { id: job.id },
      data: exhausted
        ? {
            status: "DEAD",
            finishedAt: new Date(),
            lastError: "Lease expired; worker presumed crashed and retries exhausted.",
          }
        : {
            status: "QUEUED",
            lockedBy: null,
            lockedAt: null,
            runAt: new Date(Date.now() + backoffMs(job.attempts)),
            lastError: "Lease expired; requeued after presumed worker crash.",
          },
    });
    recovered += 1;
    logger.warn("job_lease_recovered", { jobId: job.id, type: job.type, exhausted });
  }
  return recovered;
}

export function backoffMs(attempt: number): number {
  return Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

export async function markSucceeded(jobId: string, startedAt: number) {
  await db.job.update({
    where: { id: jobId },
    data: {
      status: "SUCCEEDED",
      progress: 100,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt,
      lockedBy: null,
      lockedAt: null,
      lastError: null,
    },
  });
}

export async function markFailed(
  job: LeasedJob,
  error: string,
  options: { retryable: boolean; startedAt: number },
) {
  const canRetry = options.retryable && job.attempts < job.maxAttempts;
  await db.job.update({
    where: { id: job.id },
    data: canRetry
      ? {
          status: "QUEUED",
          runAt: new Date(Date.now() + backoffMs(job.attempts)),
          lockedBy: null,
          lockedAt: null,
          lastError: error.slice(0, 1000),
          durationMs: Date.now() - options.startedAt,
        }
      : {
          // FAILED = gave up because the error is not worth retrying.
          // DEAD    = gave up because retries ran out.
          status: options.retryable ? "DEAD" : "FAILED",
          finishedAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          lastError: error.slice(0, 1000),
          durationMs: Date.now() - options.startedAt,
        },
  });
}

export async function reportProgress(jobId: string, progress: number, stage: string) {
  await db.job
    .update({
      where: { id: jobId },
      data: {
        progress: Math.max(0, Math.min(100, Math.round(progress))),
        stage,
        // Renew the lease: a long but healthy job must not look crashed.
        lockedAt: new Date(),
      },
    })
    .catch(() => {});
}

export function newWorkerId(): string {
  return `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** Queue health snapshot for the admin System Health page. */
export async function queueStats() {
  const rows = await db.job.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = {
    QUEUED: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    FAILED: 0,
    DEAD: 0,
    CANCELLED: 0,
  };
  for (const row of rows) counts[row.status] = row._count._all;

  const oldestQueued = await db.job.findFirst({
    where: { status: "QUEUED" },
    orderBy: { runAt: "asc" },
    select: { runAt: true },
  });

  return {
    counts,
    backlog: counts.QUEUED + counts.RUNNING,
    oldestQueuedAgeMs: oldestQueued ? Date.now() - oldestQueued.runAt.getTime() : 0,
  };
}
