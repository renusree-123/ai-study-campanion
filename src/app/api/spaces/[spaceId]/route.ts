import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertSpaceAccess } from "@/lib/auth/ownership";
import { recordActivity } from "@/lib/activity";

const patchSchema = z.object({
  name: z.string().min(2).max(80).trim().optional(),
  description: z.string().max(500).optional(),
  color: z.enum(["indigo", "emerald", "amber", "rose", "sky", "violet"]).optional(),
  icon: z.string().max(24).optional(),
});

type Params = { params: Promise<{ spaceId: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { spaceId } = await params;
  await assertSpaceAccess(user.id, spaceId);

  const space = await db.space.findUniqueOrThrow({
    where: { id: spaceId },
    include: { projects: { where: { archivedAt: null }, orderBy: { lastAccessedAt: "desc" } } },
  });
  return ok(space);
});

export const PATCH = handler(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { spaceId } = await params;
  await assertSpaceAccess(user.id, spaceId);

  const body = await parseBody(request, patchSchema);
  const space = await db.space.update({ where: { id: spaceId }, data: body });

  await recordActivity({
    userId: user.id,
    spaceId,
    type: "SPACE_UPDATED",
    summary: `Updated space "${space.name}"`,
  });
  return ok(space);
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { spaceId } = await params;
  await assertSpaceAccess(user.id, spaceId);

  // Soft delete: archiving keeps the learner's history and analytics intact,
  // and a mis-click is recoverable.
  await db.space.update({ where: { id: spaceId }, data: { archivedAt: new Date() } });
  await db.project.updateMany({ where: { spaceId }, data: { archivedAt: new Date() } });

  return ok({ archived: true });
});
