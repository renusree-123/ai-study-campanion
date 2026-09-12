import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../errors";
import { env } from "../env";
import type {
  AiCallMeta,
  AiProvider,
  AiResult,
  DocumentUnderstandingRequest,
  GenerateStructuredRequest,
  GenerateTextRequest,
  StreamEvent,
  StreamResult,
} from "./types";

/**
 * Anthropic provider.
 *
 * Notes on the request shape, which is deliberate:
 *  - `thinking` is omitted. On claude-opus-5 that means adaptive thinking runs
 *    by default; passing budget_tokens would be rejected on this model family.
 *  - `temperature` is not sent. It was removed on the Opus 5 / Sonnet 5 family
 *    and returns a 400.
 *  - Structured output uses a forced strict tool rather than free-form JSON.
 *    `strict: true` makes the arguments schema-valid at the API level; we still
 *    re-validate with Zod because the application, not the model, owns the
 *    contract (PRD §42).
 */
export class AnthropicProvider implements AiProvider {
  readonly id = "anthropic";
  readonly isLive = true;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, model = env().AI_MODEL) {
    this.model = model;
    this.client = new Anthropic({
      apiKey,
      // The router owns retries so that every attempt is logged individually.
      maxRetries: 0,
      timeout: env().AI_TIMEOUT_MS,
    });
  }

  private system(request: GenerateTextRequest) {
    return request.cacheSystem
      ? [
          {
            type: "text" as const,
            text: request.system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : request.system;
  }

  async generateText(
    request: GenerateTextRequest,
    _meta: AiCallMeta,
  ): Promise<AiResult<string>> {
    const started = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      system: this.system(request),
      messages: request.messages,
      ...(request.stopSequences?.length ? { stop_sequences: request.stopSequences } : {}),
    });

    if (response.stop_reason === "refusal") {
      throw new AppError("AI_PROVIDER_ERROR", "The model declined this request.", {
        userMessage:
          "The assistant declined to answer this request. Try rephrasing your question.",
      });
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      value: text,
      usage: this.usage(response.usage),
      model: response.model,
      provider: this.id,
      latencyMs: Date.now() - started,
      stopReason: response.stop_reason,
    };
  }

  async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
    _meta: AiCallMeta,
  ): Promise<AiResult<T>> {
    const started = Date.now();
    // Structured output goes through the beta path: `strict: true` is only
    // available on the beta tool type in this SDK version. It makes the model's
    // arguments schema-valid at the API level, which removes the most common
    // class of structured-output failure before it reaches our validator.
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      betas: ["structured-outputs-2025-11-13"],
      system: this.system(request),
      messages: request.messages,
      tools: [
        {
          name: request.schemaName,
          description: request.schemaDescription,
          strict: true,
          input_schema: request.jsonSchema as Anthropic.Beta.BetaTool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: request.schemaName },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new AppError(
        "AI_INVALID_OUTPUT",
        `Model returned no ${request.schemaName} tool call (stop_reason=${response.stop_reason}).`,
      );
    }

    // Never string-match a serialised tool input — escaping varies by model.
    const parsed = request.schema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new AppError(
        "AI_INVALID_OUTPUT",
        `Model output failed ${request.schemaName} validation: ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
        { details: toolUse.input },
      );
    }

    return {
      value: parsed.data,
      usage: this.usage(response.usage),
      model: response.model,
      provider: this.id,
      latencyMs: Date.now() - started,
      stopReason: response.stop_reason,
    };
  }

  async streamText(
    request: GenerateTextRequest,
    _meta: AiCallMeta,
  ): Promise<StreamResult> {
    const started = Date.now();
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      system: this.system(request),
      messages: request.messages,
    });

    const self = this;
    async function* iterate(): AsyncIterable<StreamEvent> {
      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield { type: "text", text: event.delta.text };
          }
        }
        yield { type: "done" };
      } catch (error) {
        yield {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      stream: iterate(),
      final: async () => {
        const message = await stream.finalMessage();
        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
        return {
          value: text,
          usage: self.usage(message.usage),
          model: message.model,
          provider: self.id,
          latencyMs: Date.now() - started,
          stopReason: message.stop_reason,
        };
      },
    };
  }

  async understandDocument(
    request: DocumentUnderstandingRequest,
    _meta: AiCallMeta,
  ): Promise<AiResult<string>> {
    const started = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 8192,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: request.pdfBase64,
              },
            },
            { type: "text", text: request.instruction },
          ],
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      value: text,
      usage: this.usage(response.usage),
      model: response.model,
      provider: this.id,
      latencyMs: Date.now() - started,
      stopReason: response.stop_reason,
    };
  }

  async health() {
    const started = Date.now();
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 4,
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true, latencyMs: Date.now() - started, detail: `${this.model} reachable` };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private usage(usage: Anthropic.Usage) {
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedTokens: usage.cache_read_input_tokens ?? 0,
    };
  }
}
