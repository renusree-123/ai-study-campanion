/**
 * Minimal Markdown renderer for tutor answers.
 *
 * Written by hand rather than adding a Markdown library plus a sanitiser: the
 * model's output is untrusted text, and the safest renderer is one that escapes
 * everything first and then re-introduces only the small set of inline and
 * block constructs the tutor is asked to produce. No raw HTML can survive this,
 * so there is no XSS surface to sanitise.
 *
 * Supports: headings, bold, italics, inline code, fenced code, links (http/https
 * only), unordered and ordered lists, blockquotes, horizontal rules, paragraphs.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Placeholder for extracted code spans. Chosen so it cannot appear in escaped
// output: the angle brackets of a real "<CODESPAN:0>" would already be entities.
const CODE_OPEN = "<CODESPAN:";
const CODE_CLOSE = ">";

function inline(text: string): string {
  let out = escapeHtml(text);

  // Code spans are pulled out first so their contents are not transformed.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${CODE_OPEN}${codeSpans.length - 1}${CODE_CLOSE}`;
  });

  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");

  // Links: http(s) only, and always opened without leaking the referrer.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>',
  );

  out = out.replace(
    /<CODESPAN:(\d+)>/g,
    (_match, index: string) => `<code>${codeSpans[Number(index)]}</code>`,
  );
  return out;
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];

  let listType: "ul" | "ol" | null = null;
  let inCode = false;
  let codeBuffer: string[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      html.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    closeList();
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (/^\s*```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(rawLine);
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      // An h1 inside message content becomes an h2 — the page owns the h1.
      const level = Math.min(3, heading[1].length + 1);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      closeList();
      quote.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inline(unordered[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      html.push("<hr />");
      continue;
    }

    flushQuote();
    closeList();
    paragraph.push(line.trim());
  }

  if (inCode && codeBuffer.length > 0) {
    html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
  }
  flushAll();

  return html.join("\n");
}
