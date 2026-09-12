import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { generateNextQuestion, evaluateAnswer } from "@/lib/domain/quiz";
import { applyEvidence, getProjectMastery } from "@/lib/domain/mastery";
import { generateRecommendation, activeRecommendations } from "@/lib/domain/recommendations";
import { upsertContextItem, retrieveContext, decayContext } from "@/lib/domain/learning-context";
import { getGrowth, rollupDailyStats, getProjectAnalytics } from "@/lib/domain/analytics";
import { processMaterial } from "@/lib/materials/processing";
import { storage } from "@/lib/storage";
import { parseJson } from "@/lib/json";
import { buildDocument } from "../prisma/sample/pdf-writer";
import {
  SAMPLE_PAGES,
  makeConcept,
  makeMaterial,
  makeProject,
  makeUser,
  resetDatabase,
} from "./helpers";

describe("document processing pipeline", () => {
  beforeEach(resetDatabase);

  it("takes a real PDF from queued to ready, with chunks and concepts", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id, { goal: "Understand retrieval practice" });

    const pdf = buildDocument("Study Techniques", [
      {
        heading: "1. Retrieval Practice",
        paragraphs: [
          "Retrieval practice means recalling information from memory rather than re-reading it. The act of retrieval is itself a learning event and strengthens the memory trace more than additional exposure does. This is known as the testing effect.",
          "Students who were tested on material retained substantially more after a week than students who simply restudied it. Re-reading produces a feeling of fluency that is easily mistaken for durable knowledge.",
        ],
      },
      {
        heading: "2. Spaced Repetition",
        paragraphs: [
          "Spaced repetition schedules reviews at expanding intervals rather than at a fixed cadence. Distributing the same total study time across several sessions produces markedly better long-term retention than massing it into one.",
        ],
      },
    ]);

    const key = `test/${user.id}/doc.pdf`;
    await storage().put(key, pdf);

    const material = await db.material.create({
      data: {
        projectId: project.id,
        userId: user.id,
        filename: "Study-Techniques.pdf",
        storageKey: key,
        sizeBytes: pdf.length,
        status: "QUEUED",
        stage: "QUEUED",
      },
    });

    const stages: string[] = [];
    const result = await processMaterial(material.id, {
      traceId: "t",
      onProgress: async (_progress, stage) => {
        stages.push(stage);
      },
    });

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.pageCount).toBeGreaterThan(0);

    const updated = await db.material.findUniqueOrThrow({ where: { id: material.id } });
    expect(updated.status).toBe("READY");
    expect(updated.stage).toBe("READY");
    expect(updated.progress).toBe(100);

    // The user-visible stage sequence from the spec.
    expect(stages).toContain("READING_CONTENT");
    expect(stages).toContain("CREATING_SEARCHABLE_REPRESENTATION");
    expect(stages).toContain("READY");

    const chunks = await db.materialChunk.findMany({ where: { materialId: material.id } });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.page >= 1)).toBe(true);
    expect(chunks.every((c) => parseJson<number[]>(c.embedding, []).length > 0)).toBe(true);

    const concepts = await db.concept.findMany({ where: { projectId: project.id } });
    expect(concepts.length).toBeGreaterThan(0);
  });

  it("is idempotent — reprocessing rebuilds rather than duplicating chunks", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    const pdf = buildDocument("Doc", [
      {
        heading: "1. Section",
        paragraphs: [
          "This paragraph contains enough text to survive the minimum chunk size filter and be indexed as a retrievable section of the document with real content in it.",
        ],
      },
    ]);
    const key = `test/${user.id}/idem.pdf`;
    await storage().put(key, pdf);
    const material = await db.material.create({
      data: {
        projectId: project.id,
        userId: user.id,
        filename: "Doc.pdf",
        storageKey: key,
        status: "QUEUED",
        stage: "QUEUED",
      },
    });

    const first = await processMaterial(material.id, { traceId: "t" });
    const second = await processMaterial(material.id, { traceId: "t" });

    expect(second.chunkCount).toBe(first.chunkCount);
    expect(await db.materialChunk.count({ where: { materialId: material.id } })).toBe(
      first.chunkCount,
    );
  });

  it("refuses a job whose payload points at another user's project", async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    const { project } = await makeProject(owner.id);

    const material = await db.material.create({
      data: {
        projectId: project.id,
        // A tampered payload: the material claims a different owner.
        userId: intruder.id,
        filename: "x.pdf",
        storageKey: "test/x",
        status: "QUEUED",
        stage: "QUEUED",
      },
    });

    await expect(processMaterial(material.id, { traceId: "t" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("quiz flow", () => {
  beforeEach(resetDatabase);

  async function setupProject() {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await makeMaterial(user.id, project.id, SAMPLE_PAGES);
    await makeConcept(project.id, "Retrieval Practice");
    await makeConcept(project.id, "Spaced Repetition");
    return { user, project };
  }

  it("generates a valid question grounded in the project's material", async () => {
    const { user, project } = await setupProject();
    const quiz = await db.quiz.create({
      data: { projectId: project.id, userId: user.id, plannedCount: 3 },
    });

    const question = await generateNextQuestion({
      quizId: quiz.id,
      project,
      userId: user.id,
      traceId: "t",
    });

    expect(question.prompt.length).toBeGreaterThan(10);
    expect(question.conceptId).toBeTruthy();
    expect(question.selectionReason.length).toBeGreaterThan(0);
    // Every question records the source it was built from.
    expect(parseJson<unknown[]>(question.sources, []).length).toBeGreaterThan(0);

    if (question.type === "MCQ") {
      expect(parseJson<string[]>(question.options, [])).toHaveLength(4);
      expect(question.correctIndex).not.toBeNull();
    } else {
      expect(parseJson<string[]>(question.rubric, []).length).toBeGreaterThan(0);
    }
  });

  it("does not generate a second question while one is unanswered", async () => {
    const { user, project } = await setupProject();
    const quiz = await db.quiz.create({
      data: { projectId: project.id, userId: user.id, plannedCount: 5 },
    });

    const first = await generateNextQuestion({ quizId: quiz.id, project, userId: user.id, traceId: "t" });
    const second = await generateNextQuestion({ quizId: quiz.id, project, userId: user.id, traceId: "t" });

    expect(second.id).toBe(first.id);
    expect(await db.quizQuestion.count({ where: { quizId: quiz.id } })).toBe(1);
  });

  it("grades a multiple-choice answer in the application, not the model", async () => {
    const { user, project } = await setupProject();
    const quiz = await db.quiz.create({
      data: { projectId: project.id, userId: user.id, plannedCount: 3 },
    });
    const question = await generateNextQuestion({ quizId: quiz.id, project, userId: user.id, traceId: "t" });

    if (question.type !== "MCQ") return; // selection may legitimately pick OPEN

    const correct = await evaluateAnswer({
      question,
      conceptName: "Retrieval Practice",
      rawAnswer: "",
      selectedIndex: question.correctIndex,
      userId: user.id,
      projectId: project.id,
      traceId: "t",
    });
    expect(correct.isCorrect).toBe(true);
    expect(correct.score).toBe(1);
    expect(correct.evaluatedBy).toBe("rule");

    const wrong = await evaluateAnswer({
      question,
      conceptName: "Retrieval Practice",
      rawAnswer: "",
      selectedIndex: ((question.correctIndex ?? 0) + 1) % 4,
      userId: user.id,
      projectId: project.id,
      traceId: "t",
    });
    expect(wrong.isCorrect).toBe(false);
    expect(wrong.score).toBe(0);
  });

  it("updates mastery and records the answer exactly once", async () => {
    const { user, project } = await setupProject();
    const concept = await db.concept.findFirstOrThrow({ where: { projectId: project.id } });
    const quiz = await db.quiz.create({
      data: { projectId: project.id, userId: user.id, plannedCount: 3 },
    });
    const question = await db.quizQuestion.create({
      data: {
        quizId: quiz.id,
        index: 0,
        type: "MCQ",
        prompt: "Test question about retrieval practice?",
        options: JSON.stringify(["a", "b", "c", "d"]),
        correctIndex: 0,
        conceptId: concept.id,
        difficulty: "MEDIUM",
      },
    });

    await db.quizAnswer.create({
      data: {
        questionId: question.id,
        quizId: quiz.id,
        userId: user.id,
        selectedIndex: 0,
        isCorrect: true,
        score: 1,
      },
    });
    await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 1, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });

    // The unique constraint on questionId is what makes double submission safe.
    await expect(
      db.quizAnswer.create({
        data: {
          questionId: question.id,
          quizId: quiz.id,
          userId: user.id,
          selectedIndex: 1,
          isCorrect: false,
          score: 0,
        },
      }),
    ).rejects.toThrow();

    const mastery = await getProjectMastery(project.id);
    const target = mastery.find((m) => m.conceptId === concept.id);
    expect(target?.evidenceCount).toBe(1);
  });
});

describe("recommendations", () => {
  beforeEach(resetDatabase);

  it("recommends adding a material when the project has none", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    await generateRecommendation({ projectId: project.id, userId: user.id, traceId: "t" });
    const active = await activeRecommendations(project.id);

    expect(active).toHaveLength(1);
    expect(active[0].actionType).toBe("ADD_MATERIAL");
  });

  it("does not stack duplicate recommendations for unchanged state", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    await generateRecommendation({ projectId: project.id, userId: user.id, traceId: "t" });
    await generateRecommendation({ projectId: project.id, userId: user.id, traceId: "t" });

    expect(await db.recommendation.count({ where: { projectId: project.id, status: "ACTIVE" } })).toBe(1);
  });

  it("targets the weakest concept once there is evidence", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await makeMaterial(user.id, project.id, SAMPLE_PAGES);
    const weak = await makeConcept(project.id, "Interleaving", 0.9);
    const strong = await makeConcept(project.id, "Retrieval Practice", 0.9);

    await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: weak.id,
      evidence: { score: 0, difficulty: "EASY", source: "QUIZ_MCQ" },
    });
    for (let i = 0; i < 3; i += 1) {
      await applyEvidence({
        projectId: project.id,
        userId: user.id,
        conceptId: strong.id,
        evidence: { score: 1, difficulty: "HARD", source: "QUIZ_OPEN" },
      });
    }

    await generateRecommendation({ projectId: project.id, userId: user.id, traceId: "t" });
    const [recommendation] = await activeRecommendations(project.id);

    expect(recommendation).toBeDefined();
    expect(`${recommendation.title} ${recommendation.body}`).toContain("Interleaving");
  });
});

