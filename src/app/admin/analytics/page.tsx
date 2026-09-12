import { requireAdmin } from "@/lib/auth/session";
import { getAdminLearningAnalytics } from "@/lib/domain/admin";
import { activityLabel } from "@/lib/activity";
import {
  Card,
  SectionTitle,
  Stat,
  StatGrid,
  formatCost,
  formatDuration,
  formatPercent,
} from "@/components/ui";
import { BarChart, ChartTheme, LineChart, MasteryMeter } from "@/components/charts";
import { Table, Td, Tr } from "@/components/table";

/** Admin learning analytics (PRD §62). */
export default async function AdminAnalyticsPage() {
  await requireAdmin();
  const analytics = await getAdminLearningAnalytics(30);

  const totalAnswered = analytics.daily.reduce((s, d) => s + d.questionsAnswered, 0);
  const totalCorrect = analytics.daily.reduce((s, d) => s + d.correctAnswers, 0);

  return (
    <ChartTheme>
      <div style={{ display: "grid", gap: 18 }}>
        <Card>
          <SectionTitle hint="Across every user, last 30 days">Platform learning</SectionTitle>
          <StatGrid min={140}>
            <Stat label="Average mastery" value={formatPercent(analytics.avgMastery)} />
            <Stat label="Concepts tracked" value={analytics.trackedConcepts} />
            <Stat label="Active projects" value={analytics.activeProjects} />
            <Stat
              label="Assessment accuracy"
              value={totalAnswered > 0 ? formatPercent(totalCorrect / totalAnswered) : "—"}
              sub={`${totalAnswered} answered`}
            />
          </StatGrid>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Tutor questions asked per day, all users">
              Learning activity
            </SectionTitle>
            <BarChart
              data={analytics.daily.map((d) => ({ label: d.day, value: d.tutorMessages }))}
              emptyMessage="No tutor activity recorded"
            />
          </Card>

          <Card>
            <SectionTitle hint="Quiz questions answered per day, all users">
              Assessment volume
            </SectionTitle>
            <BarChart
              data={analytics.daily.map((d) => ({ label: d.day, value: d.questionsAnswered }))}
              emptyMessage="No assessments recorded"
            />
          </Card>
        </div>

        <Card>
          <SectionTitle hint="Which AI-backed features people actually use">
            Feature usage
          </SectionTitle>
          <Table
            columns={[
              { key: "feature", label: "Feature" },
              { key: "count", label: "Requests", align: "right" },
              { key: "latency", label: "Avg latency", align: "right" },
              { key: "cost", label: "Est. cost", align: "right" },
            ]}
            empty="No AI usage recorded in this period."
          >
            {analytics.featureUsage.map((row) => (
              <Tr key={row.feature}>
                <Td>{row.feature.replace(/_/g, " ").toLowerCase()}</Td>
                <Td align="right">{row.count}</Td>
                <Td align="right" muted>{formatDuration(row.avgLatencyMs)}</Td>
                <Td align="right" muted>{formatCost(row.costUsd)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Lowest average mastery across learners — candidates for better material or clearer teaching">
              Where users commonly struggle
            </SectionTitle>
            {analytics.strugglingConcepts.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                Not enough assessment evidence yet.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {analytics.strugglingConcepts.map((concept) => (
                  <div key={concept.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.4, fontWeight: 540 }}>{concept.name}</span>
                      <span style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                        {concept.learners} learner{concept.learners === 1 ? "" : "s"}
                      </span>
                    </div>
                    <MasteryMeter level={concept.avgLevel} />
                    <div style={{ fontSize: 10.5, color: "var(--text-subtle)", marginTop: 2 }}>
                      {concept.project}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle hint="What people are doing, by event type">Engagement mix</SectionTitle>
            <BarChart
              horizontal
              data={analytics.activityTypes.map((row) => ({
                label: activityLabel(row.type),
                value: row.count,
              }))}
              emptyMessage="No activity recorded"
            />
          </Card>
        </div>
      </div>
    </ChartTheme>
  );
}
