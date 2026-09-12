import { handler, ok } from "@/lib/http";
import { requireUser } from "@/lib/auth/session";

export const GET = handler(async () => {
  const user = await requireUser();
  return ok(user);
});
