import Link from "next/link";
import { requireUserPage } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getGlobalAnalytics } from "@/lib/domain/analytics";
import { topRecommendationsForUser } from "@/lib/domain/recommendations";
import { parseJson } from "@/lib/json";
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
import { ActivityList, RecommendationCard, TrendBadge } from "@/components/learning";

/**
 * Home dashboard (PRD §54, §55).
 *
 * Answers, in order: where was I, what is active, how am I doing, what needs
 * attention, and what should I do next.
 */
export default async function HomePage() {
  const user = await requireUserPage();

  const [analytics, recommendations, recentProjects, weakConcepts, activity, lastActivity] =
    await Promise.all([
      getGlobalAnalytics(user.id, 30),
      topRecommendationsForUser(user.id, 2),
      db.project.findMany({
        where: { userId: user.id, archivedAt: null },
        orderBy: [{ lastAccessedAt: "desc" }, { updatedAt: "desc" }],
        take: 4,
        include: { space: { select: { id: true, name: true } } },
      }),
      db.mastery.findMany({
        where: { userId: user.id, level: { lt: 0.6 }, evidenceCount: { gt: 0 } },
        orderBy: { level: "asc" },
        take: 5,
        include: {
          concept: { select: { name: true } },
          project: { select: { id: true, name: true } },
        },
      }),
      db.activityEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { project: { select: { id: true, name: true } } },
      }),
      db.activityEvent.findFirst({
        where: { userId: user.id, projectId: { not: null } },
        orderBy: { createdAt: "desc" },
        include: { project: { select: { id: true, name: true } } },
      }),
    ]);

  const hasProjects = recentProjects.length > 0;

  if (!hasProjects) {
    return (
      <Card padding={28}>
        <EmptyState
          icon="📚"
          title="Start your first learning journey"
          body="Create a Space for a broad area you want to develop, then a Project inside it for a focused goal. Add a PDF and the tutor can start teaching from it."
          action={<Button href="/spaces">Create your first Space</Button>}
        />
      </Card>
    );
  }

  return (
    <ChartTheme>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 660, letterSpacing: "-0.025em" }}>
          Welcome back, {user.name.split(" ")[0]}
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
          {analytics.overall.currentStreak > 1
            ? `${analytics.overall.currentStreak} day learning streak · `
            : ""}
          {analytics.overall.projects} project{analytics.overall.projects === 1 ? "" : "s"} across{" "}
          {analytics.overall.spaces} space{analytics.overall.spaces === 1 ? "" : "s"}
        </p>
      </div>

      {/* Continue learning */}
      {lastActivity?.project ? (
        <Card padding={16} style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
            <div>
              <Badge tone="accent">Continue learning</Badge>
              <div style={{ fontSize: 14.5, fontWeight: 620, margin: "7px 0 2px" }}>
                {lastActivity.project.name}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                {lastActivity.summary} · {formatRelative(lastActivity.createdAt)}
              </div>
            </div>
            <Button href={`/projects/${lastActivity.project.id}`}>Resume →</Button>
          </div>
        </Card>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)", gap: 18, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 18 }}>
          {/* Overall progress */}
          <Card>
            <SectionTitle hint="Across every space and project">Overall progress</SectionTitle>
            <StatGrid min={130}>
              <Stat label="Avg mastery" value={formatPercent(analytics.performance.avgMastery)} />
              <Stat
                label="Assessment score"
                value={formatPercent(analytics.performance.avgAssessmentScore)}
                sub={`${analytics.aiUsage.questionsAsked} answered`}
              />
              <Stat
                label="Improving"
                value={analytics.performance.conceptsImproving}
                sub="concepts"
                tone="success"
              />
              <Stat
                label="Need attention"
                value={analytics.performance.conceptsNeedingAttention}
                sub="concepts"
                tone={analytics.performance.conceptsNeedingAttention > 0 ? "danger" : undefined}
              />
            </StatGrid>
          </Card>

          {/* Recent projects */}
          <Card>
            <SectionTitle action={<Button href="/spaces" variant="ghost" size="sm">All spaces →</Button>}>
              Recent projects
            </SectionTitle>
            <div style={{ display: "grid", gap: 11 }}>
              {recentProjects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  style={{
                    display: "block",
                    padding: 13,
                    border: "1px solid var(--border)",
                    borderRadius: 9,
                    background: "var(--surface-2)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 7 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.2, fontWeight: 600 }}>{project.name}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                        {project.space.name} · {project.materialCount} material
                        {project.materialCount === 1 ? "" : "s"} · {project.conceptCount} concepts
                      </div>
                    </div>
                    <span style={{ fontSize: 11.5, color: "var(--text-subtle)", whiteSpace: "nowrap" }}>
                      {formatRelative(project.lastAccessedAt ?? project.updatedAt)}
                    </span>
                  </div>
                  <MasteryMeter level={project.masteryAvg} />
                </Link>
              ))}
            </div>
          </Card>

          {/* Recent activity */}
          <Card>
            <SectionTitle>Recent activity</SectionTitle>
            <ActivityList events={activity} showProject />
          </Card>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          {/* Recommended next step */}
          {recommendations.length > 0 ? (
            <div style={{ display: "grid", gap: 12 }}>
              {recommendations.map((recommendation) => (
                <RecommendationCard
                  key={recommendation.id}
                  projectId={recommendation.projectId}
                  recommendation={{
                    id: recommendation.id,
                    title: recommendation.title,
                    body: recommendation.body,
                    actionType: recommendation.actionType,
                    actionPayload: parseJson<Record<string, unknown>>(recommendation.actionPayload, {}),
                    rationale: recommendation.rationale,
                  }}
                  compact
                />
              ))}
            </div>
          ) : null}

          {/* Areas to improve */}
          <Card>
            <SectionTitle hint="Lowest mastery with real evidence behind it">Areas to improve</SectionTitle>
            {weakConcepts.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                Nothing flagged yet. Take a quiz so mastery has evidence to work from.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 13 }}>
                {weakConcepts.map((mastery) => (
                  <div key={mastery.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 545 }}>{mastery.concept.name}</span>
                      <TrendBadge trend={mastery.trend} />
                    </div>
                    <MasteryMeter level={mastery.level} previous={mastery.previousLevel} />
                    <Link
                      href={`/projects/${mastery.project.id}`}
                      style={{ fontSize: 11, color: "var(--text-subtle)" }}
                    >
                      {mastery.project.name}
                    </Link>
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
