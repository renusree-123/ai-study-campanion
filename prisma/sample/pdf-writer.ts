/**
 * Minimal PDF writer — enough to produce multi-page text documents for the
 * seed data and the test suite, with no external dependency.
 *
 * Emits an uncompressed PDF 1.4 using the standard Helvetica fonts, which
 * every PDF reader (and pdfjs) can read without an embedded font programme.
 */

export interface PdfPageSpec {
  /** Lines already wrapped, or long lines that will be wrapped for you. */
  lines: { text: string; size?: number; bold?: boolean; gap?: number }[];
}

const PAGE_WIDTH = 595; // A4 at 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const MAX_WIDTH = PAGE_WIDTH - MARGIN * 2;

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    // Standard-font encoding is Latin-1; drop anything outside it.
    .replace(/[^\x20-\x7E]/g, (c) => (c === "—" ? "-" : c === "’" ? "'" : ""));
}

/** Helvetica average advance is ~0.5em; good enough for layout here. */
function widthOf(text: string, size: number): number {
  return text.length * size * 0.5;
}

export function wrapText(text: string, size: number, maxWidth = MAX_WIDTH): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (widthOf(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function buildPdf(pages: PdfPageSpec[]): Buffer {
  const objects: string[] = [];
  const pageObjectIds: number[] = [];

  // 1 = Catalog, 2 = Pages, 3 = Helvetica, 4 = Helvetica-Bold
  const firstPageObject = 5;
  pages.forEach((_, index) => pageObjectIds.push(firstPageObject + index * 2));

  const contentStreams = pages.map((page) => {
    let y = PAGE_HEIGHT - MARGIN;
    const parts: string[] = ["BT"];
    let currentFont = "";
    for (const line of page.lines) {
      const size = line.size ?? 11;
      const font = line.bold ? "/F2" : "/F1";
      const gap = line.gap ?? size * 1.45;
      y -= gap;
      if (y < MARGIN) break;
      if (`${font}${size}` !== currentFont) {
        parts.push(`${font} ${size} Tf`);
        currentFont = `${font}${size}`;
      }
      parts.push(`1 0 0 1 ${MARGIN} ${y.toFixed(1)} Tm (${escapeText(line.text)}) Tj`);
    }
    parts.push("ET");
    return parts.join("\n");
  });

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pages.forEach((_, index) => {
    const pageId = firstPageObject + index * 2;
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = contentStreams[index];
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  const maxId = firstPageObject + pages.length * 2 - 1;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${objects[id] ?? "<< >>"}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/** Convenience: build a document from a title plus markdown-ish sections. */
export function buildDocument(
  title: string,
  sections: { heading: string; paragraphs: string[] }[],
  linesPerPage = 34,
): Buffer {
  const all: { text: string; size?: number; bold?: boolean; gap?: number }[] = [
    { text: title, size: 18, bold: true, gap: 30 },
    { text: "", size: 11, gap: 8 },
  ];

  for (const section of sections) {
    all.push({ text: section.heading, size: 13, bold: true, gap: 26 });
    for (const paragraph of section.paragraphs) {
      for (const line of wrapText(paragraph, 11)) {
        all.push({ text: line, size: 11 });
      }
      all.push({ text: "", size: 11, gap: 8 });
    }
  }

  const pages: PdfPageSpec[] = [];
  for (let i = 0; i < all.length; i += linesPerPage) {
    pages.push({ lines: all.slice(i, i + linesPerPage) });
  }
  return buildPdf(pages.length > 0 ? pages : [{ lines: [] }]);
}
