import { z } from "zod";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { handler, ok, parseBody } from "@/lib/http";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

// A throwaway hash, verified against when no user matches, so a request for a
// non-existent account costs the same time as one for a real account and the
// endpoint does not leak which addresses are registered.
let decoyHash: string | null = null;
async function getDecoyHash() {
  decoyHash ??= await hashPassword("decoy-password-for-timing-parity");
  return decoyHash;
}

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  const email = body.email.toLowerCase().trim();

  const user = await db.user.findUnique({ where: { email } });

  if (!user) {
    await verifyPassword(body.password, await getDecoyHash());
    logger.warn("login_failed", { reason: "unknown_email" });
    throw new AppError("UNAUTHENTICATED", "Email or password is incorrect.");
  }

  const valid = await verifyPassword(body.password, user.passwordHash);
  if (!valid || !user.isActive) {
    logger.warn("login_failed", { userId: user.id, reason: valid ? "inactive" : "bad_password" });
    throw new AppError(
      "UNAUTHENTICATED",
      user.isActive ? "Email or password is incorrect." : "This account has been deactivated.",
    );
  }

  await setSessionCookie({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as "USER" | "ADMIN",
  });
  await db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });

  logger.info("login_succeeded", { userId: user.id });
  return ok({ id: user.id, email: user.email, name: user.name, role: user.role });
});
