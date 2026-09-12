import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { getProjectMastery } from "@/lib/domain/mastery";
import { activeRecommendations } from "@/lib/domain/recommendations";
import { listProjectContext } from "@/lib/domain/learning-context";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  Stat,
  StatGrid,
  formatPercent,
  formatRelative,
} from "@/components/ui";
import { ChartTheme, MasteryMeter } from "@/components/charts";
import {
  ActivityList,
  ConceptMasteryList,
  GroundingBadge,
  MaterialStatusBadge,
  RecommendationCard,
} from "@/components/learning";

/** Project dashboard (PRD §10). */
export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;
  const project = await assertProjectAccess(user.id, projectId);

  const [mastery, recommendations, context, materials, activity, answers, lastConversation, quizzes] =
    await Promise.all([
      getProjectMastery(projectId),
      activeRecommendations(projectId, 1),
      listProjectContext(user.id, projectId),
      db.material.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, filename: true, status: true, stage: true, progress: true },
      }),
      db.activityEvent.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      db.quizAnswer.findMany({
        where: { quiz: { projectId } },
        orderBy: { answeredAt: "desc" },
        take: 40,
        select: { isCorrect: true, score: true },
      }),
      db.conversation.findFirst({
        where: { projectId },
        orderBy: { lastMessageAt: "desc" },
        include: {
          messages: {
            where: { role: "assistant" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { content: true, grounding: true, createdAt: true },
          },
        },
      }),
      db.quiz.count({ where: { projectId, status: "COMPLETED" } }),
    ]);

  const avgMastery =
    mastery.length > 0 ? mastery.reduce((s, m) => s + m.level, 0) / mastery.length : 0;
  const accuracy =
    answers.length > 0 ? answers.filter((a) => a.isCorrect).length / answers.length : 0;
  // Compare the most recent ten answers against the ten before them.
  const recent = answers.slice(0, 10);
  const earlier = answers.slice(10, 20);
  const recentAccuracy =
    recent.length > 0 ? recent.filter((a) => a.isCorrect).length / recent.length : 0;
  const earlierAccuracy =
    earlier.length > 0 ? earlier.filter((a) => a.isCorrect).length / earlier.length : 0;
  const improvement = earlier.length > 0 ? recentAccuracy - earlierAccuracy : 0;

  const needsAttention = mastery.filter(
    (m) => m.trend === "NEEDS_ATTENTION" || (m.level < 0.5 && m.evidenceCount > 0),
  );
  const readyMaterials = materials.filter((m) => m.status === "READY").length;

  if (materials.length === 0) {
    return (
      <Card padding={28}>
        <EmptyState
          icon="📄"
          title="Add a material to begin"
          body="The tutor and the quiz both work from your own documents. Upload a PDF — it will be read, indexed and broken into concepts in the background, and you can keep using the app while that happens."
          action={<Button href={`/projects/${projectId}/materials`}>Upload a PDF</Button>}
        />
      </Card>
    );
  }

  return (
    <ChartTheme>
      {/* Progress */}
      <Card style={{ marginBottom: 18 }}>
        <StatGrid min={145}>
          <Stat
            label="Overall mastery"
            value={formatPercent(avgMastery)}
            sub={`${mastery.length} concepts`}
          />
          <Stat
            label="Assessment accuracy"
            value={answers.length > 0 ? formatPercent(accuracy) : "—"}
            sub={
              earlier.length > 0
                ? `${improvement >= 0 ? "+" : ""}${Math.round(improvement * 100)} pts recently`
                : `${answers.length} answered`
            }
            tone={earlier.length > 0 ? (improvement >= 0 ? "success" : "danger") : undefined}
          />
          <Stat label="Quizzes completed" value={quizzes} />
          <Stat
            label="Need attention"
            value={needsAttention.length}
            sub="concepts"
            tone={needsAttention.length > 0 ? "danger" : undefined}
          />
        </StatGrid>
      </Card>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(290px, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 18 }}>
          {/* Concepts */}
          <Card>
            <SectionTitle
              hint="Estimated from your quiz answers and tutor activity"
              action={
                <Button href={`/projects/${projectId}/growth`} variant="ghost" size="sm">
                  Growth →
                </Button>
              }
            >
              Concepts
            </SectionTitle>
            <ConceptMasteryList concepts={mastery} limit={6} />
          </Card>

          {/* Continue learning */}
          {lastConversation?.messages[0] ? (
            <Card>
              <SectionTitle
                action={
                  <Button href={`/projects/${projectId}/tutor`} variant="ghost" size="sm">
                    Open tutor →
                  </Button>
                }
              >
                Continue learning
              </SectionTitle>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <span style={{ fontSize: 12.5, fontWeight: 570 }}>{lastConversation.title}</span>
                <GroundingBadge grounding={lastConversation.messages[0].grounding} />
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: 12.7,
                  color: "var(--text-muted)",
                  lineHeight: 1.6,
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {lastConversation.messages[0].content}
              </p>
              <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 7 }}>
                {formatRelative(lastConversation.messages[0].createdAt)}
              </div>
            </Card>
          ) : null}

          {/* Recent activity */}
          <Card>
            <SectionTitle>Recent activity</SectionTitle>
            <ActivityList events={activity} />
          </Card>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          {/* Recommended next step */}
          {recommendations.length > 0 ? (
            <RecommendationCard projectId={projectId} recommendation={recommendations[0]} />
          ) : (
            <Card>
              <SectionTitle>Recommended next step</SectionTitle>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 12px", lineHeight: 1.6 }}>
                A recommendation is generated in the background after you take a quiz or add a
                material. Take a short quiz to produce your first one.
              </p>
              <Button href={`/projects/${projectId}/quiz`} size="sm">
                Take a quiz
              </Button>
            </Card>
          )}

          {/* Materials */}
          <Card>
            <SectionTitle
              action={
                <Button href={`/projects/${projectId}/materials`} variant="ghost" size="sm">
                  Manage →
                </Button>
              }
            >
              Materials
            </SectionTitle>
            <div style={{ display: "grid", gap: 9 }}>
              {materials.map((material) => (
                <div
                  key={material.id}
                  style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "center" }}
                >
                  <span
                    style={{
                      fontSize: 12.3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={material.filename}
                  >
                    {material.filename}
                  </span>
                  <MaterialStatusBadge status={material.status} stage={material.stage} />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 10 }}>
              {readyMaterials} of {materials.length} ready for the tutor
            </div>
          </Card>

          {/* Learning context */}
          <Card>
            <SectionTitle hint="What the companion has learned about how you learn">
              Learning context
            </SectionTitle>
            {context.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                Nothing recorded yet. Your goal, preferences and recurring difficulties are picked up
                from your conversations and quiz results, and carried into future sessions.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 9 }}>
                {context.slice(0, 6).map((item) => (
                  <div key={item.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <Badge
                      tone={
                        item.kind === "GOAL"
                          ? "accent"
                          : item.kind === "STRENGTH"
                            ? "success"
                            : item.kind === "WEAKNESS" || item.kind === "DIFFICULTY"
                              ? "warning"
                              : "default"
                      }
                    >
                      {item.kind.toLowerCase()}
                    </Badge>
                    <span style={{ fontSize: 12.2, lineHeight: 1.55, flex: 1 }}>{item.content}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </ChartTheme>
  );
}
