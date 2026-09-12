import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { handler, ok } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertMaterialAccess } from "@/lib/auth/ownership";
import { enqueue, dedupeKeyFor } from "@/lib/jobs/queue";

type Params = { params: Promise<{ materialId: string }> };

/**
 * Re-runs the processing pipeline for one material. Safe to call repeatedly:
 * the pipeline rebuilds chunks rather than appending, and the dedupe key stops
 * two processing jobs existing for the same material at once.
 */
export const POST = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { materialId } = await params;
  const material = await assertMaterialAccess(user.id, materialId);

  if (material.status === "PROCESSING") {
    throw new AppError("CONFLICT", "This material is already being processed.");
  }

  await db.material.update({
    where: { id: materialId },
    data: { status: "QUEUED", stage: "QUEUED", progress: 0, error: null },
  });

  const jobId = await enqueue({
    type: "material.process",
    payload: { materialId },
    dedupeKey: dedupeKeyFor("material.process", { materialId, attempt: Date.now() }),
    userId: user.id,
    projectId: material.projectId,
    priority: 2,
  });

  return ok({ queued: true, jobId });
});
