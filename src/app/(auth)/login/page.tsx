import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { AuthForm } from "@/components/auth-form";

export default async function LoginPage() {
  if (await currentUser()) redirect("/");
  return <AuthForm mode="login" />;
}
