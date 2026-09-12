import { db } from "../db";
import { forbidden, notFound } from "../errors";
import type { SessionUser } from "./session";

/**
 * Ownership guards — the single choke point for data isolation (PRD §52).
 *
 * Every read or write that touches a Space/Project subtree resolves the entity
 * through one of these helpers first. They filter by `userId` in the WHERE
 * clause rather than fetching-then-comparing, so a miss is indistinguishable
 * from a non-existent row and cannot be used to probe for other users' ids.
 *
 * Administrators are deliberately NOT granted a bypass here: the admin surface
 * is read-only and uses its own explicitly-named queries. That keeps "admin
 * looked at it" and "owner acted on it" from ever sharing a code path.
 */

export interface OwnedProject {
  id: string;
  userId: string;
  spaceId: string;
  name: string;
  goal: string;
  description: string;
}

export async function assertSpaceAccess(userId: string, spaceId: string) {
  const space = await db.space.findFirst({
    where: { id: spaceId, userId, archivedAt: null },
  });
  if (!space) throw notFound("Space");
  return space;
}

export async function assertProjectAccess(
  userId: string,
  projectId: string,
): Promise<OwnedProject> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId, archivedAt: null },
    select: { id: true, userId: true, spaceId: true, name: true, goal: true, description: true },
  });
  if (!project) throw notFound("Project");
  return project;
}

export async function assertMaterialAccess(userId: string, materialId: string) {
  const material = await db.material.findFirst({ where: { id: materialId, userId } });
  if (!material) throw notFound("Material");
  return material;
}

export async function assertConversationAccess(userId: string, conversationId: string) {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, userId },
  });
  if (!conversation) throw notFound("Conversation");
  return conversation;
}

export async function assertQuizAccess(userId: string, quizId: string) {
  const quiz = await db.quiz.findFirst({ where: { id: quizId, userId } });
  if (!quiz) throw notFound("Quiz");
  return quiz;
}

/**
 * Ownership context for background work. Jobs carry `{userId, projectId}` in
 * their payload; before touching anything a handler re-verifies the pair still
 * exists and still belongs together. This stops a stale or tampered job
 * payload from writing across a tenancy boundary long after enqueue.
 */
export async function resolveJobOwnership(userId: string, projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, userId: true, spaceId: true, name: true, goal: true, description: true },
  });
  if (!project) {
    throw forbidden(`Job ownership check failed for project ${projectId}`);
  }
  return project;
}

export function assertSelfOrAdmin(actor: SessionUser, targetUserId: string) {
  if (actor.id !== targetUserId && actor.role !== "ADMIN") throw forbidden();
}
