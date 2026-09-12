import { db } from "@/lib/db";
import { handler, ok } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";
import { assertConversationAccess } from "@/lib/auth/ownership";
import { parseJson } from "@/lib/json";

type Params = { params: Promise<{ conversationId: string }> };

export const GET = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { conversationId } = await params;
  await assertConversationAccess(user.id, conversationId);

  const messages = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  return ok(
    messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      grounding: message.grounding,
      citations: parseJson<unknown[]>(message.citations, []),
      createdAt: message.createdAt,
      latencyMs: message.latencyMs,
      model: message.model,
      status: message.status,
    })),
  );
});

export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const user = await requireUser();
  const { conversationId } = await params;
  await assertConversationAccess(user.id, conversationId);
  await db.conversation.delete({ where: { id: conversationId } });
  return ok({ deleted: true });
});
