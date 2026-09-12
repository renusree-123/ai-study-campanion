import { z, type ZodTypeAny } from "zod";
import { db } from "../db";
import { logger } from "../logger";
import { AppError, errorMessage } from "../errors";
import { truncate } from "./text";
import { assertProjectAccess } from "../auth/ownership";
import { searchProject, sourceLabel } from "../retrieval/search";
import { getProjectMastery, getWeakConcepts } from "../domain/mastery";
import { retrieveContext, upsertContextItem } from "../domain/learning-context";
import { recordActivity } from "../activity";
import { toJsonSchema } from "./schema";

/**
 * AI application capabilities (PRD §22, §23).
 *
 * The model never touches the database. It can only request one of the
 * capabilities registered here, and every request goes through the same gate:
 *
 *   model output -> schema validation -> authorisation -> side-effect policy
 *                -> execute -> audit row -> result
 *
 * Three properties make this safe rather than decorative:
 *
 *  - **Authorisation is re-derived server-side.** The `userId` and `projectId`
 *    come from the authenticated session in the invocation context, never from
 *    the model's arguments. A model asking to read project X gets whatever
 *    project the *session* is scoped to; it cannot name another one.
 *
 *  - **Arguments are validated before execution**, not coerced. An argument
 *    that fails its schema is rejected and audited as INVALID_ARGS.
 *
 *  - **State-changing capabilities are opt-in per call site.** A tool declares
 *    `mutates: true`, and the caller must explicitly allow mutations. The tutor
 *    read path runs with mutations disabled, so no amount of prompt injection
 *    in an uploaded PDF can cause a write.
 *
 * Every invocation is written to ToolInvocation, so the admin surface can
 * answer "what did the AI actually do?".
 */

export interface ToolContext {
  userId: string;
  projectId: string;
  traceId: string;
  /** When false, tools declaring `mutates` are refused. */
  allowMutations: boolean;
}

export interface ToolDefinition<Schema extends ZodTypeAny, Result> {
  name: string;
  description: string;
  /** Validated before execution; also rendered as the JSON Schema for the model. */
  schema: Schema;
  /** True if the tool changes application state. */
  mutates: boolean;
  execute(args: z.infer<Schema>, context: ToolContext): Promise<Result>;
  /** One-line summary written to the audit row. */
  summarise(result: Result): string;
}

type AnyToolDefinition = ToolDefinition<ZodTypeAny, any>;

const tools = new Map<string, AnyToolDefinition>();

function defineTool<Schema extends ZodTypeAny, Result>(
  definition: ToolDefinition<Schema, Result>,
) {
  tools.set(definition.name, definition as unknown as AnyToolDefinition);
  return definition;
}

export function listTools() {
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    mutates: tool.mutates,
    inputSchema: toJsonSchema(tool.schema),
  }));
}

export interface ToolOutcome {
  ok: boolean;
  name: string;
  result?: unknown;
  error?: string;
  status: "SUCCESS" | "DENIED" | "INVALID_ARGS" | "ERROR" | "NOT_FOUND";
  latencyMs: number;
}

/**
 * The single entry point for AI-initiated capability calls. Never throws — a
 * tool failure is returned to the model as a structured error so it can adapt,
 * rather than crashing the surrounding request.
 */
