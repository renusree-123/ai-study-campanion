import { NextResponse } from "next/server";
import { ZodError, type TypeOf, type ZodTypeAny } from "zod";
import { AppError, errorMessage } from "./errors";
import { logger, newTraceId } from "./logger";

/**
 * Consistent API envelope.
 *   success -> { data, meta? }
 *   failure -> { error: { code, message, details? }, traceId }
 */
export interface ApiMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  hasMore?: boolean;
  traceId?: string;
  [key: string]: unknown;
}

export function ok<T>(data: T, meta?: ApiMeta, status = 200) {
  return NextResponse.json({ data, ...(meta ? { meta } : {}) }, { status });
}

export function created<T>(data: T, meta?: ApiMeta) {
  return ok(data, meta, 201);
}

export function fail(error: unknown, traceId = newTraceId()) {
  if (error instanceof AppError) {
    // 4xx is the client's problem and expected traffic; only log 5xx loudly.
    const log = error.status >= 500 ? logger.error : logger.warn;
    log.call(logger, "api_error", { traceId, code: error.code, error: error.message });
    return NextResponse.json(
      {
        error: { code: error.code, message: error.userMessage, details: error.details },
        traceId,
      },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The request body failed validation.",
          details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        traceId,
      },
      { status: 422 },
    );
  }
  logger.error("api_unhandled_error", { traceId, error });
  return NextResponse.json(
    {
      // Never leak an internal message to the client.
      error: { code: "INTERNAL", message: "Something went wrong. Please try again." },
      traceId,
    },
    { status: 500 },
  );
}

/**
 * Wraps a route handler with tracing, timing and the error envelope so no
 * handler has to repeat try/catch.
 */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    const traceId = newTraceId();
    const started = Date.now();
    try {
      const response = await fn(...args);
      response.headers.set("x-trace-id", traceId);
      logger.debug("api_request", { traceId, durationMs: Date.now() - started });
      return response;
    } catch (error) {
      return fail(error, traceId);
    }
  };
}

/**
 * Parse and validate a JSON body, mapping malformed JSON to a 400.
 *
 * Generic over the schema rather than over the parsed type, so `.default()`
 * and `.optional()` produce the correct *output* type at the call site — with
 * `ZodSchema<T>` the input and output types are forced equal and every
 * defaulted field would surface as possibly-undefined.
 */
export async function parseBody<S extends ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<TypeOf<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError("VALIDATION_ERROR", "The request body failed validation.", {
      details: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}

/** Parse and validate query string parameters. */
export function parseQuery<S extends ZodTypeAny>(request: Request, schema: S): TypeOf<S> {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid query parameters.", {
      details: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return result.data;
}

export function assertOk(condition: unknown, error: AppError): asserts condition {
  if (!condition) throw error;
}

export { errorMessage };
