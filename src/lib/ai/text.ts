/** Small text utilities shared by the offline provider, retrieval and scoring. */

const STOPWORDS = new Set(
  ("a about above after again against all am an and any are aren as at be because been before being below " +
    "between both but by can cannot could couldn did didn do does doesn doing don down during each few for " +
    "from further had hadn has hasn have haven having he her here hers herself him himself his how i if in " +
    "into is isn it its itself let me more most mustn my myself no nor not of off on once only or other " +
    "ought our ours ourselves out over own same shan she should shouldn so some such than that the their " +
    "theirs them themselves then there these they this those through to too under until up very was wasn we " +
    "were weren what when where which while who whom why with won would wouldn you your yours yourself " +
    "yourselves also may might must shall will just like using used use one two three").split(/\s+/),
);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/**
 * Lowercase alphanumeric tokens, stopwords removed, very short tokens dropped.
 *
 * A hyphenated word yields both the whole form and its parts, so "re-reading"
 * matches a query for "reading" and "self-explanation" matches "explanation".
 * Without this, hyphenation silently breaks both retrieval and rubric matching.
 */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9][a-z0-9'+-]*/g) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    if (token.length > 2 && !STOPWORDS.has(token)) out.push(token);
    if (token.includes("-")) {
      for (const part of token.split("-")) {
        if (part.length > 2 && !STOPWORDS.has(part)) out.push(part);
      }
    }
  }
  return out;
}

/** Tokens including stopwords — used where position matters more than salience. */
export function rawTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'+-]*/g) ?? [];
}

export function termFrequencies(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const token of tokens) tf[token] = (tf[token] ?? 0) + 1;
  return tf;
}

/** Split into sentences, keeping only those with real content. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Proportion of `needle`'s meaningful tokens that appear in `haystack`. */
export function tokenOverlap(needle: string, haystack: string): number {
  const needleTokens = new Set(tokenize(needle));
  if (needleTokens.size === 0) return 0;
  const haystackTokens = new Set(tokenize(haystack));
  let hits = 0;
  for (const token of needleTokens) if (haystackTokens.has(token)) hits += 1;
  return hits / needleTokens.size;
}

export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Deterministic pseudo-random generator seeded from a string. Used by the
 * offline provider so identical inputs always produce identical output — a
 * hard requirement for reproducible tests and eval baselines.
 */
export function seededRandom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}

/** Extract the contents of a `<tag>...</tag>` section from a prompt payload. */
export function extractTag(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

export function extractAllTags(text: string, tag: string): string[] {
  const matches = text.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"));
  return [...matches].map((m) => m[1].trim());
}
