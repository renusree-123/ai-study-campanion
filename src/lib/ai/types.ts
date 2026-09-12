import type { ZodSchema } from "zod";

/**
 * Provider-agnostic AI interfaces (PRD §41).
 *
 * Application code never imports the Anthropic SDK directly — it depends on
 * these interfaces. That buys three things: the offline provider can satisfy
 * the same contract so the product runs with no API key, the router can add
 * retries/fallback/usage-accounting in one place, and swapping or adding a
 * provider is a new file rather than a refactor.
 */

export type AiFeature =
  | "TUTOR"
  | "QUIZ_GENERATION"
  | "OPEN_GRADING"
  | "CONCEPT_EXTRACTION"
  | "SUMMARISATION"
  | "RECOMMENDATION"
  | "CONTEXT_DISTILLATION"
  | "RERANK"
  | "DOC_UNDERSTANDING"
  | "EVALUATION"
  | "CLASSIFICATION";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiCallMeta {
  feature: AiFeature;
  promptId: string;
  promptVersion: string;
  traceId: string;
  userId?: string;
  projectId?: string;
}

export interface GenerateTextRequest {
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
  /** Cache the system prompt prefix. Worth it for long, stable instructions. */
  cacheSystem?: boolean;
  stopSequences?: string[];
}

export interface GenerateStructuredRequest<T> extends GenerateTextRequest {
  /** Zod schema the output is validated against before it is returned. */
  schema: ZodSchema<T>;
  /** JSON Schema handed to the model. Must match `schema`. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  schemaDescription: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface AiResult<T> {
  value: T;
  usage: AiUsage;
  model: string;
  provider: string;
  latencyMs: number;
  stopReason?: string | null;
}

export interface StreamEvent {
  type: "text" | "done" | "error";
  text?: string;
  error?: string;
}

export interface StreamResult {
  stream: AsyncIterable<StreamEvent>;
  /** Resolves once the stream is fully consumed. */
  final: () => Promise<AiResult<string>>;
}

export interface DocumentUnderstandingRequest {
  /** Raw PDF bytes, base64 encoded, no newlines. */
  pdfBase64: string;
  instruction: string;
  maxTokens?: number;
}

export interface AiProvider {
  readonly id: string;
  /** Model this provider instance will use unless overridden. */
  readonly model: string;
  /** False for the offline provider — surfaced in the admin AI dashboard. */
  readonly isLive: boolean;

  generateText(request: GenerateTextRequest, meta: AiCallMeta): Promise<AiResult<string>>;

  generateStructured<T>(
    request: GenerateStructuredRequest<T>,
    meta: AiCallMeta,
  ): Promise<AiResult<T>>;

  streamText(request: GenerateTextRequest, meta: AiCallMeta): Promise<StreamResult>;

  /**
   * Native PDF understanding — used as the OCR/table/diagram path when plain
   * text extraction yields too little for a page range.
   */
  understandDocument(
    request: DocumentUnderstandingRequest,
    meta: AiCallMeta,
  ): Promise<AiResult<string>>;

  health(): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
}
