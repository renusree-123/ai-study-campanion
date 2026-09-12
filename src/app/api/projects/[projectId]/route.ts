import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { recordActivity } from "@/lib/activity";

const patchSchema = z.object({
  name: z.string().min(2).max(90).trim().optional(),
  description: z.string().max(600).optional(),
  goal: z.string().max(400).optional(),
});

type Params = { params: Promise<{ projectId: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      space: { select: { id: true, name: true } },
      _count: { select: { materials: true, conversations: true, quizzes: true, concepts: true } },
    },
  });
  return ok(project);
});

export const PATCH = handler(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const body = await parseBody(request, patchSchema);
  const project = await db.project.update({ where: { id: projectId }, data: body });

  if (body.goal !== undefined && body.goal.trim()) {
    const { upsertContextItem } = await import("@/lib/domain/learning-context");
    await upsertContextItem({
      userId: user.id,
      projectId,
      kind: "GOAL",
      content: body.goal.trim(),
      source: "USER",
      salience: 0.95,
      confidence: 1,
      dedupeKey: `GOAL:project:${projectId}`,
    });
  }

  await recordActivity({
    userId: user.id,
    projectId,
    spaceId: project.spaceId,
    type: "PROJECT_UPDATED",
    summary: `Updated project "${project.name}"`,
  });
  return ok(project);
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);
  await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
  return ok({ archived: true });
});
