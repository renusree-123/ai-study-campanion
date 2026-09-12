import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { getAdminProjects } from "@/lib/domain/admin";
import { Card, SectionTitle, formatRelative } from "@/components/ui";
import { Table, Td, Tr } from "@/components/table";
import { ChartTheme, MasteryMeter } from "@/components/charts";

/** Admin projects (PRD §60). */
export default async function AdminProjectsPage() {
  await requireAdminPage();
  const projects = await getAdminProjects();

  return (
    <ChartTheme>
      <Card>
        <SectionTitle hint="Operational visibility only — content is not shown here">
          Projects
        </SectionTitle>
        <Table
          columns={[
            { key: "name", label: "Project" },
            { key: "owner", label: "Owner" },
            { key: "space", label: "Space" },
            { key: "materials", label: "Materials", align: "right" },
            { key: "tutor", label: "Tutor", align: "right" },
            { key: "quiz", label: "Quizzes", align: "right" },
            { key: "progress", label: "Progress", width: 150 },
            { key: "last", label: "Last activity" },
          ]}
          empty="No projects yet."
        >
          {projects.map((project) => (
            <Tr key={project.id}>
              <Td>
                <span style={{ fontWeight: 545 }}>{project.name}</span>
              </Td>
              <Td>
                <Link href={`/admin/users/${project.user.id}`} style={{ color: "var(--accent)" }}>
                  {project.user.name}
                </Link>
              </Td>
              <Td muted>{project.space.name}</Td>
              <Td align="right">{project._count.materials}</Td>
              <Td align="right">{project.tutorMessageCount}</Td>
              <Td align="right">{project._count.quizzes}</Td>
              <Td>
                <MasteryMeter level={project.masteryAvg} height={6} />
              </Td>
              <Td muted nowrap>{formatRelative(project.lastAccessedAt)}</Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </ChartTheme>
  );
}
