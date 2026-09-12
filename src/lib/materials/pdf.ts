// Static ESM import: pdfjs-dist ships an ESM-only legacy build. A dynamic
// import() breaks under tsx (the worker's runtime), which rewrites it into a
// data:-URL require that cannot resolve a bare specifier.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { logger } from "../logger";
import { AppError } from "../errors";
import type { PageText } from "../retrieval/chunking";

/**
 * PDF text extraction using pdfjs-dist's legacy (Node) build.
 *
 * Two passes:
 *  1. The embedded text layer, item by item, reconstructing line breaks from
 *     glyph positions so tables and headings survive as structure rather than
 *     collapsing into one run-on line.
 *  2. For pages whose text layer is empty or near-empty — scans, or pages that
 *     are entirely diagram — the caller falls back to model-based document
 *     understanding (see extractWithVision in processing.ts).
 */

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

/** Pages with less than this much text are candidates for the vision pass. */
export const LOW_TEXT_THRESHOLD = 120;

export async function extractPdfText(
  data: Buffer,
): Promise<{ pages: PageText[]; pageCount: number }> {
  let document;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(data),
      // No worker in Node; run on the main thread.
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;
  } catch (error) {
    throw new AppError(
      "BAD_REQUEST",
      `This file could not be opened as a PDF: ${error instanceof Error ? error.message : String(error)}`,
      {
        userMessage:
          "This file could not be read as a PDF. It may be corrupt, or password protected.",
      },
    );
  }

  const pages: PageText[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    try {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({ page: pageNumber, text: reconstructLayout(content.items as TextItem[]) });
      page.cleanup();
    } catch (error) {
      // One unreadable page must not fail a 200-page document.
      logger.warn("pdf_page_extract_failed", { pageNumber, error });
      pages.push({ page: pageNumber, text: "" });
    }
  }

  const pageCount = document.numPages;
  await document.destroy();
  return { pages, pageCount };
}

/**
 * Rebuilds line and column structure from positioned glyph runs.
 *
 * pdfjs returns text items with a transform matrix; items sharing a baseline
 * belong to the same visual line. Wide horizontal gaps within a line are
 * preserved as runs of spaces, which is what lets the chunker recognise a
 * table later.
 */
function reconstructLayout(items: TextItem[]): string {
  if (items.length === 0) return "";

  interface Positioned {
    text: string;
    x: number;
    y: number;
    width: number;
  }

  const positioned: Positioned[] = items
    .filter((item) => item.str.length > 0)
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
    }));

  if (positioned.length === 0) return "";

  // Group by baseline, tolerating sub-pixel drift within a line.
  const lines: Positioned[][] = [];
  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x);
  let current: Positioned[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const item = sorted[i];
    const reference = current[0];
    if (Math.abs(item.y - reference.y) <= 2.5) {
      current.push(item);
    } else {
      lines.push(current);
      current = [item];
    }
  }
  lines.push(current);

  const rendered = lines.map((line) => {
    const ordered = line.sort((a, b) => a.x - b.x);
    let text = "";
    let cursorX: number | null = null;
    for (const item of ordered) {
      if (cursorX !== null) {
        const gap = item.x - cursorX;
        // A gap wider than roughly two characters is a column break.
        if (gap > 12) text += "   ";
        else if (gap > 1.2 && !text.endsWith(" ") && !item.text.startsWith(" ")) text += " ";
      }
      text += item.text;
      cursorX = item.x + item.width;
    }
    return text.trimEnd();
  });

  // Collapse runs of blank lines but keep paragraph separation.
  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Is this buffer actually a PDF? Checked before anything expensive happens. */
export function looksLikePdf(data: Buffer): boolean {
  return data.subarray(0, 5).toString("latin1") === "%PDF-";
}
