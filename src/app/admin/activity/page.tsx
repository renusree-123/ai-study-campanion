import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminActivity } from "@/lib/domain/admin";
import { ACTIVITY_TYPES, activityLabel } from "@/lib/activity";
import { Card, SectionTitle, formatRelative } from "@/components/ui";
import { Table, Td, Tr } from "@/components/table";

/** Admin activity feed with filters (PRD §61). */
export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; days?: string; userId?: string; projectId?: string }>;
}) {
  await requireAdmin();
  const query = await searchParams;
  const days = Number(query.days ?? 30);

  const events = await getAdminActivity({
    type: query.type || undefined,
    userId: query.userId || undefined,
    projectId: query.projectId || undefined,
    days: Number.isFinite(days) ? days : 30,
    limit: 200,
  });

  const selectStyle = {
    background: "var(--surface-2)",
    border: "1px solid var(--border-strong)",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12.5,
    outline: "none",
  } as const;

  return (
    <Card>
      <SectionTitle hint={`${events.length} events`}>Platform activity</SectionTitle>

      {/* Filters sit in one row above the data, per the dashboard convention. */}
      <form method="get" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <select name="type" defaultValue={query.type ?? ""} style={selectStyle}>
          <option value="">All activity types</option>
          {Object.keys(ACTIVITY_TYPES).map((type) => (
            <option key={type} value={type}>
              {activityLabel(type)}
            </option>
          ))}
        </select>
        <select name="days" defaultValue={query.days ?? "30"} style={selectStyle}>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
        {query.userId ? <input type="hidden" name="userId" value={query.userId} /> : null}
        <button
          type="submit"
          style={{
            background: "var(--accent)",
            color: "var(--accent-text)",
            border: 0,
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 12.5,
            fontWeight: 560,
            cursor: "pointer",
          }}
        >
          Apply
        </button>
        {query.type || query.userId || query.days ? (
          <Link
            href="/admin/activity"
            style={{
              alignSelf: "center",
              fontSize: 12.5,
              color: "var(--text-muted)",
            }}
          >
            Clear
          </Link>
        ) : null}
      </form>

      <Table
        columns={[
          { key: "when", label: "When" },
          { key: "type", label: "Type" },
          { key: "user", label: "User" },
          { key: "project", label: "Project" },
          { key: "summary", label: "Summary" },
        ]}
        empty="No activity matches these filters."
      >
        {events.map((event) => (
          <Tr key={event.id}>
            <Td muted nowrap>{formatRelative(event.createdAt)}</Td>
            <Td nowrap>{activityLabel(event.type)}</Td>
            <Td>
              <Link href={`/admin/users/${event.user.id}`} style={{ color: "var(--accent)" }}>
                {event.user.name}
              </Link>
            </Td>
            <Td muted nowrap>{event.project?.name ?? "—"}</Td>
            <Td muted>{event.summary}</Td>
          </Tr>
        ))}
      </Table>
    </Card>
  );
}
