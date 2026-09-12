import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { getAdminUsers } from "@/lib/domain/admin";
import { Badge, Card, SectionTitle, formatPercent, formatRelative } from "@/components/ui";
import { Table, Td, Tr } from "@/components/table";
import { MasteryMeter, ChartTheme } from "@/components/charts";

/** Admin users list (PRD §58). */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdminPage();
  const { q } = await searchParams;
  const users = await getAdminUsers({ search: q });

  return (
    <ChartTheme>
      <Card>
        <SectionTitle hint={`${users.length} account${users.length === 1 ? "" : "s"}`}>
          Users
        </SectionTitle>

        <form method="get" style={{ marginBottom: 14 }}>
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by name or email…"
            style={{
              width: "100%",
              maxWidth: 320,
              background: "var(--surface-2)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              padding: "7px 11px",
              fontSize: 13,
              outline: "none",
            }}
          />
        </form>

        <Table
          columns={[
            { key: "user", label: "User" },
            { key: "registered", label: "Registered" },
            { key: "active", label: "Last active" },
            { key: "spaces", label: "Spaces", align: "right" },
            { key: "projects", label: "Projects", align: "right" },
            { key: "activity", label: "Activity", align: "right" },
            { key: "progress", label: "Overall progress", width: 170 },
          ]}
          empty="No users match that search."
        >
          {users.map((user) => (
            <Tr key={user.id}>
              <Td>
                <Link href={`/admin/users/${user.id}`} style={{ color: "var(--accent)", fontWeight: 550 }}>
                  {user.name}
                </Link>
                <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>{user.email}</div>
                {user.role === "ADMIN" ? (
                  <div style={{ marginTop: 3 }}>
                    <Badge tone="accent">admin</Badge>
                  </div>
                ) : null}
              </Td>
              <Td muted nowrap>{formatRelative(user.createdAt)}</Td>
              <Td muted nowrap>{formatRelative(user.lastActiveAt)}</Td>
              <Td align="right">{user.spaces}</Td>
              <Td align="right">{user.projects}</Td>
              <Td align="right">{user.activity}</Td>
              <Td>
                <MasteryMeter level={user.avgMastery} height={6} />
                <div style={{ fontSize: 10.5, color: "var(--text-subtle)", marginTop: 2 }}>
                  {user.concepts} concepts tracked
                </div>
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </ChartTheme>
  );
}
