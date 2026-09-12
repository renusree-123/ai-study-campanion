import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { db } from "@/lib/db";
import { parseBody, parseQuery, ok, created, fail } from "@/lib/http";
import { AppError, isRetryable } from "@/lib/errors";
import { stableStringify, parseJson } from "@/lib/json";
import { looksLikePdf } from "@/lib/materials/pdf";
import { materialKey } from "@/lib/storage";

function jsonRequest(body: unknown) {
  return new Request("http://test.local/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("request validation", () => {
  const schema = z.object({
    name: z.string().min(2).max(10),
    count: z.number().int().min(1).default(1),
  });

  it("accepts a valid body and applies defaults", async () => {
    const parsed = await parseBody(jsonRequest({ name: "ok" }), schema);
    expect(parsed).toEqual({ name: "ok", count: 1 });
  });

  it("rejects a body that fails the schema with a 422 and field details", async () => {
    try {
      await parseBody(jsonRequest({ name: "x" }), schema);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("VALIDATION_ERROR");
      expect(appError.status).toBe(422);
      expect(appError.details).toBeTruthy();
    }
  });

  it("rejects malformed JSON with a 400, not a 500", async () => {
    try {
      await parseBody(jsonRequest("{not json"), schema);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as AppError).code).toBe("BAD_REQUEST");
      expect((error as AppError).status).toBe(400);
    }
  });

  it("strips unknown fields rather than persisting them", async () => {
    const parsed = await parseBody(
      jsonRequest({ name: "ok", role: "ADMIN", isAdmin: true }),
      schema,
    );
    expect(parsed).not.toHaveProperty("role");
    expect(parsed).not.toHaveProperty("isAdmin");
  });

  it("validates query parameters", () => {
    const request = new Request("http://test.local/api/x?days=7");
    const parsed = parseQuery(request, z.object({ days: z.coerce.number().int() }));
    expect(parsed.days).toBe(7);
  });
});

describe("error responses", () => {
  it("returns the declared status and a safe message for an AppError", async () => {
    const response = fail(new AppError("FORBIDDEN", "internal detail", { userMessage: "Not allowed." }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Not allowed.");
    expect(body.traceId).toBeTruthy();
  });

  it("never leaks an internal error message to the client", async () => {
    const response = fail(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).not.toContain("hunter2");
    expect(body.error.message).not.toContain("ECONNREFUSED");
    expect(body.error.code).toBe("INTERNAL");
  });

  it("maps a Zod error to a 422 with field paths", async () => {
    const result = z.object({ a: z.string() }).safeParse({ a: 1 });
    const response = fail(result.success ? new Error("x") : result.error);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.details[0].path).toBe("a");
  });

  it("wraps success responses in a consistent envelope", async () => {
    const body = await ok({ id: "1" }, { total: 1 }).json();
    expect(body).toEqual({ data: { id: "1" }, meta: { total: 1 } });
    expect(created({ id: "2" }).status).toBe(201);
  });
});

describe("retry classification", () => {
  it("treats provider, timeout and rate-limit errors as retryable", () => {
    expect(isRetryable(new AppError("AI_TIMEOUT", "timed out"))).toBe(true);
    expect(isRetryable(new AppError("AI_PROVIDER_ERROR", "502"))).toBe(true);
    expect(isRetryable(new AppError("RATE_LIMITED", "429"))).toBe(true);
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
  });

  it("does not retry a client error or invalid model output", () => {
    expect(isRetryable(new AppError("BAD_REQUEST", "bad input"))).toBe(false);
    expect(isRetryable(new AppError("NOT_FOUND", "missing"))).toBe(false);
    expect(isRetryable(new AppError("VALIDATION_ERROR", "invalid"))).toBe(false);
  });
});

describe("upload validation", () => {
  it("identifies a PDF by its magic bytes, not its filename", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.4\nrest of file"))).toBe(true);
    // A renamed executable or HTML file must be rejected.
    expect(looksLikePdf(Buffer.from("<html><script>alert(1)</script>"))).toBe(false);
    expect(looksLikePdf(Buffer.from("MZ\x90\x00"))).toBe(false);
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
  });

  it("namespaces storage keys per user and content hash", () => {
    const data = Buffer.from("%PDF-1.4 content");
    const a = materialKey("user-a", "proj-1", "notes.pdf", data);
    const b = materialKey("user-b", "proj-1", "notes.pdf", data);

    expect(a.key).toContain("materials/user-a/proj-1/");
    expect(b.key).toContain("materials/user-b/proj-1/");
    expect(a.key).not.toBe(b.key);
    // Same bytes give the same checksum, which is what makes upload idempotent.
    expect(a.checksum).toBe(b.checksum);
  });

  it("sanitises a traversal attempt in the filename", () => {
    const key = materialKey("u", "p", "../../../etc/passwd", Buffer.from("%PDF-"));
    expect(key.key).not.toContain("..");
    expect(key.key).not.toContain("/etc/");
  });
});

describe("json helpers", () => {
  it("returns the fallback for corrupt or missing JSON instead of throwing", () => {
    expect(parseJson("{bad", { a: 1 })).toEqual({ a: 1 });
    expect(parseJson(null, [])).toEqual([]);
    expect(parseJson("null", "fallback")).toBe("fallback");
  });

  it("stringifies stably regardless of key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

afterAll(async () => {
  await db.$disconnect();
});
