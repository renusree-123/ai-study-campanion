import { z } from "zod";
import { db } from "@/lib/db";
import { created, handler, ok, parseBody } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";

const createSchema = z.object({
  name: z.string().min(2).max(80).trim(),
  description: z.string().max(500).default(""),
  color: z.enum(["indigo", "emerald", "amber", "rose", "sky", "violet"]).default("indigo"),
  icon: z.string().max(24).default("book"),
});

export const GET = handler(async () => {
  const user = await requireUser();
  const spaces = await db.space.findMany({
    where: { userId: user.id, archivedAt: null },
    orderBy: [{ lastAccessedAt: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { projects: true } } },
  });
  return ok(spaces);
});

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  const body = await parseBody(request, createSchema);

  const space = await db.space.create({
    data: { ...body, userId: user.id, lastAccessedAt: new Date() },
  });

  await recordActivity({
    userId: user.id,
    spaceId: space.id,
    type: "SPACE_CREATED",
    summary: `Created space "${space.name}"`,
  });
  await publish("SPACE_CREATED", { spaceId: space.id }, { userId: user.id });

  return created(space);
});
