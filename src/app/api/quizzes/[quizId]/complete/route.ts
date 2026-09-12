import { db } from "@/lib/db";
import { handler, ok } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertQuizAccess } from "@/lib/auth/ownership";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";

type Params = { params: Promise<{ quizId: string }> };

/**
 * Marks a quiz complete and hands off to the background workflow chain:
 * finalise -> recalculate mastery trends -> generate insight -> recommend.
 * Idempotent — completing twice publishes the same deduped event.
 */
export const POST = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { quizId } = await params;
  const quiz = await assertQuizAccess(user.id, quizId);

  const answers = await db.quizAnswer.findMany({ where: { quizId }, select: { score: true, isCorrect: true } });
  const score =
    answers.length > 0 ? answers.reduce((sum, a) => sum + a.score, 0) / answers.length : 0;

  if (quiz.status === "ACTIVE") {
    await db.quiz.update({
      where: { id: quizId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        answeredCount: answers.length,
        correctCount: answers.filter((a) => a.isCorrect).length,
        score,
      },
    });

    await recordActivity({
      userId: user.id,
      projectId: quiz.projectId,
      type: "QUIZ_COMPLETED",
      summary: `Completed a quiz — ${Math.round(score * 100)}% (${answers.filter((a) => a.isCorrect).length}/${answers.length})`,
      payload: { quizId, score },
    });
  }

  await publish(
    "QUIZ_COMPLETED",
    { quizId, projectId: quiz.projectId, score },
    { userId: user.id, projectId: quiz.projectId },
  );

  return ok({
    completed: true,
    score,
    answered: answers.length,
    correct: answers.filter((a) => a.isCorrect).length,
  });
});
