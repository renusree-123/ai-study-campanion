import { requireAdminPage } from "@/lib/auth/session";
import { getSystemHealth } from "@/lib/domain/admin";
import { db } from "@/lib/db";
import { Badge, Card, SectionTitle, Stat, StatGrid, formatDuration, formatRelative } from "@/components/ui";
import { Table, Td, Tr } from "@/components/table";

// Health must reflect the moment it is viewed.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Admin system health (PRD §64). */
export default async function AdminHealthPage() {
  await requireAdminPage();

  const [health, recentJobs, failedJobs, failedEvents] = await Promise.all([
    getSystemHealth(),
    db.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        stage: true,
        progress: true,
        durationMs: true,
        lastError: true,
        createdAt: true,
      },
    }),
    db.job.findMany({
      where: { status: { in: ["FAILED", "DEAD"] } },
      orderBy: { finishedAt: "desc" },
      take: 10,
      select: { id: true, type: true, status: true, attempts: true, lastError: true, finishedAt: true },
    }),
    db.domainEvent.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, attempts: true, lastError: true, createdAt: true },
    }),
  ]);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <Card>
        <SectionTitle
          hint="Live checks, evaluated on page load"
          action={
            <Badge tone={health.healthy ? "success" : "danger"}>
              {health.healthy ? "All systems normal" : "Attention required"}
            </Badge>
          }
        >
          System health
        </SectionTitle>
        <div style={{ display: "grid", gap: 10 }}>
          {health.checks.map((check) => (
            <div
              key={check.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "10px 13px",
                borderRadius: 9,
                background: check.ok ? "var(--success-soft)" : "var(--danger-soft)",
              }}
            >
              {/* Icon plus label — status is never carried by colour alone. */}
              <span
                aria-hidden="true"
                style={{
                  fontSize: 13,
                  color: check.ok ? "var(--success)" : "var(--danger)",
                  fontWeight: 700,
                }}
              >
                {check.ok ? "✓" : "!"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.8, fontWeight: 585 }}>
                  {check.name}
                  <span
                    style={{
                      marginLeft: 8,
                      fontWeight: 550,
                      color: check.ok ? "var(--success)" : "var(--danger)",
                    }}
                  >
                    {check.ok ? "OK" : "Degraded"}
                  </span>
                </div>
                <div style={{ fontSize: 11.8, color: "var(--text-muted)" }}>{check.detail}</div>
              </div>
              {check.latencyMs !== undefined ? (
                <span style={{ fontSize: 11.5, color: "var(--text-subtle)", whiteSpace: "nowrap" }}>
                  {formatDuration(check.latencyMs)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle hint="Durable job queue">Background processing</SectionTitle>
        <StatGrid min={110}>
          <Stat label="Queued" value={health.jobs.counts.QUEUED} />
          <Stat label="Running" value={health.jobs.counts.RUNNING} />
          <Stat label="Succeeded" value={health.jobs.counts.SUCCEEDED} tone="success" />
          <Stat label="Failed" value={health.jobs.counts.FAILED} tone={health.jobs.counts.FAILED ? "danger" : undefined} />
          <Stat label="Dead" value={health.jobs.counts.DEAD} tone={health.jobs.counts.DEAD ? "danger" : undefined} />
          <Stat
            label="Oldest queued"
            value={health.jobs.oldestQueuedAgeMs > 0 ? formatDuration(health.jobs.oldestQueuedAgeMs) : "—"}
          />
        </StatGrid>
      </Card>

      {failedJobs.length > 0 || failedEvents.length > 0 ? (
        <Card>
          <SectionTitle hint="Work that gave up after exhausting retries">Recent failures</SectionTitle>
          <Table
            columns={[
              { key: "kind", label: "Kind" },
              { key: "type", label: "Type" },
              { key: "attempts", label: "Attempts", align: "right" },
              { key: "when", label: "When" },
              { key: "error", label: "Error" },
            ]}
          >
            {failedJobs.map((job) => (
              <Tr key={job.id}>
                <Td><Badge tone="danger">job</Badge></Td>
                <Td mono nowrap>{job.type}</Td>
                <Td align="right">{job.attempts}</Td>
                <Td muted nowrap>{formatRelative(job.finishedAt)}</Td>
                <Td muted>{job.lastError ?? "—"}</Td>
              </Tr>
            ))}
            {failedEvents.map((event) => (
              <Tr key={event.id}>
                <Td><Badge tone="warning">event</Badge></Td>
                <Td mono nowrap>{event.type}</Td>
                <Td align="right">{event.attempts}</Td>
                <Td muted nowrap>{formatRelative(event.createdAt)}</Td>
                <Td muted>{event.lastError ?? "—"}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}

      <Card>
        <SectionTitle hint="Newest first">Recent jobs</SectionTitle>
        <Table
          columns={[
            { key: "type", label: "Type" },
            { key: "status", label: "Status" },
            { key: "stage", label: "Stage" },
            { key: "attempts", label: "Attempts", align: "right" },
            { key: "duration", label: "Duration", align: "right" },
            { key: "when", label: "Created" },
          ]}
          empty="No jobs recorded yet."
        >
          {recentJobs.map((job) => (
            <Tr key={job.id}>
              <Td mono nowrap>{job.type}</Td>
              <Td>
                <Badge
                  tone={
                    job.status === "SUCCEEDED"
                      ? "success"
                      : job.status === "RUNNING"
                        ? "info"
                        : job.status === "QUEUED"
                          ? "default"
                          : "danger"
                  }
                  title={job.lastError ?? undefined}
                >
                  {job.status.toLowerCase()}
                </Badge>
              </Td>
              <Td muted nowrap>
                {job.status === "RUNNING" && job.stage ? `${job.stage} (${job.progress}%)` : "—"}
              </Td>
              <Td align="right" muted>
                {job.attempts}/{job.maxAttempts}
              </Td>
              <Td align="right" muted>{job.durationMs > 0 ? formatDuration(job.durationMs) : "—"}</Td>
              <Td muted nowrap>{formatRelative(job.createdAt)}</Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
