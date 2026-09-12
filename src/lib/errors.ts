/** Application error taxonomy. Every thrown AppError maps to a stable HTTP shape. */
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "AI_PROVIDER_ERROR"
  | "AI_TIMEOUT"
  | "AI_INVALID_OUTPUT"
  | "RETRIEVAL_ERROR"
  | "BUDGET_EXCEEDED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  AI_PROVIDER_ERROR: 502,
  AI_TIMEOUT: 504,
  AI_INVALID_OUTPUT: 502,
  RETRIEVAL_ERROR: 500,
  BUDGET_EXCEEDED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Safe to show a user verbatim. */
  readonly userMessage: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; userMessage?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details;
    this.userMessage = options.userMessage ?? message;
  }
}

export const badRequest = (m: string, details?: unknown) =>
  new AppError("BAD_REQUEST", m, { details });
export const unauthenticated = (m = "You need to sign in to do that.") =>
  new AppError("UNAUTHENTICATED", m);
export const forbidden = (m = "You do not have access to this resource.") =>
  new AppError("FORBIDDEN", m);
export const notFound = (what = "Resource") =>
  new AppError("NOT_FOUND", `${what} not found.`);
export const conflict = (m: string) => new AppError("CONFLICT", m);
export const internal = (m = "Something went wrong.", cause?: unknown) =>
  new AppError("INTERNAL", m, { cause });

/** Errors worth retrying from a background job or the AI router. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) {
    return (
      error.code === "AI_PROVIDER_ERROR" ||
      error.code === "AI_TIMEOUT" ||
      error.code === "RATE_LIMITED" ||
      error.code === "INTERNAL"
    );
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("fetch failed") ||
    message.includes("overloaded") ||
    message.includes("rate limit") ||
    message.includes("database is locked")
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
