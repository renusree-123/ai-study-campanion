import { redirect } from "next/navigation";
import { currentUser, touchUser } from "@/lib/auth/session";
import { ai } from "@/lib/ai/router";
import { Nav } from "@/components/nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  await touchUser(user.id);

  const provider = ai.describe();

  return (
    <>
      <Nav user={user} aiProvider={provider} />
      <main style={{ maxWidth: 1240, margin: "0 auto", padding: "22px 20px 64px" }}>{children}</main>
    </>
  );
}
