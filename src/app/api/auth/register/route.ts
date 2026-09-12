import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { created, handler, parseBody } from "@/lib/http";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().min(2).max(80),
});

export const POST = handler(async (request: Request) => {
  if (!env().ALLOW_REGISTRATION) {
    throw new AppError("FORBIDDEN", "Registration is disabled on this deployment.");
  }

  const body = await parseBody(request, schema);
  const email = body.email.toLowerCase().trim();

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    // Deliberately explicit: the sign-up form is the one place where address
    // enumeration is unavoidable, and a vague error just wastes the user's time.
    throw new AppError("CONFLICT", "An account with that email already exists.");
  }

  const user = await db.user.create({
    data: {
      email,
      name: body.name.trim(),
      passwordHash: await hashPassword(body.password),
      // First account bootstraps as administrator so a fresh deployment has one.
      role: (await db.user.count()) === 0 ? "ADMIN" : "USER",
      lastActiveAt: new Date(),
    },
  });

  await setSessionCookie({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as "USER" | "ADMIN",
  });

  logger.info("user_registered", { userId: user.id });
  return created({ id: user.id, email: user.email, name: user.name, role: user.role });
});
