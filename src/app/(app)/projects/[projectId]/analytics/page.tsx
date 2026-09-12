import { requireUserPage } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { getProjectAnalytics } from "@/lib/domain/analytics";
import {
  Card,
  SectionTitle,
  Stat,
  StatGrid,
  formatCost,
  formatDuration,
  formatPercent,
} from "@/components/ui";
import { BarChart, ChartTheme, LineChart } from "@/components/charts";

/** Project analytics (PRD §34). */
export default async function ProjectAnalyticsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const user = await requireUserPage();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const analytics = await getProjectAnalytics(projectId, 30);

  return (
    <ChartTheme>
      <div style={{ display: "grid", gap: 18 }}>
        <Card>
          <SectionTitle hint="Everything you have done in this project">Activity</SectionTitle>
          <StatGrid min={135}>
            <Stat label="Learning sessions" value={analytics.activity.activeDays} sub="active days" />
            <Stat label="Tutor questions" value={analytics.activity.tutorQuestions} />
            <Stat label="Quiz attempts" value={analytics.activity.quizAttempts} sub={`${analytics.activity.quizzesCompleted} completed`} />
            <Stat label="Questions answered" value={analytics.activity.questionsAnswered} />
            <Stat label="Materials" value={analytics.activity.materials} sub="ready" />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle hint="How well the assessments are going">Performance</SectionTitle>
          <StatGrid min={135}>
            <Stat
              label="Quiz accuracy"
              value={analytics.activity.questionsAnswered > 0 ? formatPercent(analytics.performance.accuracy) : "—"}
            />
            <Stat label="Current mastery" value={formatPercent(analytics.performance.avgMastery)} />
            <Stat label="Concepts mastered" value={analytics.performance.conceptsMastered} sub={`of ${analytics.performance.totalConcepts}`} tone="success" />
            <Stat
              label="Need attention"
              value={analytics.performance.conceptsNeedingAttention}
              tone={analytics.performance.conceptsNeedingAttention > 0 ? "danger" : undefined}
            />
            <Stat
              label="Written answers"
              value={analytics.performance.openQuestionAvgScore > 0 ? formatPercent(analytics.performance.openQuestionAvgScore) : "—"}
              sub="avg score"
            />
          </StatGrid>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Average across all concepts">Mastery trend</SectionTitle>
            <LineChart
              data={analytics.masteryTimeline.map((p) => ({ label: p.day, value: p.avgMastery }))}
              format="percent"
              yMax={1}
              emptyMessage="No mastery history yet"
            />
          </Card>

          <Card>
            <SectionTitle hint="Proportion answered correctly each day">Assessment trend</SectionTitle>
            <LineChart
              data={analytics.assessmentTimeline.map((p) => ({ label: p.day, value: p.accuracy }))}
              format="percent"
              yMax={1}
              emptyMessage="No assessments yet"
            />
          </Card>

          <Card>
            <SectionTitle hint="Tutor questions asked per day">Learning activity</SectionTitle>
            <BarChart
              data={analytics.daily.map((d) => ({ label: d.day, value: d.tutorMessages }))}
              emptyMessage="No tutor activity in this period"
            />
          </Card>

          <Card>
            <SectionTitle hint="Quiz questions answered per day">Assessment activity</SectionTitle>
            <BarChart
              data={analytics.daily.map((d) => ({ label: d.day, value: d.questionsAnswered }))}
              emptyMessage="No quiz activity in this period"
            />
          </Card>
        </div>

        <Card>
          <SectionTitle hint="What the AI layer did for this project, and what it cost">
            AI activity
          </SectionTitle>
          <StatGrid min={135}>
            <Stat label="AI requests" value={analytics.aiActivity.requests} />
            <Stat label="Tutor interactions" value={analytics.aiActivity.tutorRequests} />
            <Stat label="Questions generated" value={analytics.aiActivity.generatedQuestions} />
            <Stat label="Answers graded" value={analytics.aiActivity.evaluations} />
            <Stat label="Recommendations" value={analytics.aiActivity.recommendations} />
            <Stat label="Avg latency" value={formatDuration(analytics.aiActivity.avgLatencyMs)} />
            <Stat
              label="Est. cost"
              value={formatCost(analytics.aiActivity.costUsd)}
              sub="last 30 days"
            />
            <Stat
              label="Error rate"
              value={formatPercent(analytics.aiActivity.errorRate, 1)}
              tone={analytics.aiActivity.errorRate > 0.05 ? "danger" : undefined}
            />
          </StatGrid>
        </Card>
      </div>
    </ChartTheme>
  );
}
