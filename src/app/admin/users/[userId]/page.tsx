import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminUserDetail } from "@/lib/domain/admin";
import {
  Badge,
  Card,
  SectionTitle,
  Stat,
  StatGrid,
  formatCost,
  formatPercent,
  formatRelative,
} from "@/components/ui";
import { Table, Td, Tr } from "@/components/table";
import { ChartTheme, MasteryMeter } from "@/components/charts";
import { ActivityList, TrendBadge } from "@/components/learning";

/** Admin user detail (PRD §59). */
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requireAdmin();
  const { userId } = await params;
  const detail = await getAdminUserDetail(userId);
  if (!detail) notFound();

  return (
    <ChartTheme>
      <Link href="/admin/users" style={{ fontSize: 12, color: "var(--text-muted)" }}>
        ← All users
      </Link>

      <div style={{ display: "grid", gap: 18, marginTop: 12 }}>
        <Card>
          <SectionTitle>User overview</SectionTitle>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 16, fontWeight: 640 }}>{detail.user.name}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{detail.user.email}</span>
            {detail.user.role === "ADMIN" ? <Badge tone="accent">administrator</Badge> : null}
            <Badge tone={detail.user.isActive ? "success" : "danger"}>
              {detail.user.isActive ? "active" : "deactivated"}
            </Badge>
          </div>
          <StatGrid min={135}>
            <Stat label="Registered" value={formatRelative(detail.user.createdAt)} />
            <Stat label="Last active" value={formatRelative(detail.user.lastActiveAt)} />
            <Stat label="Spaces" value={detail.spaces.length} />
            <Stat label="Projects" value={detail.projects.length} />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle>Learning overview</SectionTitle>
          <StatGrid min={135}>
            <Stat label="Overall mastery" value={formatPercent(detail.performance.avgMastery)} />
            <Stat
              label="Assessment score"
              value={detail.performance.answered > 0 ? formatPercent(detail.performance.avgScore) : "—"}
            />
            <Stat
              label="Questions answered"
              value={detail.performance.answered}
              sub={`${detail.performance.correct} correct`}
            />
            <Stat label="Concepts tracked" value={detail.mastery.length} />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle>Usage</SectionTitle>
          <StatGrid min={135}>
            <Stat label="Tutor questions" value={detail.usage.tutorMessages} />
            <Stat label="AI requests" value={detail.usage.aiRequests} />
            <Stat label="Est. AI cost" value={formatCost(detail.usage.aiCostUsd)} />
            <Stat
              label="AI errors"
              value={detail.usage.aiErrors}
              tone={detail.usage.aiErrors > 0 ? "danger" : undefined}
            />
          </StatGrid>
        </Card>

        <Card>
          <SectionTitle>Spaces &amp; projects</SectionTitle>
          <Table
            columns={[
              { key: "project", label: "Project" },
              { key: "space", label: "Space" },
              { key: "materials", label: "Materials", align: "right" },
              { key: "tutor", label: "Conversations", align: "right" },
              { key: "quiz", label: "Quizzes", align: "right" },
              { key: "progress", label: "Progress", width: 150 },
              { key: "active", label: "Last active" },
            ]}
            empty="This user has no projects."
          >
            {detail.projects.map((project) => (
              <Tr key={project.id}>
                <Td>{project.name}</Td>
                <Td muted>{project.space.name}</Td>
                <Td align="right">{project._count.materials}</Td>
                <Td align="right">{project._count.conversations}</Td>
                <Td align="right">{project._count.quizzes}</Td>
                <Td>
                  <MasteryMeter level={project.masteryAvg} height={6} />
                </Td>
                <Td muted nowrap>{formatRelative(project.lastAccessedAt)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Most recent first">Activity timeline</SectionTitle>
            <div style={{ maxHeight: 460, overflowY: "auto" }}>
              <ActivityList events={detail.activity} showProject />
            </div>
          </Card>

          <Card>
            <SectionTitle hint="Weakest first">Concept mastery</SectionTitle>
            {detail.mastery.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                No mastery data yet.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 12, maxHeight: 460, overflowY: "auto" }}>
                {detail.mastery.map((mastery) => (
                  <div key={mastery.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.3, fontWeight: 540 }}>{mastery.concept.name}</span>
                      <TrendBadge trend={mastery.trend} />
                    </div>
                    <MasteryMeter level={mastery.level} previous={mastery.previousLevel} />
                    <div style={{ fontSize: 10.5, color: "var(--text-subtle)", marginTop: 2 }}>
                      {mastery.project.name} · {mastery.attemptCount} attempts
                    </div>
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
