import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { getAdminSpaces } from "@/lib/domain/admin";
import { Card, SectionTitle, formatRelative } from "@/components/ui";
import { Table, Td, Tr } from "@/components/table";

/** Admin spaces (PRD §60). */
export default async function AdminSpacesPage() {
  await requireAdminPage();
  const spaces = await getAdminSpaces();

  return (
    <Card>
      <SectionTitle hint="Every space on the platform, most recently used first">Spaces</SectionTitle>
      <Table
        columns={[
          { key: "name", label: "Space" },
          { key: "owner", label: "Owner" },
          { key: "projects", label: "Projects", align: "right" },
          { key: "activity", label: "Activity", align: "right" },
          { key: "created", label: "Created" },
          { key: "last", label: "Last activity" },
        ]}
        empty="No spaces yet."
      >
        {spaces.map((space) => (
          <Tr key={space.id}>
            <Td>
              <span style={{ fontWeight: 545 }}>{space.name}</span>
              {space.description ? (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-subtle)",
                    maxWidth: 380,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {space.description}
                </div>
              ) : null}
            </Td>
            <Td>
              <Link href={`/admin/users/${space.user.id}`} style={{ color: "var(--accent)" }}>
                {space.user.name}
              </Link>
              <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>{space.user.email}</div>
            </Td>
            <Td align="right">{space._count.projects}</Td>
            <Td align="right">{space._count.activity}</Td>
            <Td muted nowrap>{formatRelative(space.createdAt)}</Td>
            <Td muted nowrap>{formatRelative(space.lastAccessedAt)}</Td>
          </Tr>
        ))}
      </Table>
    </Card>
  );
}
