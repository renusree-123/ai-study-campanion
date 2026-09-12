import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { getGlobalAnalytics } from "@/lib/domain/analytics";
import { db } from "@/lib/db";
import {
  Card,
  EmptyState,
  SectionTitle,
  Stat,
  StatGrid,
  formatCost,
  formatPercent,
  formatRelative,
} from "@/components/ui";
import { BarChart, ChartTheme, LineChart, MasteryMeter } from "@/components/charts";
import { TrendBadge } from "@/components/learning";

/** Global user analytics (PRD §35, §36). */
export default async function GlobalAnalyticsPage() {
  const user = await requireUser();

  const [analytics, weakest, strongest] = await Promise.all([
    getGlobalAnalytics(user.id, 30),
    db.mastery.findMany({
      where: { userId: user.id, evidenceCount: { gt: 0 } },
      orderBy: { level: "asc" },
      take: 6,
      include: {
        concept: { select: { name: true } },
        project: { select: { id: true, name: true } },
      },
    }),
    db.mastery.findMany({
      where: { userId: user.id, evidenceCount: { gt: 0 } },
      orderBy: { level: "desc" },
      take: 6,
      include: {
        concept: { select: { name: true } },
        project: { select: { id: true, name: true } },
      },
    }),
  ]);

  if (analytics.overall.projects === 0) {
    return (
      <Card padding={28}>
        <EmptyState
          icon="📊"
          title="Nothing to analyse yet"
          body="Create a space and a project, add a material, and your learning analytics will build up from there."
        />
      </Card>
    );
  }

  return (
    <ChartTheme>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 660, letterSpacing: "-0.025em" }}>
          Analytics
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
          Everything across your spaces and projects, over the last 30 days.
        </p>
      </div>

      <div style={{ display: "grid", gap: 18 }}>
        <Card>
          <SectionTitle>Overall learning</SectionTitle>
          <StatGrid min={135}>
            <Stat label="Spaces" value={analytics.overall.spaces} />
            <Stat label="Projects" value={analytics.overall.projects} />
            <Stat label="Materials" value={analytics.overall.materials} />
            <Stat label="Active days" value={analytics.overall.activeDays} />
            <Stat
              label="Current streak"
              value={analytics.overall.currentStreak}
              sub="days"
              tone={analytics.overall.currentStreak > 2 ? "success" : undefined}
            />
            <Stat label="Total activity" value={analytics.overall.totalActivity} sub="events" />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle>Learning performance</SectionTitle>
          <StatGrid min={135}>
            <Stat label="Overall mastery" value={formatPercent(analytics.performance.avgMastery)} />
            <Stat
              label="Assessment score"
              value={
                analytics.aiUsage.questionsAsked > 0
                  ? formatPercent(analytics.performance.avgAssessmentScore)
                  : "—"
              }
            />
            <Stat label="Improving" value={analytics.performance.conceptsImproving} sub="concepts" tone="success" />
            <Stat
              label="Need attention"
              value={analytics.performance.conceptsNeedingAttention}
              sub="concepts"
              tone={analytics.performance.conceptsNeedingAttention > 0 ? "danger" : undefined}
            />
            <Stat label="Total concepts" value={analytics.performance.totalConcepts} />
          </StatGrid>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Tutor questions asked per day">Learning activity over time</SectionTitle>
            <BarChart
              data={analytics.daily.map((d) => ({ label: d.day, value: d.tutorMessages }))}
              emptyMessage="No tutor activity in this period"
            />
          </Card>

          <Card>
            <SectionTitle hint="Average across every concept you are tracking">Mastery over time</SectionTitle>
            <LineChart
              data={analytics.daily.map((d) => ({ label: d.day, value: d.avgMastery }))}
              format="percent"
              yMax={1}
              emptyMessage="No mastery history yet"
            />
          </Card>

          <Card>
            <SectionTitle hint="Questions answered per day">Assessment activity</SectionTitle>
            <BarChart
              data={analytics.daily.map((d) => ({ label: d.day, value: d.questionsAnswered }))}
              emptyMessage="No assessments in this period"
            />
          </Card>

          <Card>
            <SectionTitle hint="Proportion correct per day">Assessment performance</SectionTitle>
            <LineChart
              data={analytics.daily
                .filter((d) => d.questionsAnswered > 0)
                .map((d) => ({ label: d.day, value: d.correctAnswers / d.questionsAnswered }))}
              format="percent"
              yMax={1}
              emptyMessage="No assessments in this period"
            />
          </Card>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle>Weakest concepts</SectionTitle>
            {weakest.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                No assessment evidence yet.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {weakest.map((mastery) => (
                  <div key={mastery.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 545 }}>{mastery.concept.name}</span>
                      <TrendBadge trend={mastery.trend} />
                    </div>
                    <MasteryMeter level={mastery.level} previous={mastery.previousLevel} />
                    <Link href={`/projects/${mastery.project.id}`} style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                      {mastery.project.name}
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle>Strongest concepts</SectionTitle>
            {strongest.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                No assessment evidence yet.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {strongest.map((mastery) => (
                  <div key={mastery.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 545 }}>{mastery.concept.name}</span>
                      <TrendBadge trend={mastery.trend} />
                    </div>
                    <MasteryMeter level={mastery.level} previous={mastery.previousLevel} />
                    <Link href={`/projects/${mastery.project.id}`} style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                      {mastery.project.name}
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card>
          <SectionTitle hint="How much of the AI layer you are using">AI usage</SectionTitle>
          <StatGrid min={135}>
            <Stat label="Tutor interactions" value={analytics.aiUsage.tutorInteractions} />
            <Stat label="Questions answered" value={analytics.aiUsage.questionsAsked} />
            <Stat label="Quizzes completed" value={analytics.aiUsage.quizzesCompleted} />
            <Stat label="AI feedback given" value={analytics.aiUsage.aiFeedbackGenerated} />
            <Stat label="AI requests" value={analytics.aiUsage.requests} sub="last 30 days" />
            <Stat label="Est. cost" value={formatCost(analytics.aiUsage.costUsd)} sub="last 30 days" />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle>Projects</SectionTitle>
          <div style={{ display: "grid", gap: 11 }}>
            {analytics.projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 180px", gap: 14, alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.8, fontWeight: 560 }}>{project.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                      {project.spaceName} · {formatRelative(project.lastAccessedAt)}
                    </div>
                  </div>
                  <MasteryMeter level={project.mastery} />
                </div>
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </ChartTheme>
  );
}
