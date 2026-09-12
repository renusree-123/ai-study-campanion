import { z } from "zod";
import { db } from "@/lib/db";
import { created, handler, ok, parseBody } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";

type Params = { params: Promise<{ projectId: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const conversations = await db.conversation.findMany({
    where: { projectId },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
  });
  return ok(conversations);
});

export const POST = handler(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { projectId } = await params;
  const project = await assertProjectAccess(user.id, projectId);

  const body = await parseBody(
    request,
    z.object({ title: z.string().max(120).optional() }),
  );

  const conversation = await db.conversation.create({
    data: { projectId, userId: user.id, title: body.title?.trim() || "New conversation" },
  });

  await recordActivity({
    userId: user.id,
    projectId,
    spaceId: project.spaceId,
    type: "CONVERSATION_STARTED",
    summary: "Started a tutor conversation",
    payload: { conversationId: conversation.id },
  });
  await publish(
    "CONVERSATION_STARTED",
    { conversationId: conversation.id, projectId },
    { userId: user.id, projectId },
  );

  return created(conversation);
});
