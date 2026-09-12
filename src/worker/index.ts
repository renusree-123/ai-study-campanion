/**
 * Standalone background worker.
 *
 * Run with `npm run worker` when web and background capacity are deployed
 * separately (set WORKER_IN_PROCESS=false on the web process so the queue is
 * not drained twice).
 */
import "../lib/load-env";
import { Worker } from "../lib/jobs/worker";
import { logger } from "../lib/logger";
import { db } from "../lib/db";

const worker = new Worker();
worker.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("worker_shutdown_requested", { signal });
  await worker.stop();
  await db.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("worker_unhandled_rejection", { error: reason });
});
