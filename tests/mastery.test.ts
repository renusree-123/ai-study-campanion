import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { applyEvidence, getWeakConcepts, recalculateTrends } from "@/lib/domain/mastery";
import { selectNextQuestion, type SelectionSignals } from "@/lib/domain/quiz";
import type { ConceptMasteryView } from "@/lib/domain/mastery";
import { makeConcept, makeProject, makeUser, resetDatabase } from "./helpers";

describe("mastery model", () => {
  beforeEach(resetDatabase);

  async function setup() {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    const concept = await makeConcept(project.id, "Retrieval Practice");
    return { user, project, concept };
  }

  it("raises mastery on a correct answer and lowers it on a wrong one", async () => {
    const { user, project, concept } = await setup();

    const up = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 1, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });
    expect(up.level).toBeGreaterThan(up.previousLevel);

    const down = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 0, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });
    expect(down.level).toBeLessThan(down.previousLevel);
  });

  it("rewards a hard correct answer more than an easy one", async () => {
    const { user, project } = await setup();
    const easyConcept = await makeConcept(project.id, "Easy Concept");
    const hardConcept = await makeConcept(project.id, "Hard Concept");

    const easy = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: easyConcept.id,
      evidence: { score: 1, difficulty: "EASY", source: "QUIZ_MCQ" },
    });
    const hard = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: hardConcept.id,
      evidence: { score: 1, difficulty: "HARD", source: "QUIZ_MCQ" },
    });

    expect(hard.level).toBeGreaterThan(easy.level);
  });

  it("penalises an easy wrong answer more than a hard wrong answer", async () => {
    const { user, project } = await setup();
    const easyConcept = await makeConcept(project.id, "Easy Miss");
    const hardConcept = await makeConcept(project.id, "Hard Miss");

    const easy = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: easyConcept.id,
      evidence: { score: 0, difficulty: "EASY", source: "QUIZ_MCQ" },
    });
    const hard = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: hardConcept.id,
      evidence: { score: 0, difficulty: "HARD", source: "QUIZ_MCQ" },
    });

    expect(easy.level).toBeLessThan(hard.level);
  });

  it("weights a tutor interaction far less than an assessment", async () => {
    const { user, project } = await setup();
    const tutorConcept = await makeConcept(project.id, "Tutor Only");
    const quizConcept = await makeConcept(project.id, "Quiz Answer");

    const tutor = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: tutorConcept.id,
      evidence: { score: 1, difficulty: "MEDIUM", source: "TUTOR" },
    });
    const quiz = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: quizConcept.id,
      evidence: { score: 1, difficulty: "MEDIUM", source: "QUIZ_OPEN" },
    });

    expect(Math.abs(tutor.delta)).toBeLessThan(Math.abs(quiz.delta));
    // A tutor exchange is engagement, not proof — it must not count as an attempt.
    const record = await db.mastery.findUnique({
      where: { projectId_conceptId: { projectId: project.id, conceptId: tutorConcept.id } },
    });
    expect(record?.attemptCount).toBe(0);
  });

  it("becomes more stable as evidence accumulates", async () => {
    const { user, project, concept } = await setup();

    const first = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 1, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });
    const firstJump = Math.abs(first.delta);

    for (let i = 0; i < 8; i += 1) {
      await applyEvidence({
        projectId: project.id,
        userId: user.id,
        conceptId: concept.id,
        evidence: { score: 1, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
      });
    }

    const later = await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 1, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });

    // A single answer must not swing a well-evidenced estimate.
    expect(Math.abs(later.delta)).toBeLessThan(firstJump);
    expect(later.confidence).toBeGreaterThan(first.confidence);
  });

  it("stays within 0 and 1 under sustained evidence in either direction", async () => {
    const { user, project, concept } = await setup();
    for (let i = 0; i < 30; i += 1) {
      const result = await applyEvidence({
        projectId: project.id,
        userId: user.id,
        conceptId: concept.id,
        evidence: { score: 1, difficulty: "HARD", source: "QUIZ_OPEN" },
      });
      expect(result.level).toBeGreaterThanOrEqual(0);
      expect(result.level).toBeLessThanOrEqual(1);
    }
    for (let i = 0; i < 30; i += 1) {
      const result = await applyEvidence({
        projectId: project.id,
        userId: user.id,
        conceptId: concept.id,
        evidence: { score: 0, difficulty: "EASY", source: "QUIZ_MCQ" },
      });
      expect(result.level).toBeGreaterThanOrEqual(0);
      expect(result.level).toBeLessThanOrEqual(1);
    }
  });

  it("writes a snapshot per update so growth can be computed", async () => {
    const { user, project, concept } = await setup();
    await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 1, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });
    await applyEvidence({
      projectId: project.id,
      userId: user.id,
      conceptId: concept.id,
      evidence: { score: 0, difficulty: "MEDIUM", source: "QUIZ_MCQ" },
    });
    const snapshots = await db.masterySnapshot.count({ where: { conceptId: concept.id } });
    expect(snapshots).toBe(2);
  });

  it("classifies trend and keeps the project rollup in step", async () => {
    const { user, project, concept } = await setup();
    for (let i = 0; i < 4; i += 1) {
      await applyEvidence({
        projectId: project.id,
        userId: user.id,
        conceptId: concept.id,
        evidence: { score: 1, difficulty: "HARD", source: "QUIZ_OPEN" },
      });
    }
    await recalculateTrends(project.id);

    const record = await db.mastery.findFirstOrThrow({ where: { conceptId: concept.id } });
    expect(record.trend).toBe("IMPROVING");

    const updated = await db.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(updated.masteryAvg).toBeCloseTo(record.level, 5);
    expect(updated.conceptCount).toBe(1);
  });

  it("ranks weak, important concepts first", async () => {
    const { user, project } = await setup();
    const weak = await makeConcept(project.id, "Weak Important", 0.9);
    const strong = await makeConcept(project.id, "Strong", 0.9);

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

    const weakest = await getWeakConcepts(project.id, 3);
    expect(weakest[0].name).toBe("Weak Important");
  });
});

