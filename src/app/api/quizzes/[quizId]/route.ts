import { db } from "@/lib/db";
import { handler, ok } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertQuizAccess } from "@/lib/auth/ownership";
import { parseJson } from "@/lib/json";

type Params = { params: Promise<{ quizId: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { quizId } = await params;
  await assertQuizAccess(user.id, quizId);

  const quiz = await db.quiz.findUniqueOrThrow({
    where: { id: quizId },
    include: {
      questions: {
        orderBy: { index: "asc" },
        include: { concept: { select: { id: true, name: true } }, answer: true },
      },
    },
  });

  return ok({
    id: quiz.id,
    status: quiz.status,
    plannedCount: quiz.plannedCount,
    answeredCount: quiz.answeredCount,
    correctCount: quiz.correctCount,
    score: quiz.score,
    questions: quiz.questions.map((question) => ({
      id: question.id,
      index: question.index,
      type: question.type,
      prompt: question.prompt,
      // The correct index is never sent until the question has been answered.
      options: parseJson<string[]>(question.options, []),
      difficulty: question.difficulty,
      concept: question.concept,
      selectionReason: question.selectionReason,
      sources: parseJson<{ label: string }[]>(question.sources, []),
      answered: Boolean(question.answer),
      answer: question.answer
        ? {
            isCorrect: question.answer.isCorrect,
            score: question.answer.score,
            feedback: question.answer.feedback,
            selectedIndex: question.answer.selectedIndex,
            rawAnswer: question.answer.rawAnswer,
            coveredPoints: parseJson<string[]>(question.answer.coveredPoints, []),
            missingPoints: parseJson<string[]>(question.answer.missingPoints, []),
            correctIndex: question.correctIndex,
            explanation: question.explanation,
          }
        : null,
    })),
  });
});