export async function invokeTool(
  name: string,
  rawArgs: unknown,
  context: ToolContext,
): Promise<ToolOutcome> {
  const started = Date.now();
  const tool = tools.get(name);

  const audit = async (
    status: ToolOutcome["status"],
    extra: { error?: string; denyReason?: string; summary?: string; args?: unknown },
  ) => {
    try {
      await db.toolInvocation.create({
        data: {
          traceId: context.traceId,
          userId: context.userId,
          projectId: context.projectId,
          toolName: name,
          args: truncate(JSON.stringify(extra.args ?? rawArgs ?? {}), 2000),
          status,
          denyReason: extra.denyReason ?? null,
          error: extra.error ? truncate(extra.error, 500) : null,
          latencyMs: Date.now() - started,
          resultSummary: truncate(extra.summary ?? "", 300),
        },
      });
    } catch (error) {
      logger.warn("tool_audit_failed", { traceId: context.traceId, name, error });
    }
  };

  if (!tool) {
    await audit("NOT_FOUND", { error: `Unknown capability "${name}"` });
    return {
      ok: false,
      name,
      status: "NOT_FOUND",
      error: `No such capability: ${name}`,
      latencyMs: Date.now() - started,
    };
  }

  // 1. Side-effect policy, before anything is parsed or executed.
  if (tool.mutates && !context.allowMutations) {
    await audit("DENIED", {
      denyReason: "State-changing capability requested from a read-only context.",
    });
    logger.warn("tool_mutation_denied", { traceId: context.traceId, name });
    return {
      ok: false,
      name,
      status: "DENIED",
      error: "This capability cannot change state in the current context.",
      latencyMs: Date.now() - started,
    };
  }

  // 2. Argument validation.
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    await audit("INVALID_ARGS", { error: message });
    return {
      ok: false,
      name,
      status: "INVALID_ARGS",
      error: `Invalid arguments: ${message}`,
      latencyMs: Date.now() - started,
    };
  }

  // 3. Authorisation, re-derived from the session context.
  try {
    await assertProjectAccess(context.userId, context.projectId);
  } catch {
    await audit("DENIED", { denyReason: "Caller does not own the target project." });
    return {
      ok: false,
      name,
      status: "DENIED",
      error: "Not authorised for this project.",
      latencyMs: Date.now() - started,
    };
  }

  // 4. Execute.
  try {
    const result = await tool.execute(parsed.data, context);
    await audit("SUCCESS", { summary: tool.summarise(result), args: parsed.data });
    return { ok: true, name, result, status: "SUCCESS", latencyMs: Date.now() - started };
  } catch (error) {
    const message = errorMessage(error);
    await audit("ERROR", { error: message, args: parsed.data });
    logger.error("tool_execution_failed", { traceId: context.traceId, name, error });
    return {
      ok: false,
      name,
      status: "ERROR",
      error: error instanceof AppError ? error.userMessage : "The capability failed to run.",
      latencyMs: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// Read capabilities
// ---------------------------------------------------------------------------

export const searchMaterialsTool = defineTool({
  name: "search_project_materials",
  description:
    "Search this project's processed learning materials for passages relevant to a query. Returns text with document name and page number.",
  mutates: false,
  schema: z.object({
    query: z.string().min(2).max(400).describe("What to search for"),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  async execute(args, context) {
    const result = await searchProject({
      projectId: context.projectId,
      userId: context.userId,
      query: args.query,
      limit: args.limit,
      traceId: context.traceId,
      rerank: false,
    });
    return {
      passages: result.chunks.map((chunk) => ({
        source: sourceLabel(chunk),
        text: truncate(chunk.content, 900),
        chunkId: chunk.chunkId,
      })),
    };
  },
  summarise: (result) => `${result.passages.length} passages`,
});

export const getMasteryTool = defineTool({
  name: "get_learner_mastery",
  description:
    "Get the learner's current mastery level for each concept in this project, with trend.",
  mutates: false,
  schema: z.object({}),
  async execute(_args, context) {
    const mastery = await getProjectMastery(context.projectId);
    return {
      concepts: mastery.map((m) => ({
        name: m.name,
        level: Math.round(m.level * 100) / 100,
        trend: m.trend,
        attempts: m.attemptCount,
      })),
    };
  },
  summarise: (result) => `${result.concepts.length} concepts`,
});

export const getWeakConceptsTool = defineTool({
  name: "get_weak_concepts",
  description: "Get the concepts this learner most needs to work on, strongest need first.",
  mutates: false,
  schema: z.object({ limit: z.number().int().min(1).max(10).default(5) }),
  async execute(args, context) {
    const weak = await getWeakConcepts(context.projectId, args.limit);
    return {
      concepts: weak.map((c) => ({
        name: c.name,
        level: Math.round(c.level * 100) / 100,
        trend: c.trend,
        accuracy: Math.round(c.accuracy * 100) / 100,
      })),
    };
  },
  summarise: (result) => result.concepts.map((c) => c.name).join(", ") || "none",
});

export const getAssessmentHistoryTool = defineTool({
  name: "get_assessment_history",
  description:
    "Get the learner's recent quiz answers in this project, including what they got wrong.",
  mutates: false,
  schema: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
  async execute(args, context) {
    const answers = await db.quizAnswer.findMany({
      where: { quiz: { projectId: context.projectId }, userId: context.userId },
      orderBy: { answeredAt: "desc" },
      take: args.limit,
      include: { question: { include: { concept: true } } },
    });
    return {
      answers: answers.map((answer) => ({
        concept: answer.question.concept?.name ?? "General",
        question: truncate(answer.question.prompt, 200),
        correct: answer.isCorrect,
        score: answer.score,
        difficulty: answer.question.difficulty,
        answeredAt: answer.answeredAt.toISOString(),
      })),
    };
  },
  summarise: (result) => `${result.answers.length} recent answers`,
});

export const getLearnerContextTool = defineTool({
  name: "get_learner_context",
  description:
    "Get durable facts remembered about this learner: goals, preferences, known strengths and difficulties.",
  mutates: false,
  schema: z.object({ query: z.string().max(300).default("") }),
  async execute(args, context) {
    const items = await retrieveContext({
      userId: context.userId,
      projectId: context.projectId,
      query: args.query,
      limit: 10,
    });
    return { items: items.map((i) => ({ kind: i.kind, content: i.content })) };
  },
  summarise: (result) => `${result.items.length} context items`,
});

export const getProjectAnalyticsTool = defineTool({
  name: "get_project_analytics",
  description: "Get activity and performance totals for this project.",
  mutates: false,
  schema: z.object({}),
  async execute(_args, context) {
    const [messages, quizzes, answers, materials] = await Promise.all([
      db.message.count({
        where: { conversation: { projectId: context.projectId }, role: "user" },
      }),
      db.quiz.count({ where: { projectId: context.projectId, status: "COMPLETED" } }),
      db.quizAnswer.findMany({
        where: { quiz: { projectId: context.projectId } },
        select: { isCorrect: true },
      }),
      db.material.count({ where: { projectId: context.projectId, status: "READY" } }),
    ]);
    const correct = answers.filter((a) => a.isCorrect).length;
    return {
      tutorQuestions: messages,
      quizzesCompleted: quizzes,
      questionsAnswered: answers.length,
      accuracy: answers.length > 0 ? Math.round((correct / answers.length) * 100) / 100 : 0,
      materialsReady: materials,
    };
  },
  summarise: (result) => `${result.questionsAnswered} answers, ${result.accuracy} accuracy`,
});

// ---------------------------------------------------------------------------
// Write capabilities — only reachable when allowMutations is true
// ---------------------------------------------------------------------------

export const recordLearningContextTool = defineTool({
  name: "record_learning_context",
  description:
    "Remember a durable fact about this learner for future sessions, such as a goal, a preference, or a recurring difficulty.",
  mutates: true,
  schema: z.object({
    kind: z.enum(["GOAL", "PREFERENCE", "STRENGTH", "WEAKNESS", "DIFFICULTY", "TUTOR_NOTE"]),
    content: z.string().min(8).max(240),
  }),
  async execute(args, context) {
    const item = await upsertContextItem({
      userId: context.userId,
      projectId: context.projectId,
      kind: args.kind,
      content: args.content,
      source: "TUTOR",
      salience: args.kind === "GOAL" ? 0.9 : 0.6,
    });
    return { saved: Boolean(item), kind: args.kind };
  },
  summarise: (result) => (result.saved ? `saved ${result.kind}` : "not saved"),
});

export const recordLearningEventTool = defineTool({
  name: "record_learning_event",
  description: "Record a noteworthy learning activity on the learner's timeline.",
  mutates: true,
  schema: z.object({
    summary: z.string().min(5).max(200),
  }),
  async execute(args, context) {
    await recordActivity({
      userId: context.userId,
      projectId: context.projectId,
      type: "INSIGHT_GENERATED",
      summary: args.summary,
      payload: { source: "ai_tool" },
    });
    return { recorded: true };
  },
  summarise: () => "activity recorded",
});

/** Tool set exposed to the tutor's read path — deliberately read-only. */
export const TUTOR_READ_TOOLS = [
  searchMaterialsTool.name,
  getMasteryTool.name,
  getWeakConceptsTool.name,
  getAssessmentHistoryTool.name,
  getLearnerContextTool.name,
  getProjectAnalyticsTool.name,
];
