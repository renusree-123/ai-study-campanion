import Link from "next/link";
import { requireUserPage } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { Card, EmptyState, SectionTitle, formatRelative } from "@/components/ui";
import { ChartTheme, MasteryMeter } from "@/components/charts";
import { CreateSpaceButton } from "@/components/dialogs";

export default async function SpacesPage() {
  const user = await requireUserPage();

  const spaces = await db.space.findMany({
    where: { userId: user.id, archivedAt: null },
    orderBy: [{ lastAccessedAt: "desc" }, { createdAt: "desc" }],
    include: {
      projects: {
        where: { archivedAt: null },
        select: { id: true, name: true, masteryAvg: true, lastAccessedAt: true },
        orderBy: { lastAccessedAt: "desc" },
      },
    },
  });

  return (
    <ChartTheme>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 660, letterSpacing: "-0.025em" }}>Spaces</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            Broad areas you are developing. Each holds focused projects.
          </p>
        </div>
        <CreateSpaceButton />
      </div>

      {spaces.length === 0 ? (
        <Card padding={28}>
          <EmptyState
            icon="🗂️"
            title="No spaces yet"
            body="A space groups related learning — a subject, a skill, a certification. Create one to get started."
            action={<CreateSpaceButton />}
          />
        </Card>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 16,
          }}
        >
          {spaces.map((space) => {
            const avgMastery =
              space.projects.length > 0
                ? space.projects.reduce((sum, p) => sum + p.masteryAvg, 0) / space.projects.length
                : 0;
            return (
              <Link key={space.id} href={`/spaces/${space.id}`}>
                <Card style={{ height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 3,
                        background: `var(--space-${space.color})`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 14.5, fontWeight: 630 }}>{space.name}</span>
                  </div>

                  {space.description ? (
                    <p
                      style={{
                        margin: "0 0 12px",
                        fontSize: 12.5,
                        color: "var(--text-muted)",
                        lineHeight: 1.6,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {space.description}
                    </p>
                  ) : null}

                  <div style={{ marginBottom: 11 }}>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        marginBottom: 4,
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>Overall progress</span>
                    </div>
                    <MasteryMeter level={avgMastery} />
                  </div>

                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--text-subtle)",
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span>
                      {space.projects.length} project{space.projects.length === 1 ? "" : "s"}
                    </span>
                    <span>{formatRelative(space.lastAccessedAt ?? space.createdAt)}</span>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </ChartTheme>
  );
}
