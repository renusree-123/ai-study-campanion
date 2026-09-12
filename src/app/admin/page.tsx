import { requireAdminPage } from "@/lib/auth/session";
import { getAdminOverview } from "@/lib/domain/admin";
import {
  Badge,
  Card,
  SectionTitle,
  Stat,
  StatGrid,
  formatCost,
  formatDuration,
  formatNumber,
  formatPercent,
} from "@/components/ui";
import { ChartTheme } from "@/components/charts";

/** Admin overview (PRD §57). */
export default async function AdminOverviewPage() {
  await requireAdminPage();
  const overview = await getAdminOverview(30);

  return (
    <ChartTheme>
      <div style={{ display: "grid", gap: 18 }}>
        <Card>
          <SectionTitle hint="Registered accounts and how many are currently learning">
            Users
          </SectionTitle>
          <StatGrid min={140}>
            <Stat label="Total users" value={formatNumber(overview.users.total)} />
            <Stat label="Active today" value={overview.users.activeToday} tone="success" />
            <Stat label="Active this week" value={overview.users.activeWeek} />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle>Content</SectionTitle>
          <StatGrid min={140}>
            <Stat label="Spaces" value={formatNumber(overview.content.spaces)} />
            <Stat label="Projects" value={formatNumber(overview.content.projects)} />
            <Stat label="Materials" value={formatNumber(overview.content.materials)} />
            <Stat
              label="Failed uploads"
              value={overview.content.materialsFailed}
              tone={overview.content.materialsFailed > 0 ? "danger" : undefined}
            />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle hint="All time">Learning activity</SectionTitle>
          <StatGrid min={140}>
            <Stat label="Tutor questions" value={formatNumber(overview.learning.tutorMessages)} />
            <Stat label="Quizzes completed" value={formatNumber(overview.learning.quizzesCompleted)} />
            <Stat label="Questions answered" value={formatNumber(overview.learning.questionsAnswered)} />
            <Stat label="Activity events" value={formatNumber(overview.learning.activityEvents)} sub="last 30 days" />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle
            hint="Last 30 days"
            action={
              <Badge tone={overview.ai.provider.isLive ? "success" : "warning"}>
                {overview.ai.provider.isLive
                  ? `${overview.ai.provider.model} (live)`
                  : "offline provider"}
              </Badge>
            }
          >
            AI usage
          </SectionTitle>
          <StatGrid min={140}>
            <Stat label="Requests" value={formatNumber(overview.ai.requests)} />
            <Stat
              label="Error rate"
              value={formatPercent(overview.ai.errorRate, 1)}
              tone={overview.ai.errorRate > 0.05 ? "danger" : "success"}
            />
            <Stat label="Avg latency" value={formatDuration(overview.ai.avgLatencyMs)} />
            <Stat label="p95 latency" value={formatDuration(overview.ai.p95LatencyMs)} />
            <Stat label="Est. cost" value={formatCost(overview.ai.costUsd)} />
            <Stat
              label="Tokens"
              value={formatNumber(overview.ai.inputTokens + overview.ai.outputTokens)}
              sub={`${formatNumber(overview.ai.inputTokens)} in / ${formatNumber(overview.ai.outputTokens)} out`}
            />
          </StatGrid>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Durable queue backing document processing and workflows">
              Background jobs
            </SectionTitle>
            <StatGrid min={110}>
              <Stat label="Queued" value={overview.jobs.counts.QUEUED} />
              <Stat label="Running" value={overview.jobs.counts.RUNNING} />
              <Stat label="Succeeded" value={overview.jobs.counts.SUCCEEDED} tone="success" />
              <Stat
                label="Failed"
                value={overview.jobs.counts.FAILED + overview.jobs.counts.DEAD}
                tone={overview.jobs.counts.FAILED + overview.jobs.counts.DEAD > 0 ? "danger" : undefined}
              />
            </StatGrid>
          </Card>

          <Card>
            <SectionTitle hint="Domain events driving downstream workflows">Event pipeline</SectionTitle>
            <StatGrid min={110}>
              <Stat label="Pending" value={overview.events.PENDING} />
              <Stat label="Processed" value={overview.events.PROCESSED} tone="success" />
              <Stat
                label="Failed"
                value={overview.events.FAILED}
                tone={overview.events.FAILED > 0 ? "danger" : undefined}
              />
            </StatGrid>
          </Card>
        </div>
      </div>
    </ChartTheme>
  );
}
