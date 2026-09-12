import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { assertProductionSecrets, env } from "../env";
import { unauthenticated, forbidden } from "../errors";
import { db } from "../db";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "USER" | "ADMIN";
}

interface Claims {
  sub: string;
  email: string;
  name: string;
  role: "USER" | "ADMIN";
}

function key(): Uint8Array {
  // Point-of-use guard: signing or verifying with the public development
  // secret in production would make every session forgeable.
  assertProductionSecrets();
  return new TextEncoder().encode(env().AUTH_SECRET);
}

export async function signSession(user: SessionUser): Promise<string> {
  const ttl = env().AUTH_SESSION_TTL_HOURS * 3600;
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer("ai-study-companion")
    .setAudience("ai-study-companion")
    .setExpirationTime(`${ttl}s`)
    .sign(key());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify<Claims>(token, key(), {
      issuer: "ai-study-companion",
      audience: "ai-study-companion",
    });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role === "ADMIN" ? "ADMIN" : "USER",
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(user: SessionUser): Promise<void> {
  const token = await signSession(user);
  const store = await cookies();
  store.set(env().AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: env().AUTH_SESSION_TTL_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(env().AUTH_COOKIE_NAME);
}

/** Current user, or null when signed out. Never throws. */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(env().AUTH_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySession(token);
}

/** Current user or throw 401. Use in every authenticated route handler. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw unauthenticated();
  return user;
}

/** Current user, or throw 401/403 unless they are an administrator. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw forbidden("Administrator access required.");
  return user;
}

/**
 * Page equivalents of `requireUser` / `requireAdmin`.
 *
 * A server component that throws AppError for an unauthenticated visitor gets
 * logged as an unhandled error, even though the surrounding layout is already
 * redirecting them — which buries real errors in noise. In a page, "not signed
 * in" is a redirect, not a fault. `redirect()` throws a control-flow signal
 * Next handles silently.
 *
 * Route handlers keep using `requireUser`/`requireAdmin`, where a 401/403 is
 * the correct answer.
 */
export async function requireUserPage(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdminPage(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/");
  return user;
}

/**
 * Best-effort last-seen tracking. Throttled to one write per 5 minutes per
 * user so navigation does not generate a write per page view.
 */
const lastTouch = new Map<string, number>();
export async function touchUser(userId: string): Promise<void> {
  const now = Date.now();
  const previous = lastTouch.get(userId) ?? 0;
  if (now - previous < 5 * 60_000) return;
  lastTouch.set(userId, now);
  await db.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } }).catch(() => {});
}
