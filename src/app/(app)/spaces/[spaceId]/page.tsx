import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUserPage } from "@/lib/auth/session";
import { assertSpaceAccess } from "@/lib/auth/ownership";
import { db } from "@/lib/db";
import {
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  Stat,
  StatGrid,
  formatPercent,
  formatRelative,
} from "@/components/ui";
import { ChartTheme, MasteryMeter } from "@/components/charts";
import { CreateProjectButton } from "@/components/dialogs";
import { ActivityList, TrendBadge } from "@/components/learning";

/** Space dashboard (PRD §7). */
export default async function SpacePage({ params }: { params: Promise<{ spaceId: string }> }) {
  const user = await requireUserPage();
  const { spaceId } = await params;

  const space = await assertSpaceAccess(user.id, spaceId).catch(() => null);
  if (!space) notFound();

  // Touch access time so "recently accessed" ordering is real.
  await db.space.update({ where: { id: spaceId }, data: { lastAccessedAt: new Date() } });

  const [projects, activity, attention] = await Promise.all([
    db.project.findMany({
      where: { spaceId, archivedAt: null },
      orderBy: [{ lastAccessedAt: "desc" }, { createdAt: "desc" }],
      include: { _count: { select: { materials: true, conversations: true, quizzes: true } } },
    }),
    db.activityEvent.findMany({
      where: { spaceId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { project: { select: { id: true, name: true } } },
    }),
    db.mastery.findMany({
      where: { project: { spaceId }, level: { lt: 0.6 }, evidenceCount: { gt: 0 } },
      orderBy: { level: "asc" },
      take: 6,
      include: {
        concept: { select: { name: true } },
        project: { select: { id: true, name: true } },
      },
    }),
  ]);

  const avgMastery =
    projects.length > 0 ? projects.reduce((s, p) => s + p.masteryAvg, 0) / projects.length : 0;
  const totalMaterials = projects.reduce((s, p) => s + p._count.materials, 0);
  const activeProjects = projects.filter(
    (p) => p.lastAccessedAt && Date.now() - p.lastAccessedAt.getTime() < 7 * 86_400_000,
  ).length;

  return (
    <ChartTheme>
      <div style={{ marginBottom: 18 }}>
        <Link href="/spaces" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          ← All spaces
        </Link>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 14,
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 3,
                  background: `var(--space-${space.color})`,
                }}
              />
              <h1 style={{ margin: 0, fontSize: 21, fontWeight: 660, letterSpacing: "-0.025em" }}>
                {space.name}
              </h1>
            </div>
            {space.description ? (
              <p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--text-muted)", maxWidth: 640 }}>
                {space.description}
              </p>
            ) : null}
          </div>
          <CreateProjectButton spaceId={spaceId} />
        </div>
      </div>

      <Card style={{ marginBottom: 18 }}>
        <StatGrid min={140}>
          <Stat label="Projects" value={projects.length} sub={`${activeProjects} active this week`} />
          <Stat label="Overall progress" value={formatPercent(avgMastery)} />
          <Stat label="Materials" value={totalMaterials} />
          <Stat
            label="Need attention"
            value={attention.length}
            sub="concepts"
            tone={attention.length > 0 ? "danger" : undefined}
          />
        </StatGrid>
      </Card>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(270px, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <Card>
          <SectionTitle hint="Each project keeps its own materials, tutor and mastery">
            Projects
          </SectionTitle>
          {projects.length === 0 ? (
            <EmptyState
              icon="📁"
              title="No projects in this space yet"
              body="A project is one focused learning journey. Create one, add a PDF, and the tutor can start teaching from it."
              action={<CreateProjectButton spaceId={spaceId} variant="secondary" />}
            />
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {projects.map((project) => (
                <Link key={project.id} href={`/projects/${project.id}`}>
                  <div
                    style={{
                      padding: 14,
                      border: "1px solid var(--border)",
                      borderRadius: 9,
                      background: "var(--surface-2)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        marginBottom: 6,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 615 }}>{project.name}</div>
                        {project.goal ? (
                          <div
                            style={{
                              fontSize: 11.8,
                              color: "var(--text-muted)",
                              marginTop: 2,
                              display: "-webkit-box",
                              WebkitLineClamp: 1,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                          >
                            Goal: {project.goal}
                          </div>
                        ) : null}
                      </div>
                      <span style={{ fontSize: 11.5, color: "var(--text-subtle)", whiteSpace: "nowrap" }}>
                        {formatRelative(project.lastAccessedAt ?? project.createdAt)}
                      </span>
                    </div>
                    <MasteryMeter level={project.masteryAvg} />
                    <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11.5, color: "var(--text-subtle)" }}>
                      <span>{project._count.materials} materials</span>
                      <span>{project._count.conversations} conversations</span>
                      <span>{project._count.quizzes} quizzes</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <div style={{ display: "grid", gap: 18 }}>
          <Card>
            <SectionTitle>Areas requiring attention</SectionTitle>
            {attention.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                Nothing flagged in this space.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {attention.map((mastery) => (
                  <div key={mastery.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12.4, fontWeight: 545 }}>{mastery.concept.name}</span>
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
            <SectionTitle>Recent activity</SectionTitle>
            <ActivityList events={activity} showProject />
          </Card>
        </div>
      </div>
    </ChartTheme>
  );
}
