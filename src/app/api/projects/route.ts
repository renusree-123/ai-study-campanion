import { z } from "zod";
import { db } from "@/lib/db";
import { created, handler, ok, parseBody, parseQuery } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertSpaceAccess } from "@/lib/auth/ownership";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";

const createSchema = z.object({
  spaceId: z.string().min(1),
  name: z.string().min(2).max(90).trim(),
  description: z.string().max(600).default(""),
  goal: z.string().max(400).default(""),
});

const querySchema = z.object({ spaceId: z.string().optional() });

export const GET = handler(async (request: Request) => {
  const user = await requireUser();
  const query = parseQuery(request, querySchema);

  const projects = await db.project.findMany({
    where: {
      userId: user.id,
      archivedAt: null,
      ...(query.spaceId ? { spaceId: query.spaceId } : {}),
    },
    orderBy: [{ lastAccessedAt: "desc" }, { createdAt: "desc" }],
    include: { space: { select: { id: true, name: true } } },
  });
  return ok(projects);
});

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, createSchema);

  // Ownership of the parent is verified before anything is written.
  await assertSpaceAccess(user.id, body.spaceId);

  const project = await db.project.create({
    data: {
      spaceId: body.spaceId,
      userId: user.id,
      name: body.name,
      description: body.description,
      goal: body.goal,
      lastAccessedAt: new Date(),
    },
  });

  // A stated goal is durable context the tutor should carry from turn one.
  if (body.goal.trim()) {
    const { upsertContextItem } = await import("@/lib/domain/learning-context");
    await upsertContextItem({
      userId: user.id,
      projectId: project.id,
      kind: "GOAL",
      content: body.goal.trim(),
      source: "USER",
      salience: 0.95,
      confidence: 1,
      dedupeKey: `GOAL:project:${project.id}`,
    });
  }

  await recordActivity({
    userId: user.id,
    spaceId: body.spaceId,
    projectId: project.id,
    type: "PROJECT_CREATED",
    summary: `Created project "${project.name}"`,
  });
  await publish(
    "PROJECT_CREATED",
    { projectId: project.id, spaceId: body.spaceId },
    { userId: user.id, projectId: project.id },
  );

  return created(project);
});
