import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { AuthForm } from "@/components/auth-form";
import { env } from "@/lib/env";
import { Alert, Card } from "@/components/ui";

export default async function RegisterPage() {
  if (await currentUser()) redirect("/");
  if (!env().ALLOW_REGISTRATION) {
    return (
      <Card>
        <Alert tone="info" title="Registration is disabled">
          This deployment is limited to the seeded demo accounts. Use the demo sign-in buttons on
          the <a href="/login" style={{ color: "var(--accent)" }}>sign-in page</a>.
        </Alert>
      </Card>
    );
  }
  return <AuthForm mode="register" />;
}
