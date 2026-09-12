import { createHash } from "node:crypto";
import { db } from "../db";
import { logger } from "../logger";
import { parseJson } from "../json";
import { slugify, truncate } from "../ai/text";
import { cosine, getEmbeddingProvider } from "../retrieval/embedding";

/**
 * Persistent learning context (PRD §39, §40).
 *
 * The design goal is *relevance*, not recall. Two rules follow from that:
 *
 *  - **Write selectively.** Only durable facts are stored — goals, preferences,
 *    demonstrated strengths, recurring difficulties. Transient conversation is
 *    not. Repeated observations reinforce an existing item (raising salience
 *    and evidence count) rather than creating near-duplicates, using a
 *    content-derived dedupe key plus an embedding-similarity check.
 *
 *  - **Read selectively.** Retrieval is scored by relevance to the current
 *    request, not "send everything". A project-scoped query never returns
 *    another project's context, and global items are only mixed in when they
 *    are genuinely relevant.
 *
 * Items decay: salience falls with age unless the item keeps being reinforced,
 * so a preference stated once six months ago does not outrank a difficulty
 * observed yesterday.
 */

export type ContextKind =
  | "GOAL"
  | "PREFERENCE"
  | "STRENGTH"
  | "WEAKNESS"
  | "DIFFICULTY"
  | "TUTOR_NOTE"
  | "ASSESSMENT_NOTE"
  | "PATTERN";

export interface ContextItemInput {
  userId: string;
  projectId?: string | null;
  kind: ContextKind;
  content: string;
  source: "USER" | "TUTOR" | "QUIZ" | "WORKFLOW" | "SYSTEM";
  salience?: number;
  confidence?: number;
  /** Provide to make reinforcement explicit; otherwise derived from content. */
  dedupeKey?: string;
  expiresAt?: Date | null;
}

const SIMILARITY_MERGE_THRESHOLD = 0.86;

export async function upsertContextItem(input: ContextItemInput) {
  const content = truncate(input.content.trim(), 400);
  if (content.length < 8) return null;

  const embedder = getEmbeddingProvider();
  const embedding = await embedder.embed(content);
  const dedupeKey = input.dedupeKey ?? derivedKey(input.kind, content);

  // Near-duplicate check: a paraphrase of an existing fact should reinforce it,
  // not sit beside it. Only same-kind, same-scope items are considered.
  const siblings = await db.learningContextItem.findMany({
    where: {
      userId: input.userId,
      projectId: input.projectId ?? null,
      kind: input.kind,
      retiredAt: null,
    },
    select: { id: true, embedding: true, salience: true, evidenceCount: true },
    take: 60,
  });

  for (const sibling of siblings) {
    const similarity = cosine(embedding, parseJson<number[]>(sibling.embedding, []));
    if (similarity >= SIMILARITY_MERGE_THRESHOLD) {
      return db.learningContextItem.update({
        where: { id: sibling.id },
        data: {
          content,
          salience: Math.min(1, sibling.salience + 0.08),
          evidenceCount: { increment: 1 },
          confidence: { increment: 0 },
          embedding: JSON.stringify(embedding),
          updatedAt: new Date(),
        },
      });
    }
  }

  try {
    return await db.learningContextItem.upsert({
      where: {
        userId_projectId_dedupeKey: {
          userId: input.userId,
          projectId: input.projectId ?? null,
          dedupeKey,
        } as never,
      },
      create: {
        userId: input.userId,
        projectId: input.projectId ?? null,
        kind: input.kind,
        content,
        source: input.source,
        salience: input.salience ?? 0.5,
        confidence: input.confidence ?? 0.5,
        embedding: JSON.stringify(embedding),
        dedupeKey,
        expiresAt: input.expiresAt ?? null,
      },
      update: {
        content,
        salience: { increment: 0.05 },
        evidenceCount: { increment: 1 },
        embedding: JSON.stringify(embedding),
      },
    });
  } catch (error) {
    logger.warn("context_upsert_failed", { userId: input.userId, error });
    return null;
  }
}

function derivedKey(kind: string, content: string): string {
  // Slug of the first meaningful words keeps paraphrases of the same statement
  // colliding on the same key more often than a hash of the whole string would.
  const stem = slugify(content).split("-").slice(0, 6).join("-");
  const hash = createHash("sha1").update(content.toLowerCase()).digest("hex").slice(0, 8);
  return `${kind}:${stem || hash}`;
}

export interface RetrievedContext {
  id: string;
  kind: string;
  content: string;
  salience: number;
  scope: "project" | "global";
}

/**
 * Relevance-ranked context for a specific request.
 *
 * Score combines semantic similarity to the query, stored salience, and a
 * recency decay. Project-scoped items get a scope bonus so they outrank an
 * equally similar global item.
 */
export async function retrieveContext(params: {
  userId: string;
  projectId?: string;
  query: string;
  limit?: number;
  kinds?: ContextKind[];
}): Promise<RetrievedContext[]> {
  const limit = params.limit ?? 8;
  const now = Date.now();

  const items = await db.learningContextItem.findMany({
    where: {
      userId: params.userId,
      retiredAt: null,
      ...(params.kinds?.length ? { kind: { in: params.kinds } } : {}),
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        // Project scope OR global — never another project's context.
        params.projectId
          ? { OR: [{ projectId: params.projectId }, { projectId: null }] }
          : { projectId: null },
      ],
    },
    take: 200,
  });

  if (items.length === 0) return [];

  const embedder = getEmbeddingProvider();
  const queryVector = params.query ? await embedder.embed(params.query) : null;

  const scored = items.map((item) => {
    const similarity = queryVector
      ? cosine(queryVector, parseJson<number[]>(item.embedding, []))
      : 0;
    const ageDays = (now - item.updatedAt.getTime()) / 86_400_000;
    const recency = Math.exp(-ageDays / 45); // half-life around a month
    const scopeBonus = item.projectId ? 0.15 : 0;
    // Goals are almost always worth carrying, similar or not.
    const kindBonus = item.kind === "GOAL" ? 0.2 : 0;
    return {
      item,
      score: similarity * 0.5 + item.salience * 0.25 + recency * 0.15 + scopeBonus + kindBonus,
    };
  });

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((s) => s.score > 0.12);

  // Mark what was actually used, so unused context ages out faster.
  void db.learningContextItem
    .updateMany({
      where: { id: { in: selected.map((s) => s.item.id) } },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  return selected.map((s) => ({
    id: s.item.id,
    kind: s.item.kind,
    content: s.item.content,
    salience: s.item.salience,
    scope: s.item.projectId ? "project" : "global",
  }));
}

/** Full context list for the project dashboard's "Learning Context" panel. */
export async function listProjectContext(userId: string, projectId: string) {
  return db.learningContextItem.findMany({
    where: {
      userId,
      retiredAt: null,
      OR: [{ projectId }, { projectId: null }],
    },
    orderBy: [{ salience: "desc" }, { updatedAt: "desc" }],
    take: 40,
  });
}

/**
 * Age out context that has stopped earning its place: low salience, not used
 * recently, and not reinforced. Run by the analytics rollup job.
 */
export async function decayContext(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 86_400_000);
  const result = await db.learningContextItem.updateMany({
    where: {
      userId,
      retiredAt: null,
      salience: { lt: 0.3 },
      evidenceCount: { lte: 1 },
      updatedAt: { lt: cutoff },
      kind: { notIn: ["GOAL"] },
    },
    data: { retiredAt: new Date() },
  });
  return result.count;
}
