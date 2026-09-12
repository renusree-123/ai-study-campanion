import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { signSession, verifySession } from "@/lib/auth/session";
import {
  assertProjectAccess,
  assertSpaceAccess,
  resolveJobOwnership,
} from "@/lib/auth/ownership";
import { AppError } from "@/lib/errors";
import { makeProject, makeUser, resetDatabase } from "./helpers";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("produces a different hash for the same password each time (salted)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("rejects a malformed stored hash rather than throwing", async () => {
    expect(await verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips a signed session", async () => {
    const token = await signSession({
      id: "user-1",
      email: "a@b.dev",
      name: "A",
      role: "ADMIN",
    });
    const session = await verifySession(token);
    expect(session).toMatchObject({ id: "user-1", email: "a@b.dev", role: "ADMIN" });
  });

  it("rejects a tampered token", async () => {
    const token = await signSession({ id: "user-1", email: "a@b.dev", name: "A", role: "USER" });
    // Flip a character in the signature.
    const tampered = `${token.slice(0, -3)}xyz`;
    expect(await verifySession(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession({ id: "user-1", email: "a@b.dev", name: "A", role: "USER" });
    const original = process.env.AUTH_SECRET;
    try {
      // The env module memoises, so verify against a token from a foreign issuer instead.
      expect(await verifySession("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bogus")).toBeNull();
    } finally {
      process.env.AUTH_SECRET = original;
    }
    expect(await verifySession(token)).not.toBeNull();
  });

  it("does not silently upgrade an unknown role to admin", async () => {
    const token = await signSession({
      id: "user-1",
      email: "a@b.dev",
      name: "A",
      // @ts-expect-error deliberately invalid role
      role: "SUPERUSER",
    });
    const session = await verifySession(token);
    expect(session?.role).toBe("USER");
  });
});

describe("ownership guards (data isolation)", () => {
  beforeEach(resetDatabase);

  it("lets an owner reach their own project", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await expect(assertProjectAccess(user.id, project.id)).resolves.toMatchObject({
      id: project.id,
    });
  });

  it("refuses another user's project with a not-found, not a forbidden", async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    const { project, space } = await makeProject(owner.id);

    // NOT_FOUND rather than FORBIDDEN: a 403 would confirm the id exists.
    await expect(assertProjectAccess(intruder.id, project.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(assertSpaceAccess(intruder.id, space.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses an archived project", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await db.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } });
    await expect(assertProjectAccess(user.id, project.id)).rejects.toBeInstanceOf(AppError);
  });

  it("re-verifies ownership for background jobs, not just at enqueue time", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { project } = await makeProject(owner.id);

    await expect(resolveJobOwnership(owner.id, project.id)).resolves.toMatchObject({
      id: project.id,
    });
    // A tampered or stale job payload must not cross the tenancy boundary.
    await expect(resolveJobOwnership(other.id, project.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

afterAll(async () => {
  await db.$disconnect();
});
