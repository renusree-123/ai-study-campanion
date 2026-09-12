import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/auth/session";
import { runEvaluation } from "@/lib/eval/runner";
import { SUITES } from "@/lib/eval/dataset";
import { logger } from "@/lib/logger";

const schema = z.object({
  suite: z.enum(SUITES).default("all"),
  label: z.string().max(120).default(""),
});

export const GET = handler(async () => {
  await requireAdmin();
  const runs = await db.evalRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
    include: { _count: { select: { results: true } } },
  });
  return ok(runs);
});

/**
 * Triggers an evaluation run.
 *
 * Runs inline rather than as a background job: an operator clicking "run
 * evaluation" wants the result, and the suite completes in well under a
 * request timeout. A larger suite would move to the job queue.
 */
export const POST = handler(async (request: Request) => {
  const admin = await requireAdmin();
  const body = await parseBody(request, schema);

  logger.info("evaluation_started", { suite: body.suite, by: admin.id });
  const { run, diff } = await runEvaluation({ suite: body.suite, label: body.label });

  return ok({
    runId: run.id,
    suite: run.suite,
    passed: run.passedCases,
    total: run.totalCases,
    avgScore: run.avgScore,
    durationMs: run.durationMs,
    diff,
  });
});
