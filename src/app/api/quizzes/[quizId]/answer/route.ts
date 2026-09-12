import { z } from "zod";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { handler, ok, parseBody } from "@/lib/http";
import { newTraceId } from "@/lib/logger";
import { requireUser } from "@/lib/auth/session";
import { assertQuizAccess } from "@/lib/auth/ownership";
import { evaluateAnswer } from "@/lib/domain/quiz";
import { applyEvidence, type Difficulty } from "@/lib/domain/mastery";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";
import { truncate } from "@/lib/ai/text";

type Params = { params: Promise<{ quizId: string }> };

const schema = z.object({
  questionId: z.string().min(1),
  selectedIndex: z.number().int().min(0).max(9).nullable().default(null),
  answer: z.string().max(4000).default(""),
});

export const POST = handler(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { quizId } = await params;
  const quiz = await assertQuizAccess(user.id, quizId);
  const body = await parseBody(request, schema);
  const traceId = newTraceId();

  const question = await db.quizQuestion.findFirst({
    where: { id: body.questionId, quizId },
    include: { concept: true, answer: true },
  });
  if (!question) throw new AppError("NOT_FOUND", "Question not found in this quiz.");

  // Idempotency: an already-answered question returns its stored result rather
  // than being re-graded and double-counted into mastery (PRD §50).
  if (question.answer) {
    return ok({
      alreadyAnswered: true,
      result: {
        isCorrect: question.answer.isCorrect,
        score: question.answer.score,
        feedback: question.answer.feedback,
        coveredPoints: JSON.parse(question.answer.coveredPoints || "[]"),
        missingPoints: JSON.parse(question.answer.missingPoints || "[]"),
        correctIndex: question.correctIndex,
        explanation: question.explanation,
      },
    });
  }

  if (question.type === "MCQ" && body.selectedIndex === null) {
    throw new AppError("BAD_REQUEST", "Choose an option before submitting.");
  }
  if (question.type === "OPEN" && body.answer.trim().length === 0) {
    throw new AppError("BAD_REQUEST", "Write an answer before submitting.");
  }

  // Grading happens first, outside the transaction: it is the slow, failure-prone
  // step, and a grading failure must leave no partial state behind.
  const evaluation = await evaluateAnswer({
    question,
    conceptName: question.concept?.name ?? "General",
    rawAnswer: question.type === "MCQ" ? "" : body.answer,
    selectedIndex: body.selectedIndex,
    userId: user.id,
    projectId: quiz.projectId,
    traceId,
  });

  // Answer + mastery move together, so a crash cannot record one without the
  // other. The unique constraint on questionId is the concurrency guard.
  const masteryUpdate = await db.$transaction(async (tx) => {
    await tx.quizAnswer.create({
      data: {
        questionId: question.id,
        quizId,
        userId: user.id,
        rawAnswer: question.type === "MCQ" ? "" : body.answer,
        selectedIndex: body.selectedIndex,
        isCorrect: evaluation.isCorrect,
        score: evaluation.score,
        feedback: evaluation.feedback,
        coveredPoints: JSON.stringify(evaluation.coveredPoints),
        missingPoints: JSON.stringify(evaluation.missingPoints),
        evaluatedBy: evaluation.evaluatedBy,
        latencyMs: evaluation.latencyMs,
      },
    });

    await tx.quiz.update({
      where: { id: quizId },
      data: {
        answeredCount: { increment: 1 },
        correctCount: { increment: evaluation.isCorrect ? 1 : 0 },
      },
    });

    if (!question.conceptId) return null;
    return applyEvidence(
      {
        projectId: quiz.projectId,
        userId: user.id,
        conceptId: question.conceptId,
        evidence: {
          score: evaluation.score,
          difficulty: question.difficulty as Difficulty,
          source: question.type === "OPEN" ? "QUIZ_OPEN" : "QUIZ_MCQ",
        },
      },
      tx,
    );
  });

  await recordActivity({
    userId: user.id,
    projectId: quiz.projectId,
    type: "QUESTION_ANSWERED",
    summary: `${evaluation.isCorrect ? "Answered correctly" : "Missed a question"}: ${truncate(
      question.prompt,
      90,
    )}`,
    payload: { quizId, questionId: question.id, score: evaluation.score },
  });

  await publish(
    "QUESTION_ANSWERED",
    {
      quizId,
      questionId: question.id,
      projectId: quiz.projectId,
      conceptId: question.conceptId,
      score: evaluation.score,
      isCorrect: evaluation.isCorrect,
    },
    { userId: user.id, projectId: quiz.projectId },
  );

  const answered = await db.quizAnswer.count({ where: { quizId } });

  return ok({
    result: {
      isCorrect: evaluation.isCorrect,
      score: evaluation.score,
      feedback: evaluation.feedback,
      coveredPoints: evaluation.coveredPoints,
      missingPoints: evaluation.missingPoints,
      correctIndex: question.correctIndex,
      explanation: question.explanation,
      evaluatedBy: evaluation.evaluatedBy,
    },
    mastery: masteryUpdate
      ? {
          conceptId: masteryUpdate.conceptId,
          conceptName: question.concept?.name ?? "",
          previousLevel: masteryUpdate.previousLevel,
          level: masteryUpdate.level,
          delta: masteryUpdate.delta,
        }
      : null,
    progress: { answered, planned: quiz.plannedCount },
    finished: answered >= quiz.plannedCount,
  });
});
