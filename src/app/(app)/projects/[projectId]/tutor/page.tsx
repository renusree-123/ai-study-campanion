import { Suspense } from "react";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { TutorPanel, type Citation } from "@/components/tutor";
import { Card } from "@/components/ui";

export default async function TutorPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const [conversations, readyMaterials] = await Promise.all([
    db.conversation.findMany({
      where: { projectId },
      orderBy: { lastMessageAt: "desc" },
      take: 30,
    }),
    db.material.count({ where: { projectId, status: "READY" } }),
  ]);

  const active = conversations[0] ?? null;
  const messages = active
    ? await db.message.findMany({
        where: { conversationId: active.id },
        orderBy: { createdAt: "asc" },
        take: 200,
      })
    : [];

  return (
    <Suspense fallback={<Card padding={40}>Loading the tutor…</Card>}>
      <TutorPanel
        projectId={projectId}
        hasMaterials={readyMaterials > 0}
        activeId={active?.id ?? null}
        conversations={conversations.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          messageCount: conversation.messageCount,
          lastMessageAt: conversation.lastMessageAt.toISOString(),
        }))}
        initialMessages={messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          grounding: message.grounding,
          citations: parseJson<Citation[]>(message.citations, []),
          createdAt: message.createdAt.toISOString(),
          latencyMs: message.latencyMs,
          model: message.model,
          status: message.status,
        }))}
      />
    </Suspense>
  );
}
