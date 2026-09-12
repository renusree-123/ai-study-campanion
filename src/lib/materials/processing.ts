import { db } from "../db";
import { logger } from "../logger";
import { AppError, errorMessage } from "../errors";
import { storage } from "../storage";
import { slugify, truncate } from "../ai/text";
import { runStructuredPrompt } from "../ai/run";
import { conceptExtractionPrompt, materialSummaryPrompt } from "../ai/prompts";
import { ai } from "../ai/router";
import { chunkPages, type PageText } from "../retrieval/chunking";
import { LOW_TEXT_THRESHOLD, extractPdfText } from "./pdf";
import { recordActivity } from "../activity";
import { publish } from "../events/bus";
import { resolveJobOwnership } from "../auth/ownership";

/**
 * Material processing pipeline (PRD §13).
 *
 *   Queued -> Reading Content -> Understanding Structure -> Extracting Knowledge
 *          -> Creating Searchable Representation -> Ready
 *
 * Each stage reports progress to both the Material row (user-facing) and the
 * Job row (operator-facing), so the UI can show where a document is and the
 * admin dashboard can see which stage a failure happened in.
 *
 * The whole pipeline is idempotent: re-running it for a material deletes that
 * material's chunks and rebuilds them, rather than appending duplicates. That
 * makes a retry after a partial failure safe.
 */

export interface ProcessResult {
  materialId: string;
  chunkCount: number;
  pageCount: number;
  conceptCount: number;
  usedOcr: boolean;
}

