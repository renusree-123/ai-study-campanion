import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  backoffMs,
  claimNextJob,
  dedupeKeyFor,
  enqueue,
  markFailed,
  markSucceeded,
  queueStats,
  recoverStuckJobs,
} from "@/lib/jobs/queue";
import { publish, eventDedupeKey } from "@/lib/events/bus";
import { dispatchPendingEvents } from "@/lib/events/dispatcher";
import { Worker } from "@/lib/jobs/worker";
import { handlers, PermanentJobError } from "@/lib/jobs/handlers";
import { makeProject, makeUser, resetDatabase } from "./helpers";

describe("job queue", () => {
  beforeEach(resetDatabase);

  it("enqueues and claims a job exactly once", async () => {
    await enqueue({ type: "analytics.rollup", payload: { projectId: "p1" } });

    const first = await claimNextJob("worker-a");
    expect(first).not.toBeNull();

    // A second worker must not get the same job.
    const second = await claimNextJob("worker-b");
    expect(second).toBeNull();
  });

  it("deduplicates by key while a job is still pending", async () => {
    const key = dedupeKeyFor("material.process", { materialId: "m1" });
    const first = await enqueue({ type: "material.process", payload: { materialId: "m1" }, dedupeKey: key });
    const second = await enqueue({ type: "material.process", payload: { materialId: "m1" }, dedupeKey: key });

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // deduped
    expect(await db.job.count()).toBe(1);
  });

  it("allows the same key again once the earlier job reached a terminal state", async () => {
    const key = dedupeKeyFor("analytics.rollup", { projectId: "p1" });
    const jobId = await enqueue({ type: "analytics.rollup", payload: {}, dedupeKey: key });
    await db.job.update({ where: { id: jobId! }, data: { status: "SUCCEEDED" } });

    const again = await enqueue({ type: "analytics.rollup", payload: {}, dedupeKey: key });
    expect(again).toBe(jobId); // the row is reused and requeued
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId! } });
    expect(job.status).toBe("QUEUED");
    expect(job.attempts).toBe(0);
  });

  it("respects priority then scheduled time", async () => {
    await enqueue({ type: "analytics.rollup", payload: { n: 1 }, priority: 9 });
    await enqueue({ type: "analytics.rollup", payload: { n: 2 }, priority: 1 });

    const claimed = await claimNextJob("w");
    expect(JSON.parse(claimed!.payload).n).toBe(2);
  });

  it("does not claim a job scheduled in the future", async () => {
    await enqueue({ type: "analytics.rollup", payload: {}, delayMs: 60_000 });
    expect(await claimNextJob("w")).toBeNull();
  });

  it("retries a retryable failure with backoff, then gives up", async () => {
    await enqueue({ type: "analytics.rollup", payload: {}, maxAttempts: 2 });

    const first = await claimNextJob("w");
    await markFailed(first!, "temporary network error", { retryable: true, startedAt: Date.now() });

    let job = await db.job.findUniqueOrThrow({ where: { id: first!.id } });
    expect(job.status).toBe("QUEUED");
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(job.lastError).toContain("temporary network error");

    // Second attempt exhausts the budget.
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
    const second = await claimNextJob("w");
    await markFailed(second!, "still failing", { retryable: true, startedAt: Date.now() });

    job = await db.job.findUniqueOrThrow({ where: { id: first!.id } });
    expect(job.status).toBe("DEAD");
  });

  it("does not retry a non-retryable failure", async () => {
    await enqueue({ type: "analytics.rollup", payload: {}, maxAttempts: 5 });
    const job = await claimNextJob("w");
    await markFailed(job!, "corrupt document", { retryable: false, startedAt: Date.now() });

    const record = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(record.status).toBe("FAILED");
    expect(record.attempts).toBe(1);
  });

  it("uses exponential backoff", () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(4));
    expect(backoffMs(20)).toBeLessThanOrEqual(5 * 60_000);
  });

  it("recovers a job whose worker crashed mid-run", async () => {
    await enqueue({ type: "analytics.rollup", payload: {}, maxAttempts: 3 });
    const job = await claimNextJob("crashed-worker");

    // Simulate a lease that expired without the worker reporting back.
    await db.job.update({
      where: { id: job!.id },
      data: { lockedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const recovered = await recoverStuckJobs();
    expect(recovered).toBe(1);

    const record = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(record.status).toBe("QUEUED");
    expect(record.lockedBy).toBeNull();
  });

  it("kills a stuck job that has already exhausted its retries", async () => {
    await enqueue({ type: "analytics.rollup", payload: {}, maxAttempts: 1 });
    const job = await claimNextJob("w");
    await db.job.update({
      where: { id: job!.id },
      data: { lockedAt: new Date(Date.now() - 10 * 60_000) },
    });

    await recoverStuckJobs();
    const record = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(record.status).toBe("DEAD");
  });

  it("reports queue health", async () => {
    await enqueue({ type: "analytics.rollup", payload: { a: 1 } });
    await enqueue({ type: "analytics.rollup", payload: { b: 2 } });
    const claimed = await claimNextJob("w");
    await markSucceeded(claimed!.id, Date.now());

    const stats = await queueStats();
    expect(stats.counts.SUCCEEDED).toBe(1);
    expect(stats.counts.QUEUED).toBe(1);
    expect(stats.backlog).toBe(1);
  });
});

describe("worker", () => {
  beforeEach(resetDatabase);

  it("runs a job to completion and records duration", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);
    await enqueue({ type: "analytics.rollup", payload: { projectId: project.id } });

    const worker = new Worker();
    const processed = await worker.drain(10);
    expect(processed).toBe(1);

    const job = await db.job.findFirstOrThrow({ where: { type: "analytics.rollup" } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.progress).toBe(100);
  });

  it("marks a job failed rather than crashing the loop", async () => {
    // A payload missing its required field is a permanent error.
    await enqueue({ type: "material.process", payload: {} });

    const worker = new Worker();
    await worker.drain(10);

    const job = await db.job.findFirstOrThrow({ where: { type: "material.process" } });
    expect(["FAILED", "DEAD"]).toContain(job.status);
    expect(job.lastError).toBeTruthy();
  });

  it("treats a missing required payload field as permanent", async () => {
    await expect(
      handlers["mastery.recalculate"]({}, {
        jobId: "j",
        attempts: 1,
        traceId: "t",
        progress: async () => {},
      }),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe("event bus", () => {
  beforeEach(resetDatabase);

  it("publishes an event once, ignoring a duplicate", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    await publish(
      "MATERIAL_PROCESSED",
      { materialId: "m1", projectId: project.id, chunkCount: 3 },
      { userId: user.id, projectId: project.id },
    );
    await publish(
      "MATERIAL_PROCESSED",
      { materialId: "m1", projectId: project.id, chunkCount: 3 },
      { userId: user.id, projectId: project.id },
    );

    expect(await db.domainEvent.count()).toBe(1);
  });

  it("derives a stable dedupe key regardless of key order", () => {
    const a = eventDedupeKey("X", { a: 1, b: 2 });
    const b = eventDedupeKey("X", { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("fans an event out to downstream jobs and marks it processed", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    await publish(
      "MATERIAL_PROCESSED",
      { materialId: "m1", projectId: project.id, chunkCount: 3 },
      { userId: user.id, projectId: project.id },
    );

    const processed = await dispatchPendingEvents("t");
    expect(processed).toBe(1);

    const event = await db.domainEvent.findFirstOrThrow();
    expect(event.status).toBe("PROCESSED");

    // The reaction table enqueues a recommendation and an analytics rollup.
    const jobTypes = (await db.job.findMany({ select: { type: true } })).map((j) => j.type);
    expect(jobTypes).toContain("recommendation.generate");
    expect(jobTypes).toContain("analytics.rollup");
  });

  it("does not double-enqueue downstream work when an event is redelivered", async () => {
    const user = await makeUser();
    const { project } = await makeProject(user.id);

    await publish(
      "MATERIAL_PROCESSED",
      { materialId: "m1", projectId: project.id, chunkCount: 3 },
      { userId: user.id, projectId: project.id },
    );
    await dispatchPendingEvents("t");
    const afterFirst = await db.job.count();

    // Force a redelivery of the same event.
    await db.domainEvent.updateMany({ data: { status: "PENDING" } });
    await dispatchPendingEvents("t");

    expect(await db.job.count()).toBe(afterFirst);
  });

  it("does not lose the user's action when publishing fails", async () => {
    const spy = vi.spyOn(db.domainEvent, "create").mockRejectedValueOnce(new Error("db down"));
    // publish swallows the error rather than propagating it to the caller.
    await expect(
      publish("SPACE_CREATED", { spaceId: "s1" }, { userId: "u1" }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

afterAll(async () => {
  await db.$disconnect();
});
