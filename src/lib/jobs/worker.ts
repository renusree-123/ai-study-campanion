import { env } from "../env";
import { logger, newTraceId } from "../logger";
import { errorMessage, isRetryable } from "../errors";
import { parseJson } from "../json";
import {
  claimNextJob,
  dedupeKeyFor,
  enqueue,
  markFailed,
  markSucceeded,
  newWorkerId,
  recoverStuckJobs,
  reportProgress,
  type JobType,
  type LeasedJob,
} from "./queue";
import { PermanentJobError, handlers } from "./handlers";

/**
 * Worker runtime.
 *
 * Runs either inside the Next.js server process (default, so `npm run dev` is
 * the whole system) or as a standalone process via `npm run worker` for a
 * deployment that separates web and background capacity. Both use this same
 * loop; the only difference is who starts it.
 *
 * The loop is intentionally simple: poll, claim, run, record. Polling costs one
 * indexed query per tick and buys operational simplicity — no broker, no
 * at-least-once delivery semantics to reason about beyond what the database
 * already gives us.
 */

export interface WorkerOptions {
  concurrency?: number;
  pollMs?: number;
  /** Stop after this many jobs. Used by tests to drain deterministically. */
  maxJobs?: number;
}

export class Worker {
  private readonly id = newWorkerId();
  private running = false;
  private inFlight = 0;
  private processed = 0;
  private timer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerOptions = {}) {}

  get workerId() {
    return this.id;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("worker_started", {
      workerId: this.id,
      concurrency: this.options.concurrency ?? env().WORKER_CONCURRENCY,
    });
    this.tick();
    this.scheduleMaintenance();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    // Let in-flight jobs finish so their leases are released cleanly.
    const deadline = Date.now() + 15_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    logger.info("worker_stopped", { workerId: this.id, processed: this.processed });
  }

  /** Drains the queue until empty. Used by tests and the standalone runner. */
  async drain(limit = 200): Promise<number> {
    let count = 0;
    while (count < limit) {
      const job = await claimNextJob(this.id);
      if (!job) break;
      await this.run(job);
      count += 1;
    }
    return count;
  }

  private scheduleMaintenance() {
    const run = async () => {
      try {
        const recovered = await recoverStuckJobs();
        if (recovered > 0) logger.warn("stuck_jobs_recovered", { recovered });

        // Heartbeat jobs: the event dispatcher and the analytics rollup are
        // deduped per minute/day, so re-enqueueing them every tick is a no-op
        // whenever one is already pending.
        await enqueue({
          type: "event.dispatch",
          payload: {},
          dedupeKey: dedupeKeyFor("event.dispatch", { tick: Math.floor(Date.now() / 5_000) }),
          priority: 1,
        });
      } catch (error) {
        logger.error("worker_maintenance_failed", { error });
      }
    };
    void run();
    this.maintenanceTimer = setInterval(run, 5_000);
  }

  private tick(): void {
    if (!this.running) return;
    const concurrency = this.options.concurrency ?? env().WORKER_CONCURRENCY;
    const pollMs = this.options.pollMs ?? env().WORKER_POLL_MS;

    const pump = async () => {
      while (this.running && this.inFlight < concurrency) {
        if (this.options.maxJobs && this.processed >= this.options.maxJobs) {
          this.running = false;
          return;
        }
        const job = await claimNextJob(this.id).catch((error) => {
          logger.error("job_claim_failed", { error });
          return null;
        });
        if (!job) break;
        this.inFlight += 1;
        void this.run(job).finally(() => {
          this.inFlight -= 1;
        });
      }
    };

    void pump().finally(() => {
      if (!this.running) return;
      this.timer = setTimeout(() => this.tick(), pollMs);
    });
  }

  private async run(job: LeasedJob): Promise<void> {
    const startedAt = Date.now();
    const traceId = newTraceId();
    const log = logger.child({ jobId: job.id, jobType: job.type, traceId });

    log.info("job_started", { attempt: job.attempts });

    const handler = handlers[job.type as JobType];
    if (!handler) {
      await markFailed(job, `No handler registered for job type "${job.type}"`, {
        retryable: false,
        startedAt,
      });
      log.error("job_no_handler");
      return;
    }

    try {
      await handler(parseJson<Record<string, unknown>>(job.payload, {}), {
        jobId: job.id,
        attempts: job.attempts,
        traceId,
        progress: (percent, stage) => reportProgress(job.id, percent, stage),
      });
      await markSucceeded(job.id, startedAt);
      this.processed += 1;
      log.info("job_succeeded", { durationMs: Date.now() - startedAt });
    } catch (error) {
      const permanent = error instanceof PermanentJobError;
      const retryable = !permanent && isRetryable(error);
      await markFailed(job, errorMessage(error), { retryable, startedAt });
      this.processed += 1;
      log.error("job_failed", {
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        retryable,
        permanent,
        durationMs: Date.now() - startedAt,
        error,
      });
    }
  }
}

// A single in-process worker per Node process. Next.js dev mode re-evaluates
// modules on hot reload, so the instance is parked on globalThis to stop a
// reload from spawning a second polling loop against the same queue.
const globalForWorker = globalThis as unknown as { ascWorker?: Worker };

export function startInProcessWorker(): Worker | null {
  if (!env().WORKER_IN_PROCESS) return null;
  if (globalForWorker.ascWorker) return globalForWorker.ascWorker;
  const worker = new Worker();
  worker.start();
  globalForWorker.ascWorker = worker;
  return worker;
}

export function getWorker(): Worker | null {
  return globalForWorker.ascWorker ?? null;
}
