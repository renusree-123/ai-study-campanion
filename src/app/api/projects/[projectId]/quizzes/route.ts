import { z } from "zod";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { created, handler, ok, parseBody } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";

type Params = { params: Promise<{ projectId: string }> };

const startSchema = z.object({
  questionCount: z.number().int().min(3).max(15).default(5),
  focusConceptIds: z.array(z.string()).max(5).default([]),
});

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const quizzes = await db.quiz.findMany({
    where: { projectId },
    orderBy: { startedAt: "desc" },
    take: 20,
    include: { _count: { select: { questions: true, answers: true } } },
  });
  return ok(quizzes);
});

export const POST = handler(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  const project = await assertProjectAccess(user.id, projectId);
  const body = await parseBody(request, startSchema);

  const conceptCount = await db.concept.count({ where: { projectId } });
  if (conceptCount === 0) {
    throw new AppError("CONFLICT", "No concepts available to quiz on.", {
      userMessage:
        "This project has no concepts yet. Upload a material and wait for processing to finish, then start a quiz.",
    });
  }

  // Resume rather than stack: an abandoned in-progress quiz is returned as-is
  // so a double-click or a reload cannot create parallel attempts (PRD §50).
  const active = await db.quiz.findFirst({
    where: { projectId, userId: user.id, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
  });
  if (active) return ok({ ...active, resumed: true });

  // Only focus on concepts that actually belong to this project.
  const validFocus = body.focusConceptIds.length
    ? (
        await db.concept.findMany({
          where: { projectId, id: { in: body.focusConceptIds } },
          select: { id: true },
        })
      ).map((c) => c.id)
    : [];

  const quiz = await db.quiz.create({
    data: {
      projectId,
      userId: user.id,
      plannedCount: body.questionCount,
      mode: validFocus.length > 0 ? "CONCEPT_FOCUS" : "ADAPTIVE",
      focusConcepts: JSON.stringify(validFocus),
    },
  });

  await db.project.update({ where: { id: projectId }, data: { quizCount: { increment: 1 } } });

  await recordActivity({
    userId: user.id,
    projectId,
    spaceId: project.spaceId,
    type: "QUIZ_STARTED",
    summary: `Started a ${body.questionCount}-question adaptive quiz`,
    payload: { quizId: quiz.id },
  });
  await publish("QUIZ_STARTED", { quizId: quiz.id, projectId }, { userId: user.id, projectId });

  return created(quiz);
});
