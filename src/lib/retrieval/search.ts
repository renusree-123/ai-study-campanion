import { db } from "../db";
import { logger } from "../logger";
import { parseJson } from "../json";
import { tokenize, truncate } from "../ai/text";
import { runStructuredPrompt } from "../ai/run";
import { rerankPrompt } from "../ai/prompts";
import { cosine, getEmbeddingProvider } from "./embedding";

export interface RetrievedChunk {
  chunkId: string;
  materialId: string;
  materialName: string;
  page: number;
  heading: string;
  content: string;
  kind: string;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  rerankScore?: number;
}

export interface SearchOptions {
  projectId: string;
  userId: string;
  query: string;
  limit?: number;
  /** Restrict to a subset of materials. */
  materialIds?: string[];
  /** LLM reranking costs a model call; skip it for latency-sensitive paths. */
  rerank?: boolean;
  traceId: string;
}

export interface SearchResult {
  chunks: RetrievedChunk[];
  latencyMs: number;
  candidateCount: number;
  reranked: boolean;
  strategy: string;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const CANDIDATE_POOL = 40;
const RERANK_POOL = 12;

/**
 * Minimum relevance a chunk must reach to be treated as evidence.
 *
 * Without a floor, BM25 returns *something* for any query that shares a single
 * common word with the corpus — so a question about sourdough bread would be
 * "answered" from a document about study technique because both contain the
 * word "make". Returning nothing is the correct behaviour when the project's
 * materials do not cover a topic; it is what lets the tutor refuse honestly
 * (PRD §20) instead of confabulating from irrelevant passages.
 */
const MIN_RELEVANCE = 0.3;

/**
 * Hybrid retrieval: BM25 lexical + hashed-vector cosine, fused with Reciprocal
 * Rank Fusion, optionally reranked by the model.
 *
 * RRF is used instead of a weighted score sum because BM25 scores and cosine
 * similarities are not on a comparable scale; fusing by *rank* avoids having to
 * calibrate one against the other, and is robust when one retriever returns
 * nothing useful.
 *
 * Isolation: the projectId filter is applied in the database query, not after
 * scoring, so a chunk from another project can never enter the candidate pool
 * (PRD §52). The caller must have already verified the user owns the project.
 */
export async function searchProject(options: SearchOptions): Promise<SearchResult> {
  const started = Date.now();
  const limit = options.limit ?? 6;
  const queryTokens = tokenize(options.query);

  const chunks = await db.materialChunk.findMany({
    where: {
      projectId: options.projectId,
      ...(options.materialIds?.length ? { materialId: { in: options.materialIds } } : {}),
      material: { status: "READY" },
    },
    select: {
      id: true,
      materialId: true,
      content: true,
      page: true,
      heading: true,
      kind: true,
      embedding: true,
      termFreq: true,
      length: true,
      material: { select: { filename: true } },
    },
  });

  if (chunks.length === 0) {
    await logRetrieval(options, { latencyMs: Date.now() - started, status: "EMPTY", chunks: [], candidates: 0, reranked: false });
    return { chunks: [], latencyMs: Date.now() - started, candidateCount: 0, reranked: false, strategy: "hybrid" };
  }

  // --- BM25 ---------------------------------------------------------------
  const documentFrequency = new Map<string, number>();
  const parsedTermFreqs = chunks.map((chunk) => parseJson<Record<string, number>>(chunk.termFreq, {}));
  for (const tf of parsedTermFreqs) {
    for (const term of Object.keys(tf)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const totalDocs = chunks.length;
  const avgLength =
    chunks.reduce((sum, c) => sum + (c.length || 1), 0) / Math.max(1, totalDocs);

  const lexicalScores = chunks.map((chunk, i) => {
    const tf = parsedTermFreqs[i];
    const docLength = chunk.length || 1;
    let score = 0;
    for (const term of queryTokens) {
      const frequency = tf[term];
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      // BM25 IDF with the +0.5 smoothing that keeps common terms non-negative.
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      score +=
        idf *
        ((frequency * (BM25_K1 + 1)) /
          (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgLength))));
    }
    return score;
  });

  // --- Vector -------------------------------------------------------------
  const embedder = getEmbeddingProvider();
  const queryVector = await embedder.embed(options.query);
  const vectorScores = chunks.map((chunk) =>
    cosine(queryVector, parseJson<number[]>(chunk.embedding, [])),
  );

  // --- Reciprocal Rank Fusion --------------------------------------------
  const RRF_K = 60;
  const byLexical = rankOrder(lexicalScores);
  const byVector = rankOrder(vectorScores);

  // Query-term coverage: what fraction of the question's meaningful terms
  // actually appear in the chunk. This is the signal that distinguishes
  // "shares one common word" from "is about this".
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const coverage = parsedTermFreqs.map((tf) => {
    if (uniqueQueryTokens.length === 0) return 0;
    let hits = 0;
    for (const term of uniqueQueryTokens) if (tf[term]) hits += 1;
    return hits / uniqueQueryTokens.length;
  });

  const fused = chunks.map((chunk, i) => {
    // A retriever that scored zero contributes nothing rather than a spurious
    // low-rank vote.
    const lexicalContribution = lexicalScores[i] > 0 ? 1 / (RRF_K + byLexical[i]) : 0;
    const vectorContribution = vectorScores[i] > 0.02 ? 1 / (RRF_K + byVector[i]) : 0;
    return {
      chunkId: chunk.id,
      materialId: chunk.materialId,
      materialName: chunk.material.filename,
      page: chunk.page,
      heading: chunk.heading,
      content: chunk.content,
      kind: chunk.kind,
      lexicalScore: lexicalScores[i],
      vectorScore: vectorScores[i],
      score: lexicalContribution + vectorContribution,
      // Either strong term coverage or strong vector similarity qualifies, so
      // a paraphrased question is not rejected for using different words.
      relevance: Math.max(coverage[i], vectorScores[i] * 1.25),
    };
  });

  const candidates = fused
    .filter((c) => c.score > 0 && c.relevance >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_POOL);

  if (candidates.length === 0) {
    await logRetrieval(options, { latencyMs: Date.now() - started, status: "EMPTY", chunks: [], candidates: 0, reranked: false });
    return { chunks: [], latencyMs: Date.now() - started, candidateCount: 0, reranked: false, strategy: "hybrid" };
  }

  // --- Optional LLM rerank -----------------------------------------------
  let selected = candidates.slice(0, limit);
  let reranked = false;

  if (options.rerank !== false && candidates.length > limit) {
    const pool = candidates.slice(0, RERANK_POOL);
    try {
      const result = await runStructuredPrompt(
        rerankPrompt,
        {
          query: options.query,
          candidates: pool.map((c) => ({ id: c.chunkId, text: truncate(c.content, 700) })),
        },
        { traceId: options.traceId, userId: options.userId, projectId: options.projectId },
      );
      const relevanceById = new Map(result.value.ranking.map((r) => [r.id, r.relevance]));
      // Any candidate the model failed to score keeps its fused rank rather
      // than being silently dropped.
      selected = pool
        .map((c) => ({ ...c, rerankScore: relevanceById.get(c.chunkId) ?? c.score }))
        .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
        .filter((c) => (c.rerankScore ?? 0) > 0.15)
        .slice(0, limit);
      // If reranking filtered everything out, fall back to the fused order
      // rather than pretending the project has no relevant material.
      if (selected.length === 0) selected = candidates.slice(0, limit);
      reranked = true;
    } catch (error) {
      // Reranking is an enhancement. Losing it degrades ordering, not the
      // feature, so a failure here must not fail the tutor request.
      logger.warn("rerank_failed_using_fused_order", {
        traceId: options.traceId,
        projectId: options.projectId,
        error,
      });
    }
  }

  const latencyMs = Date.now() - started;
  await logRetrieval(options, {
    latencyMs,
    status: "SUCCESS",
    chunks: selected,
    candidates: candidates.length,
    reranked,
  });

  return {
    chunks: selected,
    latencyMs,
    candidateCount: candidates.length,
    reranked,
    strategy: reranked ? "hybrid+rerank" : "hybrid",
  };
}

/** 1-based rank of each element by descending score. */
function rankOrder(scores: number[]): number[] {
  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score);
  const ranks = new Array<number>(scores.length).fill(scores.length);
  order.forEach((item, rank) => {
    ranks[item.index] = rank + 1;
  });
  return ranks;
}

async function logRetrieval(
  options: SearchOptions,
  outcome: {
    latencyMs: number;
    status: string;
    chunks: { chunkId: string; score: number }[];
    candidates: number;
    reranked: boolean;
  },
) {
  try {
    await db.retrievalLog.create({
      data: {
        traceId: options.traceId,
        projectId: options.projectId,
        userId: options.userId,
        query: truncate(options.query, 500),
        strategy: outcome.reranked ? "hybrid+rerank" : "hybrid",
        latencyMs: outcome.latencyMs,
        candidateCount: outcome.candidates,
        returnedCount: outcome.chunks.length,
        topScore: outcome.chunks[0]?.score ?? 0,
        reranked: outcome.reranked,
        sourceIds: JSON.stringify(outcome.chunks.map((c) => c.chunkId)),
        status: outcome.status,
      },
    });
  } catch (error) {
    logger.warn("retrieval_log_failed", { traceId: options.traceId, error });
  }
}

/** Human-readable citation label: "Handbook.pdf — Page 14". */
export function sourceLabel(chunk: { materialName: string; page: number }): string {
  return `${chunk.materialName} — Page ${chunk.page}`;
}
