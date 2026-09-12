import { db } from "@/lib/db";
import { handler, ok } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertMaterialAccess } from "@/lib/auth/ownership";
import { storage } from "@/lib/storage";
import { recordActivity } from "@/lib/activity";

type Params = { params: Promise<{ materialId: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { materialId } = await params;
  const material = await assertMaterialAccess(user.id, materialId);
  return ok({
    id: material.id,
    filename: material.filename,
    status: material.status,
    stage: material.stage,
    progress: material.progress,
    pageCount: material.pageCount,
    chunkCount: material.chunkCount,
    summary: material.summary,
    error: material.error,
    usedOcr: material.usedOcr,
    processedAt: material.processedAt,
  });
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { materialId } = await params;
  const material = await assertMaterialAccess(user.id, materialId);

  // Chunks cascade with the row; the stored object has to go explicitly.
  await db.material.delete({ where: { id: materialId } });
  await storage().delete(material.storageKey);

  await db.project.update({
    where: { id: material.projectId },
    data: {
      materialCount: await db.material.count({
        where: { projectId: material.projectId, status: "READY" },
      }),
    },
  });

  await recordActivity({
    userId: user.id,
    projectId: material.projectId,
    type: "MATERIAL_DELETED",
    summary: `Removed ${material.filename}`,
  });

  return ok({ deleted: true });
});
