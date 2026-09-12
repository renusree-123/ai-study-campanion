import { PrismaClient } from "@prisma/client";
import { env } from "./env";

/**
 * Prisma singleton. Next.js dev mode re-evaluates modules on every hot reload,
 * which would otherwise leak a connection pool per reload.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env().LOG_LEVEL === "debug" ? ["warn", "error", "query"] : ["warn", "error"],
  });

if (env().NODE_ENV !== "production") globalForPrisma.prisma = db;

/** Cheap liveness probe used by the admin System Health page. */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
