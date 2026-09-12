import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { created, handler, ok } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { materialKey, storage } from "@/lib/storage";
import { looksLikePdf } from "@/lib/materials/pdf";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";
import { scheduleAfterUpload } from "@/lib/jobs/handlers";
import { logger } from "@/lib/logger";

type Params = { params: Promise<{ projectId: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const materials = await db.material.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      filename: true,
      status: true,
      stage: true,
      progress: true,
      pageCount: true,
      chunkCount: true,
      sizeBytes: true,
      summary: true,
      error: true,
      usedOcr: true,
      createdAt: true,
      processedAt: true,
    },
  });
  return ok(materials);
});

export const POST = handler(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  const project = await assertProjectAccess(user.id, projectId);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    throw new AppError("BAD_REQUEST", "Attach a PDF file under the `file` field.");
  }

  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `File is ${(file.size / 1024 / 1024).toFixed(1)}MB; the limit is ${env().MAX_UPLOAD_MB}MB.`,
    );
  }
  if (file.size === 0) {
    throw new AppError("BAD_REQUEST", "That file is empty.");
  }

  const data = Buffer.from(await file.arrayBuffer());

  // Validate by magic bytes, not by the client-supplied name or MIME type.
  if (!looksLikePdf(data)) {
    throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Only PDF files are supported at the moment.", {
      userMessage:
        "Only PDF files are supported right now. Convert the document to PDF and try again.",
    });
  }

  const { key, checksum } = materialKey(user.id, projectId, file.name, data);

  // Re-uploading the same bytes to the same project is a no-op rather than a
  // duplicate: the storage key is content-addressed (PRD §50).
  const duplicate = await db.material.findFirst({
    where: { projectId, checksum, status: { not: "FAILED" } },
  });
  if (duplicate) {
    return ok({ ...duplicate, deduplicated: true });
  }

  await storage().put(key, data);

  const material = await db.material.create({
    data: {
      projectId,
      userId: user.id,
      filename: file.name.slice(0, 200),
      mimeType: "application/pdf",
      sizeBytes: data.length,
      storageKey: key,
      checksum,
      status: "QUEUED",
      stage: "QUEUED",
    },
  });

  await recordActivity({
    userId: user.id,
    projectId,
    spaceId: project.spaceId,
    type: "MATERIAL_UPLOADED",
    summary: `Uploaded ${material.filename}`,
    payload: { materialId: material.id, sizeBytes: data.length },
  });

  await publish(
    "MATERIAL_UPLOADED",
    { materialId: material.id, projectId },
    { userId: user.id, projectId },
  );

  // Processing happens in the background — the response returns immediately and
  // the client polls status (PRD §14).
  await scheduleAfterUpload(material.id, user.id, projectId);

  logger.info("material_uploaded", { materialId: material.id, projectId, bytes: data.length });
  return created(material);
});
