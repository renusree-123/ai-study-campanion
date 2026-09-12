import { ai } from "./router";
import { jsonSchemaFor, type StructuredPrompt, type TextPrompt } from "./prompts/registry";
import type { AiResult, StreamResult } from "./types";

export interface RunContext {
  traceId: string;
  userId?: string;
  projectId?: string;
}

/**
 * Executes a registered prompt. This is the only way application code invokes
 * a model, which guarantees every call is attributed to a prompt id + version
 * in the observability tables.
 */
export async function runTextPrompt<Input>(
  prompt: TextPrompt<Input>,
  input: Input,
  context: RunContext,
  options: { cacheSystem?: boolean } = {},
): Promise<AiResult<string>> {
  return ai.generateText(
    {
      system: prompt.system(input),
      messages: [{ role: "user", content: prompt.render(input) }],
      maxTokens: prompt.maxTokens,
      cacheSystem: options.cacheSystem ?? true,
    },
    {
      feature: prompt.feature,
      promptId: prompt.id,
      promptVersion: prompt.version,
      ...context,
    },
  );
}

export async function streamTextPrompt<Input>(
  prompt: TextPrompt<Input>,
  input: Input,
  context: RunContext,
): Promise<StreamResult> {
  return ai.streamText(
    {
      system: prompt.system(input),
      messages: [{ role: "user", content: prompt.render(input) }],
      maxTokens: prompt.maxTokens,
      cacheSystem: true,
    },
    {
      feature: prompt.feature,
      promptId: prompt.id,
      promptVersion: prompt.version,
      ...context,
    },
  );
}

// JSON Schema derivation is pure and prompts are module singletons, so the
// result is memoised rather than recomputed on every call.
const schemaCache = new Map<string, Record<string, unknown>>();

export async function runStructuredPrompt<Input, Output>(
  prompt: StructuredPrompt<Input, Output>,
  input: Input,
  context: RunContext,
): Promise<AiResult<Output>> {
  const cacheKey = `${prompt.id}@${prompt.version}`;
  let jsonSchema = schemaCache.get(cacheKey);
  if (!jsonSchema) {
    jsonSchema = jsonSchemaFor(prompt);
    schemaCache.set(cacheKey, jsonSchema);
  }

  return ai.generateStructured<Output>(
    {
      system: prompt.system(input),
      messages: [{ role: "user", content: prompt.render(input) }],
      maxTokens: prompt.maxTokens,
      cacheSystem: true,
      schema: prompt.schema,
      jsonSchema,
      schemaName: prompt.schemaName,
      schemaDescription: prompt.schemaDescription,
    },
    {
      feature: prompt.feature,
      promptId: prompt.id,
      promptVersion: prompt.version,
      ...context,
    },
  );
}