describe("persistent learning context", () => {
  beforeEach(resetDatabase);

  it("stores a durable fact and retrieves it by relevance", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    await upsertContextItem({
      userId: user.id,
      projectId: project.id,
      kind: "DIFFICULTY",
      content: "Finds the difference between interleaving and blocked practice confusing.",
      source: "TUTOR",
    });
    await upsertContextItem({
      userId: user.id,
      projectId: project.id,
      kind: "PREFERENCE",
      content: "Prefers concrete worked examples over abstract definitions.",
      source: "TUTOR",
    });

    const retrieved = await retrieveContext({
      userId: user.id,
      projectId: project.id,
      query: "interleaving blocked practice",
      limit: 5,
    });

    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved[0].content).toContain("interleaving");
  });

  it("reinforces an existing fact rather than duplicating a paraphrase", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    const content = "Finds the difference between interleaving and blocked practice confusing.";
    await upsertContextItem({
      userId: user.id,
      projectId: project.id,
      kind: "DIFFICULTY",
      content,
      source: "TUTOR",
    });
    await upsertContextItem({
      userId: user.id,
      projectId: project.id,
      kind: "DIFFICULTY",
      content,
      source: "TUTOR",
    });

    const items = await db.learningContextItem.findMany({ where: { userId: user.id } });
    expect(items).toHaveLength(1);
    expect(items[0].evidenceCount).toBeGreaterThan(1);
  });

  it("never returns another project's context", async () => {
    const user = await makeUser();
    const { project: a } = await makeProject(user.id, { name: "A" });
    const { project: b } = await makeProject(user.id, { name: "B" });

    await upsertContextItem({
      userId: user.id,
      projectId: a.id,
      kind: "WEAKNESS",
      content: "Struggles with the specifics of project A material.",
      source: "QUIZ",
    });

    const fromB = await retrieveContext({
      userId: user.id,
      projectId: b.id,
      query: "struggles specifics",
      limit: 10,
    });
    expect(fromB).toHaveLength(0);
  });

  it("retires stale, low-salience context but keeps goals", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    const stale = await upsertContextItem({
      userId: user.id,
      projectId: project.id,
      kind: "TUTOR_NOTE",
      content: "Mentioned in passing that the weather was nice that day.",
      source: "TUTOR",
      salience: 0.2,
    });
    const goal = await upsertContextItem({
      userId: user.id,
      projectId: project.id,
      kind: "GOAL",
      content: "Wants to pass the certification exam in March.",
      source: "USER",
      salience: 0.2,
    });

    const old = new Date(Date.now() - 120 * 86_400_000);
    await db.learningContextItem.updateMany({
      where: { id: { in: [stale!.id, goal!.id] } },
      data: { updatedAt: old },
    });

    const retired = await decayContext(user.id);
    expect(retired).toBe(1);

    expect((await db.learningContextItem.findUniqueOrThrow({ where: { id: stale!.id } })).retiredAt).not.toBeNull();
    expect((await db.learningContextItem.findUniqueOrThrow({ where: { id: goal!.id } })).retiredAt).toBeNull();
  });
});

