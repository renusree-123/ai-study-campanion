import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { logger } from "./logger";

/**
 * Activity tracking (PRD §37).
 *
 * `type` is an open string rather than an enum so new activity types need no
 * migration — the requirement is explicit about that. The known set below
 * exists for typing at call sites and for the admin filter dropdown; an
 * unrecognised type still renders, using its raw label.
 */
export const ACTIVITY_TYPES = {
  SPACE_CREATED: "Space created",
  SPACE_UPDATED: "Space updated",
  PROJECT_CREATED: "Project created",
  PROJECT_UPDATED: "Project updated",
  PROJECT_ACCESSED: "Project opened",
  MATERIAL_UPLOADED: "Material uploaded",
  MATERIAL_PROCESSING_STARTED: "Material processing started",
  MATERIAL_PROCESSING_COMPLETED: "Material processed",
  MATERIAL_PROCESSING_FAILED: "Material processing failed",
  MATERIAL_DELETED: "Material deleted",
  CONVERSATION_STARTED: "Tutor conversation started",
  TUTOR_QUESTION_ASKED: "Tutor question asked",
  QUIZ_STARTED: "Quiz started",
  QUESTION_ANSWERED: "Question answered",
  QUIZ_COMPLETED: "Quiz completed",
  MASTERY_UPDATED: "Mastery updated",
  RECOMMENDATION_GENERATED: "Recommendation generated",
  RECOMMENDATION_COMPLETED: "Recommendation completed",
  LEARNING_CONTEXT_UPDATED: "Learning context updated",
  INSIGHT_GENERATED: "Learning insight generated",
} as const;

export type ActivityType = keyof typeof ACTIVITY_TYPES;

export function activityLabel(type: string): string {
  return (ACTIVITY_TYPES as Record<string, string>)[type] ?? type.replace(/_/g, " ").toLowerCase();
}

export interface RecordActivityInput {
  userId: string;
  type: ActivityType | (string & {});
  summary?: string;
  spaceId?: string | null;
  projectId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Records a user-visible activity row. Accepts a transaction client so the
 * activity can be committed atomically with the action it describes.
 *
 * Failures are logged and swallowed: an audit-trail write is never worth
 * failing the user's action over.
 */
export async function recordActivity(
  input: RecordActivityInput,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<void> {
  try {
    await client.activityEvent.create({
      data: {
        userId: input.userId,
        type: input.type,
        summary: input.summary ?? activityLabel(input.type),
        spaceId: input.spaceId ?? null,
        projectId: input.projectId ?? null,
        payload: JSON.stringify(input.payload ?? {}),
      },
    });
  } catch (error) {
    logger.warn("activity_record_failed", { type: input.type, error });
  }
}
