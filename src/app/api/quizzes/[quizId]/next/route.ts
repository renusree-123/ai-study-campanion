import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { handler, ok } from "@/lib/http";
import { newTraceId } from "@/lib/logger";
import { parseJson } from "@/lib/json";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess, assertQuizAccess } from "@/lib/auth/ownership";
import { generateNextQuestion } from "@/lib/domain/quiz";

type Params = { params: Promise<{ quizId: string }> };

/**
 * Returns the next question, generating it if needed.
 *
 * Idempotent: if an unanswered question already exists it is returned rather
 * than a new one being generated, so a reload or a double-click costs nothing
 * and cannot skip the learner ahead.
 */
export const POST = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { quizId } = await params;
  const quiz = await assertQuizAccess(user.id, quizId);

  if (quiz.status !== "ACTIVE") {
    throw new AppError("CONFLICT", "This quiz has already been completed.");
  }

  const answered = await db.quizAnswer.count({ where: { quizId } });
  if (answered >= quiz.plannedCount) {
    return ok({ finished: true, question: null });
  }

  const project = await assertProjectAccess(user.id, quiz.projectId);
  const question = await generateNextQuestion({
    quizId,
    project,
    userId: user.id,
    traceId: newTraceId(),
  });

  return ok({
    finished: false,
    question: {
      id: question.id,
      index: question.index,
      type: question.type,
      prompt: question.prompt,
      options: parseJson<string[]>(question.options, []),
      difficulty: question.difficulty,
      concept: question.concept ? { id: question.concept.id, name: question.concept.name } : null,
      selectionReason: question.selectionReason,
      sources: parseJson<{ label: string }[]>(question.sources, []),
    },
    progress: { answered, planned: quiz.plannedCount },
  });
});
