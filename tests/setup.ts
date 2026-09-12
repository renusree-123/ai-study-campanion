/**
 * Test bootstrap.
 *
 * Each run gets its own SQLite file so tests never touch the development
 * database, and the schema is pushed fresh so a schema change cannot leave a
 * stale test database behind.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const TEST_DIR = path.resolve(process.cwd(), ".test-tmp");
const DB_FILE = path.join(TEST_DIR, "test.db");

if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  const file = `${DB_FILE}${suffix}`;
  if (existsSync(file)) rmSync(file);
}

// `NODE_ENV` is typed read-only on ProcessEnv, so the whole block is assigned
// through one widened reference rather than casting at each line.
const env = process.env as Record<string, string>;

env.NODE_ENV = "test";
env.DATABASE_URL = `file:${DB_FILE}`;
env.AUTH_SECRET = "test-secret-value-that-is-long-enough";
env.STORAGE_DIR = path.join(TEST_DIR, "storage");
// Tests must never call a real model, and must never spawn a background worker
// that races with their assertions.
env.AI_PROVIDER = "offline";
env.ANTHROPIC_API_KEY = "";
env.WORKER_IN_PROCESS = "false";
env.LOG_LEVEL = "error";

execSync("npx prisma db push --skip-generate --accept-data-loss", {
  stdio: "pipe",
  env: process.env,
});
