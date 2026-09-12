import { Suspense } from "react";
import { requireUserPage } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { db } from "@/lib/db";
import { QuizPanel } from "@/components/quiz";
import { Card } from "@/components/ui";

export default async function QuizPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireUserPage();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const [conceptCount, history] = await Promise.all([
    db.concept.count({ where: { projectId } }),
    db.quiz.findMany({
      where: { projectId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
      take: 6,
      select: {
        id: true,
        score: true,
        answeredCount: true,
        correctCount: true,
        completedAt: true,
      },
    }),
  ]);

  return (
    <Suspense fallback={<Card padding={40}>Loading…</Card>}>
      <QuizPanel
        projectId={projectId}
        conceptCount={conceptCount}
        history={history.map((quiz) => ({
          ...quiz,
          completedAt: quiz.completedAt?.toISOString() ?? null,
        }))}
      />
    </Suspense>
  );
}
