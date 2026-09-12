import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { searchProject, sourceLabel } from "@/lib/retrieval/search";
import { chunkPages } from "@/lib/retrieval/chunking";
import { cosine, getEmbeddingProvider } from "@/lib/retrieval/embedding";
import {
  SAMPLE_PAGES,
  UNRELATED_PAGES,
  makeMaterial,
  makeProject,
  makeUser,
  resetDatabase,
} from "./helpers";

describe("chunking", () => {
  it("splits pages into chunks that carry their heading and page number", () => {
    const chunks = chunkPages(SAMPLE_PAGES);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.page >= 1)).toBe(true);
    expect(chunks.some((c) => c.heading.includes("Retrieval Practice"))).toBe(true);
    expect(chunks.some((c) => c.page === 2)).toBe(true);
  });

  it("does not collapse a whole page into one chunk when there are no blank lines", () => {
    // Regression guard: an earlier paragraph-based chunker produced one giant
    // chunk for extracted PDF text, which has no blank lines.
    const dense = [
      {
        page: 1,
        text: Array.from(
          { length: 40 },
          (_, i) => `Sentence number ${i} explains an important idea about the subject matter here.`,
        ).join("\n"),
      },
    ];
    const chunks = chunkPages(dense);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.content.length))).toBeLessThan(2200);
  });

  it("produces normalised embeddings", () => {
    const chunks = chunkPages(SAMPLE_PAGES);
    for (const chunk of chunks) {
      const norm = Math.sqrt(chunk.embedding.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeGreaterThan(0.99);
      expect(norm).toBeLessThan(1.01);
    }
  });
});

describe("embeddings", () => {
  it("scores related text higher than unrelated text", async () => {
    const embedder = getEmbeddingProvider();
    const query = await embedder.embed("retrieval practice and memory");
    const related = await embedder.embed("retrieval practice strengthens memory");
    const unrelated = await embedder.embed("sourdough bread hydration and baking time");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("is deterministic", async () => {
    const embedder = getEmbeddingProvider();
    const a = await embedder.embed("the same input text");
    const b = await embedder.embed("the same input text");
    expect(a).toEqual(b);
  });
});

describe("project search", () => {
  beforeEach(resetDatabase);

  it("retrieves relevant passages with a citable page number", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await makeMaterial(user.id, project.id, SAMPLE_PAGES);

    const result = await searchProject({
      projectId: project.id,
      userId: user.id,
      query: "What is the testing effect?",
      rerank: false,
      traceId: "t",
    });

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].content.toLowerCase()).toContain("retrieval");
    expect(result.chunks[0].page).toBeGreaterThan(0);
    expect(sourceLabel(result.chunks[0])).toMatch(/Test-Material\.pdf — Page \d+/);
  });

  it("returns nothing for an off-topic query rather than a weak lexical match", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await makeMaterial(user.id, project.id, SAMPLE_PAGES);

    // "practice" and "session" appear in the material, but this question is
    // not about it — the relevance floor must reject the match.
    const result = await searchProject({
      projectId: project.id,
      userId: user.id,
      query: "How do I make sourdough bread rise properly?",
      rerank: false,
      traceId: "t",
    });

    expect(result.chunks).toHaveLength(0);
  });

  it("never returns another project's material", async () => {
    const user = await makeUser();
    const { project: studyProject } = await makeProject(user.id, { name: "Study" });
    const { project: climateProject } = await makeProject(user.id, { name: "Climate" });

    await makeMaterial(user.id, studyProject.id, SAMPLE_PAGES, "Study.pdf");
    await makeMaterial(user.id, climateProject.id, UNRELATED_PAGES, "Climate.pdf");

    const result = await searchProject({
      projectId: studyProject.id,
      userId: user.id,
      query: "greenhouse gases infrared radiation water vapour feedback",
      rerank: false,
      traceId: "t",
    });

    // The content exists — in the other project. It must not leak.
    expect(result.chunks).toHaveLength(0);

    const inOwnProject = await searchProject({
      projectId: climateProject.id,
      userId: user.id,
      query: "water vapour feedback",
      rerank: false,
      traceId: "t",
    });
    expect(inOwnProject.chunks.length).toBeGreaterThan(0);
  });

  it("excludes material that has not finished processing", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    const { material } = await makeMaterial(user.id, project.id, SAMPLE_PAGES);
    await db.material.update({ where: { id: material.id }, data: { status: "PROCESSING" } });

    const result = await searchProject({
      projectId: project.id,
      userId: user.id,
      query: "testing effect",
      rerank: false,
      traceId: "t",
    });
    expect(result.chunks).toHaveLength(0);
  });

  it("writes a retrieval log entry for observability", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await makeMaterial(user.id, project.id, SAMPLE_PAGES);

    await searchProject({
      projectId: project.id,
      userId: user.id,
      query: "spaced repetition",
      rerank: false,
      traceId: "trace-abc",
    });

    const log = await db.retrievalLog.findFirst({ where: { traceId: "trace-abc" } });
    expect(log).not.toBeNull();
    expect(log?.status).toBe("SUCCESS");
    expect(log?.returnedCount).toBeGreaterThan(0);
  });
});

afterAll(async () => {
  await db.$disconnect();
});
