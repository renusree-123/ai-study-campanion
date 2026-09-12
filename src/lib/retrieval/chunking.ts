import { tokenize, termFrequencies } from "../ai/text";
import { getEmbeddingProvider } from "./embedding";

export interface PageText {
  page: number;
  text: string;
  /** True when the text came from a vision/OCR pass rather than the text layer. */
  fromOcr?: boolean;
}

export interface PreparedChunk {
  index: number;
  content: string;
  page: number;
  heading: string;
  kind: "TEXT" | "TABLE" | "FIGURE" | "OCR";
  tokens: number;
  embedding: number[];
  termFreq: Record<string, number>;
  length: number;
}

const TARGET_CHARS = 1100;
const HARD_MAX_CHARS = 1600;
const OVERLAP_CHARS = 200;
const MIN_CHARS = 120;

/** Lines that look like a heading: short, title-ish, no terminal punctuation. */
export function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 90) return false;
  if (/[.!?,;:]$/.test(trimmed)) return false;
  // Numbered section headings: "3.2 Something", "1. The Forgetting Curve"
  if (/^\d+(\.\d+)*\.?\s+\S/.test(trimmed)) return true;
  const words = trimmed.split(/\s+/);
  if (words.length > 12 || words.length === 0) return false;
  if (/^(figure|table|appendix|chapter|section|part)\b/i.test(trimmed)) return true;
  const capitalised = words.filter((w) => /^[A-Z0-9]/.test(w)).length;
  return capitalised / words.length > 0.65;
}

/** A line with several wide column gaps is probably a table row. */
function isTabularLine(line: string): boolean {
  return (line.match(/\s{3,}|\t|\|/g) ?? []).length >= 2 && line.trim().length > 0;
}

/**
 * Splits page text into retrieval chunks.
 *
 * The chunker works line by line rather than on blank-line-separated
 * paragraphs, because extracted PDF text frequently has no blank lines at all —
 * an earlier paragraph-based version collapsed an entire page into one 2.4k
 * chunk and never saw the headings inside it.
 *
 * Behaviour:
 *   - breaks on detected headings, and carries the heading onto each chunk as
 *     context so a retrieved fragment still says what it is about
 *   - keeps runs of table-like lines together, so rows stay with their header
 *   - splits oversized runs at sentence boundaries, not mid-word
 *   - overlaps consecutive chunks so a fact spanning a boundary is retrievable
 *   - preserves the page number on every chunk, which is what makes
 *     "Document — Page 14" citations possible
 */
export function chunkPages(pages: PageText[]): PreparedChunk[] {
  const embedder = getEmbeddingProvider();
  const chunks: PreparedChunk[] = [];
  let index = 0;

  const emit = (
    body: string,
    page: number,
    heading: string,
    kind: PreparedChunk["kind"],
    fromOcr: boolean,
  ) => {
    const content = body.trim();
    if (content.length < MIN_CHARS) return;
    const withHeading = heading && !content.startsWith(heading) ? `${heading}\n\n${content}` : content;
    const tokens = tokenize(withHeading);
    chunks.push({
      index: index++,
      content: withHeading,
      page,
      heading,
      kind: fromOcr ? "OCR" : kind,
      tokens: tokens.length,
      embedding: embedder.embedSync
        ? embedder.embedSync(withHeading)
        : new Array(embedder.dimensions).fill(0),
      termFreq: termFrequencies(tokens),
      length: tokens.length,
    });
  };

  for (const page of pages) {
    const lines = page.text.replace(/\r\n/g, "\n").split("\n");
    let heading = "";
    let buffer = "";
    let bufferKind: "TEXT" | "TABLE" = "TEXT";

    const flush = () => {
      if (buffer.trim().length < MIN_CHARS) {
        // Too small to stand alone — keep accumulating rather than emitting
        // a fragment that will never win a retrieval.
        return false;
      }
      for (const part of splitOversized(buffer)) {
        emit(part, page.page, heading, bufferKind, Boolean(page.fromOcr));
      }
      // Carry a tail of context into the next chunk.
      buffer = buffer.length > OVERLAP_CHARS ? `${buffer.slice(-OVERLAP_CHARS)} ` : "";
      bufferKind = "TEXT";
      return true;
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (line.trim().length === 0) {
        buffer += "\n";
        continue;
      }

      if (isHeading(line)) {
        // A heading starts a new topic: close out what came before, then the
        // heading becomes the label for everything that follows.
        if (buffer.trim().length >= MIN_CHARS) {
          for (const part of splitOversized(buffer)) {
            emit(part, page.page, heading, bufferKind, Boolean(page.fromOcr));
          }
        }
        buffer = "";
        bufferKind = "TEXT";
        heading = line.trim();
        continue;
      }

      if (isTabularLine(line)) {
        bufferKind = "TABLE";
      }

      buffer += `${line}\n`;

      if (buffer.length >= HARD_MAX_CHARS) flush();
      else if (buffer.length >= TARGET_CHARS && /[.!?]\s*$/.test(line)) flush();
    }

    if (buffer.trim().length >= MIN_CHARS) {
      for (const part of splitOversized(buffer)) {
        emit(part, page.page, heading, bufferKind, Boolean(page.fromOcr));
      }
    }
  }

  return chunks;
}

/**
 * Breaks a run longer than the hard maximum into pieces, preferring sentence
 * boundaries and falling back to a hard cut only when a single "sentence" is
 * itself oversized (which happens with badly extracted text).
 */
function splitOversized(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= HARD_MAX_CHARS) return [trimmed];

  const pieces: string[] = [];
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > HARD_MAX_CHARS) {
      if (current.trim()) pieces.push(current.trim());
      current = "";
      for (let i = 0; i < sentence.length; i += TARGET_CHARS) {
        pieces.push(sentence.slice(i, i + TARGET_CHARS));
      }
      continue;
    }
    if (current.length + sentence.length > TARGET_CHARS && current.trim()) {
      pieces.push(current.trim());
      current = "";
    }
    current += `${sentence} `;
  }

  if (current.trim()) pieces.push(current.trim());
  return pieces.filter((p) => p.length >= MIN_CHARS);
}
