import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { ProjectTabs } from "@/components/project-tabs";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;

  const project = await assertProjectAccess(user.id, projectId).catch(() => null);
  if (!project) notFound();

  const full = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { space: { select: { id: true, name: true, color: true } } },
  });

  // Record the visit — this is what powers "continue learning" and the
  // recently-accessed ordering. Throttled to once per 10 minutes per project
  // so tab switching does not flood the activity feed.
  const stale =
    !full.lastAccessedAt || Date.now() - full.lastAccessedAt.getTime() > 10 * 60_000;
  if (stale) {
    await db.project.update({ where: { id: projectId }, data: { lastAccessedAt: new Date() } });
    await recordActivity({
      userId: user.id,
      projectId,
      spaceId: full.spaceId,
      type: "PROJECT_ACCESSED",
      summary: `Opened ${full.name}`,
    });
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", gap: 6 }}>
          <Link href="/spaces" style={{ color: "inherit" }}>Spaces</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/spaces/${full.space.id}`} style={{ color: "inherit" }}>
            {full.space.name}
          </Link>
        </div>
        <h1 style={{ margin: "6px 0 0", fontSize: 21, fontWeight: 660, letterSpacing: "-0.025em" }}>
          {full.name}
        </h1>
        {full.goal ? (
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)", maxWidth: 720 }}>
            <strong style={{ fontWeight: 570 }}>Goal:</strong> {full.goal}
          </p>
        ) : null}
      </div>

      <ProjectTabs projectId={projectId} />
      <div style={{ marginTop: 18 }}>{children}</div>
    </>
  );
}
