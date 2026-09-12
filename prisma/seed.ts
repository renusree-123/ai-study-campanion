/**
 * Seed data.
 *
 * Creates a demo learner and an administrator, two Spaces with Projects, and
 * two generated PDFs. Materials are enqueued for real background processing
 * rather than having chunks written directly, so a freshly seeded database
 * exercises the same pipeline a real upload would — and `npm run db:seed`
 * doubles as a smoke test of it.
 */
import "../src/lib/load-env";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { materialKey, storage } from "../src/lib/storage";
import { buildDocument } from "./sample/pdf-writer";
import { CLIMATE_DOC, SPACED_REPETITION_DOC } from "./sample/content";
import { recordActivity } from "../src/lib/activity";
import { publish } from "../src/lib/events/bus";
import { scheduleAfterUpload } from "../src/lib/jobs/handlers";
import { Worker } from "../src/lib/jobs/worker";
import { logger } from "../src/lib/logger";

const DEMO_EMAIL = "learner@demo.dev";
const ADMIN_EMAIL = "admin@demo.dev";
const PASSWORD = "demo-password-123";

async function main() {
  console.log("Seeding AI Study Companion…\n");

  const [learnerHash, adminHash] = await Promise.all([
    hashPassword(PASSWORD),
    hashPassword(PASSWORD),
  ]);

  const learner = await db.user.upsert({
    where: { email: DEMO_EMAIL },
    create: { email: DEMO_EMAIL, name: "Demo Learner", passwordHash: learnerHash, role: "USER" },
    update: {},
  });

  const admin = await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: { email: ADMIN_EMAIL, name: "Demo Admin", passwordHash: adminHash, role: "ADMIN" },
    update: { role: "ADMIN" },
  });

  console.log(`  users: ${learner.email} (learner), ${admin.email} (admin)`);

  // Idempotent: re-seeding the same database reuses these rows.
  const studySpace = await upsertSpace(learner.id, {
    name: "Learning How to Learn",
    description: "Evidence-based study technique, and applying it to my own revision.",
    color: "indigo",
    icon: "brain",
  });

  const climateSpace = await upsertSpace(learner.id, {
    name: "Climate & Earth Systems",
    description: "Building a working understanding of how the climate system behaves.",
    color: "emerald",
    icon: "globe",
  });

  const studyProject = await upsertProject(learner.id, studySpace.id, {
    name: "Spaced Repetition & Retrieval",
    description: "The core cognitive techniques behind durable learning.",
    goal: "Be able to explain spacing, retrieval practice and interleaving well enough to design my own revision schedule.",
  });

  const climateProject = await upsertProject(learner.id, climateSpace.id, {
    name: "Radiative Balance & Feedbacks",
    description: "How energy flows through the climate system.",
    goal: "Understand radiative forcing and feedback mechanisms well enough to reason about model uncertainty.",
  });

  console.log(`  spaces: 2, projects: 2`);

  await seedMaterial(learner.id, studyProject.id, SPACED_REPETITION_DOC);
  await seedMaterial(learner.id, climateProject.id, CLIMATE_DOC);

  console.log("\n  Processing materials through the real background pipeline…");
  const worker = new Worker();
  // Drain repeatedly: processing enqueues follow-on jobs (events, rollups,
  // recommendations) which themselves enqueue more.
  for (let pass = 0; pass < 6; pass += 1) {
    const drained = await worker.drain(100);
    const { dispatchPendingEvents } = await import("../src/lib/events/dispatcher");
    const dispatched = await dispatchPendingEvents("seed");
    if (drained === 0 && dispatched === 0) break;
    console.log(`    pass ${pass + 1}: ${drained} jobs, ${dispatched} events`);
  }

  const ready = await db.material.count({ where: { status: "READY" } });
  const failed = await db.material.findMany({
    where: { status: "FAILED" },
    select: { filename: true, error: true },
  });
  const chunks = await db.materialChunk.count();
  const concepts = await db.concept.count();

  console.log(`\n  materials ready: ${ready}, chunks: ${chunks}, concepts: ${concepts}`);
  for (const f of failed) console.log(`  ! FAILED ${f.filename}: ${f.error}`);

  console.log(`
Done.

  Learner   ${DEMO_EMAIL} / ${PASSWORD}
  Admin     ${ADMIN_EMAIL} / ${PASSWORD}

  Start the app with:  npm run dev
`);
}

async function upsertSpace(
  userId: string,
  data: { name: string; description: string; color: string; icon: string },
) {
  const existing = await db.space.findFirst({ where: { userId, name: data.name } });
  if (existing) return existing;
  const space = await db.space.create({
    data: { ...data, userId, lastAccessedAt: new Date() },
  });
  await recordActivity({
    userId,
    spaceId: space.id,
    type: "SPACE_CREATED",
    summary: `Created space "${space.name}"`,
  });
  return space;
}

async function upsertProject(
  userId: string,
  spaceId: string,
  data: { name: string; description: string; goal: string },
) {
  const existing = await db.project.findFirst({ where: { userId, spaceId, name: data.name } });
  if (existing) return existing;
  const project = await db.project.create({
    data: { ...data, userId, spaceId, lastAccessedAt: new Date() },
  });
  await recordActivity({
    userId,
    spaceId,
    projectId: project.id,
    type: "PROJECT_CREATED",
    summary: `Created project "${project.name}"`,
  });
  await publish("PROJECT_CREATED", { projectId: project.id, spaceId }, { userId, projectId: project.id });
  return project;
}

async function seedMaterial(
  userId: string,
  projectId: string,
  doc: { filename: string; title: string; sections: { heading: string; paragraphs: string[] }[] },
) {
  const existing = await db.material.findFirst({
    where: { projectId, filename: doc.filename },
  });
  if (existing) {
    console.log(`  material already present: ${doc.filename}`);
    return existing;
  }

  const pdf = buildDocument(doc.title, doc.sections);

  // Also drop a copy in the repo so the demo has a file to re-upload by hand.
  const sampleDir = path.join(process.cwd(), "prisma", "sample", "generated");
  mkdirSync(sampleDir, { recursive: true });
  writeFileSync(path.join(sampleDir, doc.filename), pdf);

  const { key, checksum } = materialKey(userId, projectId, doc.filename, pdf);
  await storage().put(key, pdf);

  const material = await db.material.create({
    data: {
      projectId,
      userId,
      filename: doc.filename,
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
      storageKey: key,
      checksum,
      status: "QUEUED",
      stage: "QUEUED",
    },
  });

  await recordActivity({
    userId,
    projectId,
    type: "MATERIAL_UPLOADED",
    summary: `Uploaded ${doc.filename}`,
    payload: { materialId: material.id },
  });

  await publish(
    "MATERIAL_UPLOADED",
    { materialId: material.id, projectId },
    { userId, projectId },
  );

  await scheduleAfterUpload(material.id, userId, projectId);
  console.log(`  material queued: ${doc.filename} (${Math.round(pdf.length / 1024)} KB)`);
  return material;
}

main()
  .catch((error) => {
    logger.error("seed_failed", { error });
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