describe("analytics", () => {
  beforeEach(resetDatabase);

  it("computes growth against the earliest snapshot in the window", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    const concept = await makeConcept(project.id, "Retrieval Practice");

    await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 0, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });
    for (let i = 0; i < 4; i += 1) {
      await applyEvidence({
        projectId: project.id,
        userId: user.id,
        conceptId: concept.id,
        evidence: { score: 1, difficulty: "HARD", source: "QUIZ_OPEN" },
      });
    }

    const growth = await getGrowth(project.id, 14);
    expect(growth).toHaveLength(1);
    expect(growth[0].delta).toBeGreaterThan(0);
    expect(growth[0].currentLevel).toBeGreaterThan(growth[0].previousLevel);
  });

  it("rolls daily stats up idempotently", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await makeMaterial(user.id, project.id, SAMPLE_PAGES);

    await rollupDailyStats(project.id, 1);
    await rollupDailyStats(project.id, 1);

    const rows = await db.projectDailyStat.findMany({ where: { projectId: project.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].materialsAdded).toBe(1);
  });

  it("reports project analytics without throwing on an empty project", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    const analytics = await getProjectAnalytics(project.id, 30);
    expect(analytics.performance.accuracy).toBe(0);
    expect(analytics.activity.tutorQuestions).toBe(0);
  });
});

afterAll(async () => {
  await db.$disconnect();
});
