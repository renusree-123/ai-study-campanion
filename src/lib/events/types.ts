/**
 * Domain event catalogue (PRD §37, §38).
 *
 * Events are the seam between "something happened" and "therefore do this".
 * Producers record the fact; the dispatcher decides which workflows react. New
 * event types and new reactions can be added without touching the producers.
 */
export type DomainEventType =
  | "SPACE_CREATED"
  | "PROJECT_CREATED"
  | "MATERIAL_UPLOADED"
  | "MATERIAL_PROCESSED"
  | "MATERIAL_FAILED"
  | "TUTOR_INTERACTION_COMPLETED"
  | "CONVERSATION_STARTED"
  | "QUIZ_STARTED"
  | "QUESTION_ANSWERED"
  | "QUIZ_COMPLETED"
  | "MASTERY_UPDATED"
  | "WEAK_CONCEPT_DETECTED"
  | "REPEATED_MISTAKE_DETECTED"
  | "RECOMMENDATION_GENERATED";

export interface DomainEventPayloads {
  SPACE_CREATED: { spaceId: string };
  PROJECT_CREATED: { projectId: string; spaceId: string };
  MATERIAL_UPLOADED: { materialId: string; projectId: string };
  MATERIAL_PROCESSED: { materialId: string; projectId: string; chunkCount: number };
  MATERIAL_FAILED: { materialId: string; projectId: string; reason: string };
  TUTOR_INTERACTION_COMPLETED: {
    conversationId: string;
    projectId: string;
    messageId: string;
    grounding: string;
  };
  CONVERSATION_STARTED: { conversationId: string; projectId: string };
  QUIZ_STARTED: { quizId: string; projectId: string };
  QUESTION_ANSWERED: {
    quizId: string;
    questionId: string;
    projectId: string;
    conceptId: string | null;
    score: number;
    isCorrect: boolean;
  };
  QUIZ_COMPLETED: { quizId: string; projectId: string; score: number };
  MASTERY_UPDATED: { projectId: string; conceptIds: string[] };
  WEAK_CONCEPT_DETECTED: { projectId: string; conceptId: string; level: number };
  REPEATED_MISTAKE_DETECTED: { projectId: string; conceptId: string; occurrences: number };
  RECOMMENDATION_GENERATED: { projectId: string; recommendationId: string };
}
