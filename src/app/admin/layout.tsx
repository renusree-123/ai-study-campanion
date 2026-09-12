import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { ai } from "@/lib/ai/router";
import { Nav } from "@/components/nav";
import { AdminTabs } from "@/components/admin-tabs";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Authorisation, not just navigation: every admin page is behind this check
  // as well as its own route-level guard.
  if (user.role !== "ADMIN") redirect("/");

  return (
    <>
      <Nav user={user} aiProvider={ai.describe()} />
      <main style={{ maxWidth: 1240, margin: "0 auto", padding: "22px 20px 64px" }}>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 660, letterSpacing: "-0.025em" }}>
            Admin
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            Platform activity, AI usage and system health. Read-only.
          </p>
        </div>
        <AdminTabs />
        <div style={{ marginTop: 18 }}>{children}</div>
      </main>
    </>
  );
}
