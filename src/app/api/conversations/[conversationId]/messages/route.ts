import { z } from "zod";
import { db } from "@/lib/db";
import { AppError, errorMessage } from "@/lib/errors";
import { fail, handler, parseBody } from "@/lib/http";
import { logger, newTraceId } from "@/lib/logger";
import { truncate } from "@/lib/ai/text";
import { requireUser } from "@/lib/auth/session";
import { assertConversationAccess, assertProjectAccess } from "@/lib/auth/ownership";
import { classifyGrounding, streamAnswer } from "@/lib/domain/tutor";
import { recordActivity } from "@/lib/activity";
import { publish } from "@/lib/events/bus";

type Params = { params: Promise<{ conversationId: string }> };

const schema = z.object({ content: z.string().min(1).max(4000) });

/**
 * Streams a tutor answer as Server-Sent Events.
 *
 * The response starts flowing as soon as the model produces its first token,
 * so the learner is not staring at a spinner while retrieval, reranking and
 * generation complete (PRD §51). Persistence happens after the stream closes:
 * the assistant row is written with the full text, its citations and a
 * grounding classification, and only then is the downstream workflow event
 * published.
 *
 * Event protocol (all JSON payloads):
 *   meta   — retrieval stats and citations, sent before the first token
 *   delta  — { text }
 *   done   — { messageId, grounding, citations, latencyMs }
 *   error  — { message }
 */
export const POST = handler(async (request: Request, { params }: Params) => {
  const user = await requireUser();
  const { conversationId } = await params;
  const traceId = newTraceId();

  const conversation = await assertConversationAccess(user.id, conversationId);
  const project = await assertProjectAccess(user.id, conversation.projectId);
  const body = await parseBody(request, schema);

  const readyMaterials = await db.material.count({
    where: { projectId: project.id, status: "READY" },
  });
  if (readyMaterials === 0) {
    throw new AppError("CONFLICT", "This project has no processed materials yet.", {
      userMessage:
        "This project has no processed materials yet, so the tutor has nothing to ground its answers in. Upload a PDF first.",
    });
  }

  // Persist the learner's message immediately, so a failure mid-answer still
  // leaves a coherent transcript rather than losing the question.
  const userMessage = await db.message.create({
    data: { conversationId, role: "user", content: body.content, status: "COMPLETE" },
  });

  await db.conversation.update({
    where: { id: conversationId },
    data: {
      messageCount: { increment: 1 },
      lastMessageAt: new Date(),
      // Name the thread after its opening question.
      ...(conversation.messageCount === 0
        ? { title: truncate(body.content.replace(/\s+/g, " "), 60) }
        : {}),
    },
  });

  await recordActivity({
    userId: user.id,
    projectId: project.id,
    spaceId: project.spaceId,
    type: "TUTOR_QUESTION_ASKED",
    summary: truncate(body.content.replace(/\s+/g, " "), 120),
    payload: { conversationId, messageId: userMessage.id },
  });

  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const { bundle, stream: modelStream } = await streamAnswer({
          project,
          conversationId,
          question: body.content,
          userId: user.id,
          traceId,
        });

        send("meta", {
          retrievedCount: bundle.retrievedCount,
          retrievalLatencyMs: bundle.retrievalLatencyMs,
          citations: bundle.citations,
        });

        let text = "";
        for await (const event of modelStream.stream) {
          if (event.type === "text" && event.text) {
            text += event.text;
            send("delta", { text: event.text });
          } else if (event.type === "error") {
            throw new Error(event.error ?? "stream failed");
          }
        }

        const final = await modelStream.final();
        const answer = final.value || text;
        const grounding = classifyGrounding(answer, bundle.evidence);
        const citations = grounding === "UNSUPPORTED" ? [] : bundle.citations;

        const assistantMessage = await db.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: answer,
            status: "COMPLETE",
            citations: JSON.stringify(citations),
            grounding,
            model: final.model,
            traceId,
            latencyMs: Date.now() - started,
            inputTokens: final.usage.inputTokens,
            outputTokens: final.usage.outputTokens,
          },
        });

        await db.conversation.update({
          where: { id: conversationId },
          data: { messageCount: { increment: 1 }, lastMessageAt: new Date() },
        });
        await db.project.update({
          where: { id: project.id },
          data: { tutorMessageCount: { increment: 1 } },
        });

        // Downstream workflows (context distillation, analytics) run in the
        // background off this event — never inline in the request.
        await publish(
          "TUTOR_INTERACTION_COMPLETED",
          { conversationId, projectId: project.id, messageId: assistantMessage.id, grounding },
          { userId: user.id, projectId: project.id },
        );

        send("done", {
          messageId: assistantMessage.id,
          grounding,
          citations,
          latencyMs: Date.now() - started,
          model: final.model,
        });
      } catch (error) {
        logger.error("tutor_stream_failed", { traceId, conversationId, error });
        // Record the failure on the transcript so the learner sees what
        // happened rather than a silently missing reply.
        await db.message
          .create({
            data: {
              conversationId,
              role: "assistant",
              content:
                "I could not complete that answer because the AI service failed. Your question was saved — please try again.",
              status: "FAILED",
              grounding: "NA",
              traceId,
              error: truncate(errorMessage(error), 400),
              latencyMs: Date.now() - started,
            },
          })
          .catch(() => {});

        send("error", {
          message:
            error instanceof AppError
              ? error.userMessage
              : "The AI service is unavailable right now. Your learning data is unchanged — please try again.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering so tokens are not held back.
      "x-accel-buffering": "no",
      "x-trace-id": traceId,
    },
  });
});
