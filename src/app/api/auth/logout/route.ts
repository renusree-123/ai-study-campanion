import { handler, ok } from "@/lib/http";
import { clearSessionCookie } from "@/lib/auth/session";

export const POST = handler(async () => {
  await clearSessionCookie();
  return ok({ signedOut: true });
});