describe("adaptive question selection", () => {
  function concept(overrides: Partial<ConceptMasteryView>): ConceptMasteryView {
    return {
      conceptId: overrides.conceptId ?? "c1",
      name: overrides.name ?? "Concept",
      slug: "concept",
      description: "",
      level: overrides.level ?? 0.5,
      previousLevel: overrides.previousLevel ?? 0.5,
      confidence: overrides.confidence ?? 0.5,
      trend: overrides.trend ?? "STABLE",
      evidenceCount: overrides.evidenceCount ?? 3,
      attemptCount: overrides.attemptCount ?? 3,
      correctCount: overrides.correctCount ?? 2,
      accuracy: overrides.accuracy ?? 0.66,
      importance: overrides.importance ?? 0.8,
    };
  }

  function signals(overrides: Partial<SelectionSignals> = {}): SelectionSignals {
    return {
      mastery: overrides.mastery ?? [concept({})],
      askedConceptIds: overrides.askedConceptIds ?? [],
      recentOutcomes: overrides.recentOutcomes ?? [],
      lastTestedAt: overrides.lastTestedAt ?? new Map(),
      questionIndex: overrides.questionIndex ?? 0,
      plannedCount: overrides.plannedCount ?? 5,
      focusConceptIds: overrides.focusConceptIds ?? [],
    };
  }

  it("prefers the concept with the most uncertainty over one already mastered", () => {
    const selection = selectNextQuestion(
      signals({
        mastery: [
          concept({ conceptId: "mastered", name: "Mastered", level: 0.95, confidence: 0.9 }),
          concept({ conceptId: "uncertain", name: "Uncertain", level: 0.5, confidence: 0.3 }),
        ],
      }),
    );
    expect(selection?.concept.conceptId).toBe("uncertain");
  });

  it("does not keep asking about the same concept within one quiz", () => {
    const selection = selectNextQuestion(
      signals({
        mastery: [
          concept({ conceptId: "a", name: "A", level: 0.5 }),
          concept({ conceptId: "b", name: "B", level: 0.5 }),
        ],
        askedConceptIds: ["a", "a", "a"],
      }),
    );
    expect(selection?.concept.conceptId).toBe("b");
  });

  it("is not a simple wrong-to-easy, right-to-hard rule", () => {
    const base = signals({
      mastery: [concept({ level: 0.5, confidence: 0.6 })],
      recentOutcomes: [],
    });
    const neutral = selectNextQuestion(base);

    // A single wrong answer must not move the difficulty.
    const oneWrong = selectNextQuestion({ ...base, recentOutcomes: [false] });
    expect(oneWrong?.difficulty).toBe(neutral?.difficulty);

    // A single correct answer must not move it either.
    const oneRight = selectNextQuestion({ ...base, recentOutcomes: [true] });
    expect(oneRight?.difficulty).toBe(neutral?.difficulty);
  });

  it("raises difficulty only after a run of correct answers", () => {
    const base = signals({ mastery: [concept({ level: 0.5, confidence: 0.6 })] });
    const neutral = selectNextQuestion(base);
    const afterRun = selectNextQuestion({ ...base, recentOutcomes: [true, true, true] });

    const order = ["EASY", "MEDIUM", "HARD"];
    expect(order.indexOf(afterRun!.difficulty)).toBeGreaterThan(order.indexOf(neutral!.difficulty));
    expect(afterRun?.reason).toContain("correct in a row");
  });

  it("eases difficulty after a run of incorrect answers", () => {
    const base = signals({ mastery: [concept({ level: 0.8, confidence: 0.7 })] });
    const neutral = selectNextQuestion(base);
    const afterRun = selectNextQuestion({ ...base, recentOutcomes: [false, false, false] });

    const order = ["EASY", "MEDIUM", "HARD"];
    expect(order.indexOf(afterRun!.difficulty)).toBeLessThan(order.indexOf(neutral!.difficulty));
  });

  it("includes an open-response question in any quiz of three or more", () => {
    const base = signals({ mastery: [concept({ level: 0.3, confidence: 0.2 })] });
    const types = [0, 1, 2].map(
      (index) => selectNextQuestion({ ...base, questionIndex: index })?.type,
    );
    expect(types).toContain("OPEN");
  });

  it("honours a requested focus concept", () => {
    const selection = selectNextQuestion(
      signals({
        mastery: [
          concept({ conceptId: "a", name: "A", level: 0.5, importance: 0.9 }),
          concept({ conceptId: "focus", name: "Focus", level: 0.85, importance: 0.3 }),
        ],
        focusConceptIds: ["focus"],
      }),
    );
    expect(selection?.concept.conceptId).toBe("focus");
    expect(selection?.reason).toContain("requested focus");
  });

  it("explains why it chose what it chose", () => {
    const selection = selectNextQuestion(signals({}));
    expect(selection?.reason.length).toBeGreaterThan(5);
  });

  it("returns null when there is nothing to ask about", () => {
    expect(selectNextQuestion(signals({ mastery: [] }))).toBeNull();
  });
});

afterAll(async () => {
  await db.$disconnect();
});
