import { createHash } from "node:crypto";
import { rawTokens, tokenize } from "../ai/text";

/**
 * Embedding abstraction (PRD §41).
 *
 * The default implementation is a local, deterministic hashed-ngram embedding
 * rather than a call to a hosted embedding model. The reasoning is in
 * docs/DECISIONS.md, in short:
 *
 *   - Anthropic does not serve an embedding endpoint, so a hosted embedding
 *     model would add a second vendor and a second key to the critical path of
 *     document processing.
 *   - A neural sentence encoder bundled locally (transformers.js) costs ~90MB
 *     of model download at cold start, which is a poor trade for a prototype
 *     that must boot fast on a small host.
 *   - The retriever is hybrid: this vector provides fuzzy, morphology-tolerant
 *     matching, BM25 provides precise lexical matching, and an LLM reranker
 *     provides semantic judgement over the fused shortlist. The semantic work
 *     happens in the reranker, where a strong model is already in the loop.
 *
 * The interface exists so this can be swapped for Voyage/OpenAI/local ONNX by
 * adding one file; nothing else in the codebase changes.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /**
   * Optional synchronous path. Chunking embeds thousands of fragments per
   * document; a local provider can avoid a promise per fragment. A remote
   * provider simply omits it and the caller falls back to `embed`.
   */
  embedSync?(text: string): number[];
}

const DIMENSIONS = 384;

function hashToIndex(token: string, salt: string): number {
  const digest = createHash("sha1").update(`${salt}:${token}`).digest();
  return digest.readUInt32BE(0) % DIMENSIONS;
}

function signFor(token: string): number {
  // A signed hash keeps unrelated collisions from always reinforcing.
  return createHash("sha1").update(token).digest()[0] % 2 === 0 ? 1 : -1;
}

/** Character trigrams give partial-word and typo tolerance. */
function trigrams(token: string): string[] {
  if (token.length <= 3) return [token];
  const grams: string[] = [];
  const padded = `#${token}#`;
  for (let i = 0; i < padded.length - 2; i += 1) grams.push(padded.slice(i, i + 3));
  return grams;
}

export class HashedEmbeddingProvider implements EmbeddingProvider {
  readonly id = "hashed-ngram-v1";
  readonly dimensions = DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedSync(t));
  }

  /** Synchronous variant — chunking runs this thousands of times per document. */
  embedSync(text: string): number[] {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    const words = tokenize(text);
    if (words.length === 0) return vector;

    // Unigrams carry the most weight, then character trigrams, then word bigrams.
    for (const word of words) {
      vector[hashToIndex(word, "w")] += 1.0 * signFor(word);
      for (const gram of trigrams(word)) {
        vector[hashToIndex(gram, "g")] += 0.3 * signFor(gram);
      }
    }

    const ordered = rawTokens(text);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const bigram = `${ordered[i]}_${ordered[i + 1]}`;
      vector[hashToIndex(bigram, "b")] += 0.5 * signFor(bigram);
    }

    // L2 normalise so cosine similarity is a plain dot product.
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    for (let i = 0; i < DIMENSIONS; i += 1) vector[i] /= norm;
    return vector;
  }
}

let provider: EmbeddingProvider = new HashedEmbeddingProvider();

export function getEmbeddingProvider(): EmbeddingProvider {
  return provider;
}

export function setEmbeddingProvider(next: EmbeddingProvider): void {
  provider = next;
}

/** Cosine similarity of two L2-normalised vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}