export const PROCESSING_STAGES = [
  "QUEUED",
  "READING_CONTENT",
  "UNDERSTANDING_STRUCTURE",
  "EXTRACTING_KNOWLEDGE",
  "CREATING_SEARCHABLE_REPRESENTATION",
  "READY",
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export const STAGE_LABELS: Record<string, string> = {
  UPLOADED: "Uploaded",
  QUEUED: "Queued",
  READING_CONTENT: "Reading content",
  UNDERSTANDING_STRUCTURE: "Understanding structure",
  EXTRACTING_KNOWLEDGE: "Extracting knowledge",
  CREATING_SEARCHABLE_REPRESENTATION: "Creating searchable representation",
  READY: "Ready",
  FAILED: "Failed",
};

/** Cap on pages sent to the vision model, to bound cost on a big scan. */
const MAX_VISION_PAGES = 12;

export async function processMaterial(
  materialId: string,
  context: { traceId: string; onProgress?: (progress: number, stage: string) => Promise<void> },
): Promise<ProcessResult> {
  const material = await db.material.findUnique({ where: { id: materialId } });
  if (!material) throw new AppError("NOT_FOUND", `Material ${materialId} no longer exists.`);

  // Re-verify ownership at execution time: the job payload is not trusted.
  const project = await resolveJobOwnership(material.userId, material.projectId);

  const advance = async (stage: ProcessingStage, progress: number) => {
    await db.material.update({
      where: { id: materialId },
      data: { status: stage === "READY" ? "READY" : "PROCESSING", stage, progress },
    });
    await context.onProgress?.(progress, stage);
  };

  await advance("READING_CONTENT", 10);

  // --- 1. Read the text layer --------------------------------------------
  const data = await storage().get(material.storageKey);
  const { pages, pageCount } = await extractPdfText(data);

  // --- 2. Vision fallback for pages with no usable text layer -------------
  let usedOcr = false;
  const emptyPages = pages.filter((p) => p.text.trim().length < LOW_TEXT_THRESHOLD);
  if (emptyPages.length > 0 && emptyPages.length <= MAX_VISION_PAGES) {
    await advance("UNDERSTANDING_STRUCTURE", 25);
    usedOcr = await runVisionPass({
      pages,
      emptyPageNumbers: emptyPages.map((p) => p.page),
      data,
      traceId: context.traceId,
      userId: material.userId,
      projectId: material.projectId,
    });
  } else if (emptyPages.length > MAX_VISION_PAGES) {
    logger.warn("vision_pass_skipped_too_many_pages", {
      materialId,
      emptyPages: emptyPages.length,
    });
  }

  await advance("UNDERSTANDING_STRUCTURE", 35);

  const fullText = pages.map((p) => p.text).join("\n\n");
  if (fullText.trim().length < 40) {
    throw new AppError(
      "BAD_REQUEST",
      "No readable text could be extracted from this PDF.",
      {
        userMessage:
          "We could not read any text from this PDF. If it is a scanned document, " +
          "try a version with a text layer, or one with fewer pages so it can be read visually.",
      },
    );
  }

  // --- 3. Chunk + index ---------------------------------------------------
  await advance("CREATING_SEARCHABLE_REPRESENTATION", 50);
  const chunks = chunkPages(pages);

  // Rebuild rather than append: makes reprocessing idempotent.
  await db.$transaction([
    db.materialChunk.deleteMany({ where: { materialId } }),
    db.materialChunk.createMany({
      data: chunks.map((chunk) => ({
        materialId,
        projectId: material.projectId,
        index: chunk.index,
        content: chunk.content,
        page: chunk.page,
        heading: chunk.heading,
        kind: chunk.kind,
        tokens: chunk.tokens,
        embedding: JSON.stringify(chunk.embedding),
        termFreq: JSON.stringify(chunk.termFreq),
        length: chunk.length,
      })),
    }),
  ]);

  await advance("EXTRACTING_KNOWLEDGE", 70);

  // --- 4. Concepts + summary ---------------------------------------------
  // Sampled rather than full-text: the first and middle sections carry most of
  // a document's conceptual vocabulary, and this bounds prompt cost on a
  // 200-page PDF.
  const sample = sampleForAnalysis(pages);

  const existing = await db.concept.findMany({
    where: { projectId: material.projectId },
    select: { name: true },
  });

  let conceptCount = 0;
  try {
    const extraction = await runStructuredPrompt(
      conceptExtractionPrompt,
      {
        title: material.filename,
        goal: project.goal,
        content: sample,
        existingConcepts: existing.map((c) => c.name),
      },
      { traceId: context.traceId, userId: material.userId, projectId: material.projectId },
    );

    for (const concept of extraction.value.concepts) {
      const slug = slugify(concept.name);
      if (!slug) continue;
      await db.concept.upsert({
        where: { projectId_slug: { projectId: material.projectId, slug } },
        create: {
          projectId: material.projectId,
          name: concept.name,
          slug,
          description: concept.description,
          importance: concept.importance,
          sourceCount: 1,
        },
        update: {
          // Importance is the max across materials: a concept central to any
          // one document is central to the project.
          importance: { set: concept.importance },
          sourceCount: { increment: 1 },
          description: concept.description,
        },
      });
      conceptCount += 1;
    }

    await linkChunksToConcepts(material.projectId, materialId);
  } catch (error) {
    // Concepts are valuable but not required for the material to be usable —
    // the tutor can still cite it. Degrade rather than fail the whole upload.
    logger.error("concept_extraction_failed", { materialId, error });
  }

  await advance("EXTRACTING_KNOWLEDGE", 88);

  let summary = "";
  try {
    const result = await runStructuredPrompt(
      materialSummaryPrompt,
      { title: material.filename, content: sample },
      { traceId: context.traceId, userId: material.userId, projectId: material.projectId },
    );
    summary = result.value.summary;
  } catch (error) {
    logger.warn("material_summary_failed", { materialId, error });
  }

  // --- 5. Finalise --------------------------------------------------------
  await db.material.update({
    where: { id: materialId },
    data: {
      status: "READY",
      stage: "READY",
      progress: 100,
      pageCount,
      chunkCount: chunks.length,
      charCount: fullText.length,
      summary,
      usedOcr,
      processedAt: new Date(),
      error: null,
    },
  });

  // Report the terminal stage to the job row too, so an operator watching the
  // queue sees the pipeline reach READY rather than stopping at the last
  // intermediate stage it happened to announce.
  await context.onProgress?.(100, "READY");

  const materialCount = await db.material.count({
    where: { projectId: material.projectId, status: "READY" },
  });
  await db.project.update({
    where: { id: material.projectId },
    data: { materialCount },
  });

  await recordActivity({
    userId: material.userId,
    projectId: material.projectId,
    spaceId: project.spaceId,
    type: "MATERIAL_PROCESSING_COMPLETED",
    summary: `Processed ${material.filename} (${chunks.length} sections, ${pageCount} pages)`,
    payload: { materialId, chunkCount: chunks.length, pageCount },
  });

  await publish(
    "MATERIAL_PROCESSED",
    { materialId, projectId: material.projectId, chunkCount: chunks.length },
    { userId: material.userId, projectId: material.projectId },
  );

  return { materialId, chunkCount: chunks.length, pageCount, conceptCount, usedOcr };
}

/**
 * Reads pages with no usable text layer using the model's native PDF
 * understanding. This is how scanned pages, diagrams and image-only tables get
 * into the index (PRD §12).
 *
 * Mutates `pages` in place for the pages it recovers. Returns whether anything
 * was recovered.
 */
async function runVisionPass(params: {
  pages: PageText[];
  emptyPageNumbers: number[];
  data: Buffer;
  traceId: string;
  userId: string;
  projectId: string;
}): Promise<boolean> {
  try {
    const result = await ai.understandDocument(
      {
        pdfBase64: params.data.toString("base64"),
        instruction:
          `Some pages of this PDF have no extractable text layer: pages ` +
          `${params.emptyPageNumbers.join(", ")}.\n\n` +
          `Transcribe the content of those pages only. For each one, output:\n\n` +
          `[[PAGE n]]\n<the full text of that page>\n\n` +
          `Transcribe tables as aligned plain-text rows, keeping the header row. ` +
          `Describe diagrams and figures in enough detail that someone could be ` +
          `quizzed on what they show. Transcribe exactly what is on the page — do ` +
          `not summarise, interpret, or add anything that is not there.`,
        maxTokens: 8192,
      },
      {
        feature: "DOC_UNDERSTANDING",
        promptId: "material.vision_ocr",
        promptVersion: "1.1.0",
        traceId: params.traceId,
        userId: params.userId,
        projectId: params.projectId,
      },
    );

    if (!result.value.trim()) return false;

    let recovered = false;
    const sections = result.value.split(/\[\[PAGE\s+(\d+)\]\]/i);
    // split yields [prefix, pageNo, body, pageNo, body, ...]
    for (let i = 1; i < sections.length; i += 2) {
      const pageNumber = Number(sections[i]);
      const body = (sections[i + 1] ?? "").trim();
      if (!pageNumber || body.length < 40) continue;
      const target = params.pages.find((p) => p.page === pageNumber);
      if (!target) continue;
      target.text = body;
      target.fromOcr = true;
      recovered = true;
    }
    return recovered;
  } catch (error) {
    // A failed vision pass leaves those pages empty — the rest of the document
    // still indexes. Better a partial index than a failed upload.
    logger.warn("vision_pass_failed", { error, pages: params.emptyPageNumbers.length });
    return false;
  }
}

/**
 * Samples a long document for concept extraction: the opening (where scope is
 * usually declared), then evenly spaced windows through the rest.
 */
function sampleForAnalysis(pages: PageText[], budget = 14_000): string {
  const full = pages.map((p) => p.text).join("\n\n");
  if (full.length <= budget) return full;

  const head = full.slice(0, Math.floor(budget * 0.4));
  const remaining = budget - head.length;
  const windows = 4;
  const windowSize = Math.floor(remaining / windows);
  const rest = full.slice(head.length);
  const stride = Math.floor(rest.length / windows);

  const samples: string[] = [head];
  for (let i = 0; i < windows; i += 1) {
    samples.push(rest.slice(i * stride, i * stride + windowSize));
  }
  return samples.join("\n\n[...]\n\n");
}

/**
 * Associates chunks with concepts by term matching, so the quiz generator can
 * retrieve evidence for a specific concept rather than searching the whole
 * project.
 */
async function linkChunksToConcepts(projectId: string, materialId: string) {
  const [concepts, chunks] = await Promise.all([
    db.concept.findMany({ where: { projectId }, select: { id: true, name: true } }),
    db.materialChunk.findMany({
      where: { materialId },
      select: { id: true, content: true },
    }),
  ]);
  if (concepts.length === 0 || chunks.length === 0) return;

  // Deduped in memory: SQLite has no `skipDuplicates`, and chunks are deleted
  // and recreated on reprocess so the only possible duplicates are within this
  // batch (a concept matching a chunk on both the full name and its parts).
  const seen = new Set<string>();
  const links: { conceptId: string; chunkId: string; weight: number }[] = [];
  const add = (conceptId: string, chunkId: string, weight: number) => {
    const key = `${conceptId}|${chunkId}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ conceptId, chunkId, weight });
  };

  for (const concept of concepts) {
    const needle = concept.name.toLowerCase();
    const parts = needle.split(/\s+/).filter((w) => w.length > 3);
    for (const chunk of chunks) {
      const haystack = chunk.content.toLowerCase();
      if (haystack.includes(needle)) {
        add(concept.id, chunk.id, 1);
      } else if (parts.length > 0 && parts.every((part) => haystack.includes(part))) {
        add(concept.id, chunk.id, 0.6);
      }
    }
  }

  if (links.length === 0) return;
  await db.conceptChunk.createMany({ data: links }).catch((error) => {
    logger.warn("concept_chunk_link_failed", { projectId, error });
  });
}

export async function markMaterialFailed(materialId: string, error: unknown) {
  const message = errorMessage(error);
  const userMessage =
    error instanceof AppError
      ? error.userMessage
      : "This material could not be processed. You can remove it and try uploading again.";

  const material = await db.material.update({
    where: { id: materialId },
    data: {
      status: "FAILED",
      stage: "FAILED",
      error: truncate(userMessage, 400),
    },
  });

  await recordActivity({
    userId: material.userId,
    projectId: material.projectId,
    type: "MATERIAL_PROCESSING_FAILED",
    summary: `Processing failed for ${material.filename}`,
    payload: { materialId, error: truncate(message, 300) },
  });

  await publish(
    "MATERIAL_FAILED",
    { materialId, projectId: material.projectId, reason: truncate(message, 200) },
    { userId: material.userId, projectId: material.projectId },
  );
}
