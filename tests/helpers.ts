import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { chunkPages } from "@/lib/retrieval/chunking";
import { slugify } from "@/lib/ai/text";

let counter = 0;
const unique = () => `${Date.now().toString(36)}-${counter++}`;

export async function makeUser(role: "USER" | "ADMIN" = "USER") {
  return db.user.create({
    data: {
      email: `user-${unique()}@test.dev`,
      name: "Test User",
      passwordHash: await hashPassword("test-password-123"),
      role,
    },
  });
}

export async function makeProject(userId: string, overrides: { goal?: string; name?: string } = {}) {
  const space = await db.space.create({
    data: { userId, name: `Space ${unique()}`, description: "" },
  });
  const project = await db.project.create({
    data: {
      userId,
      spaceId: space.id,
      name: overrides.name ?? `Project ${unique()}`,
      goal: overrides.goal ?? "Learn the thing",
      description: "",
    },
  });
  return { space, project };
}

/**
 * Creates a READY material with real chunks and embeddings, without going
 * through PDF parsing — so retrieval tests exercise the real indexing path but
 * stay fast and deterministic.
 */
export async function makeMaterial(
  userId: string,
  projectId: string,
  pages: { page: number; text: string }[],
  filename = "Test-Material.pdf",
) {
  const material = await db.material.create({
    data: {
      projectId,
      userId,
      filename,
      storageKey: `test/${unique()}`,
      status: "READY",
      stage: "READY",
      progress: 100,
      pageCount: pages.length,
      processedAt: new Date(),
    },
  });

  const chunks = chunkPages(pages);
  await db.materialChunk.createMany({
    data: chunks.map((chunk) => ({
      materialId: material.id,
      projectId,
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
  });

  await db.material.update({
    where: { id: material.id },
    data: { chunkCount: chunks.length },
  });

  return { material, chunkCount: chunks.length };
}

export async function makeConcept(projectId: string, name: string, importance = 0.8) {
  return db.concept.create({
    data: { projectId, name, slug: slugify(name), importance, description: `About ${name}` },
  });
}

export async function resetDatabase() {
  // Order matters: children before parents.
  await db.evalCaseResult.deleteMany();
  await db.evalRun.deleteMany();
  await db.toolInvocation.deleteMany();
  await db.retrievalLog.deleteMany();
  await db.aiRequestLog.deleteMany();
  await db.quizAnswer.deleteMany();
  await db.quizQuestion.deleteMany();
  await db.quiz.deleteMany();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.masterySnapshot.deleteMany();
  await db.mastery.deleteMany();
  await db.conceptChunk.deleteMany();
  await db.concept.deleteMany();
  await db.materialChunk.deleteMany();
  await db.material.deleteMany();
  await db.recommendation.deleteMany();
  await db.learningContextItem.deleteMany();
  await db.activityEvent.deleteMany();
  await db.domainEvent.deleteMany();
  await db.job.deleteMany();
  await db.projectDailyStat.deleteMany();
  await db.userDailyStat.deleteMany();
  await db.project.deleteMany();
  await db.space.deleteMany();
  await db.user.deleteMany();
}

export const SAMPLE_PAGES = [
  {
    page: 1,
    text: `1. Retrieval Practice

Retrieval practice means recalling information from memory rather than re-reading it.
The act of retrieval is itself a learning event: it strengthens the memory trace more
than additional exposure to the same material does. This is known as the testing effect.
Students who were tested retained substantially more after one week than students who
restudied the same passages. Re-reading produces confidence; retrieval produces durable
memory that survives a delay.

2. Spaced Repetition

Spaced repetition schedules reviews at expanding intervals rather than at a fixed cadence.
Distributing the same total study time across multiple sessions produces markedly better
long-term retention than massing it into one session. Each interval is chosen to fall
shortly before the point at which the learner would otherwise forget the item.`,
  },
  {
    page: 2,
    text: `3. Interleaving

Interleaving mixes different problem types within a single study session, rather than
practising one type to mastery before moving on. Blocked practice produces faster
improvement during the session but weaker performance on a later mixed test.
The reason is that interleaving forces the learner to first identify which approach
applies, a discrimination step that blocked practice removes entirely.`,
  },
];

export const UNRELATED_PAGES = [
  {
    page: 1,
    text: `1. Radiative Balance

Earth's temperature is set by the balance between incoming shortwave solar radiation and
outgoing longwave infrared radiation. Greenhouse gases absorb outgoing longwave radiation
and re-emit a portion of it downward, which raises the effective emission altitude.
The water vapour feedback is the largest positive feedback in the climate system.`,
  },
];
