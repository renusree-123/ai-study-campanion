/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * Starts the in-process background worker so `npm run dev` and a single-process
 * deployment are the complete system, with no second command to remember. Set
 * WORKER_IN_PROCESS=false and run `npm run worker` to separate them.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertProductionSecrets } = await import("./lib/env");
  // Fail fast at boot rather than on a user's first sign-in.
  assertProductionSecrets();

  const { startInProcessWorker } = await import("./lib/jobs/worker");
  const { logger } = await import("./lib/logger");
  const { ai } = await import("./lib/ai/router");

  const worker = startInProcessWorker();
  logger.info("app_started", {
    worker: worker ? worker.workerId : "disabled (WORKER_IN_PROCESS=false)",
    ai: ai.describe(),
  });
}
