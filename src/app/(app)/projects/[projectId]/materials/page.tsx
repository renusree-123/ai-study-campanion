import { requireUserPage } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { db } from "@/lib/db";
import { MaterialsPanel } from "@/components/materials";

export default async function MaterialsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const user = await requireUserPage();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const materials = await db.material.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <MaterialsPanel
      projectId={projectId}
      initial={materials.map((material) => ({
        id: material.id,
        filename: material.filename,
        status: material.status,
        stage: material.stage,
        progress: material.progress,
        pageCount: material.pageCount,
        chunkCount: material.chunkCount,
        sizeBytes: material.sizeBytes,
        summary: material.summary,
        error: material.error,
        usedOcr: material.usedOcr,
        createdAt: material.createdAt.toISOString(),
        processedAt: material.processedAt?.toISOString() ?? null,
      }))}
    />
  );
}
