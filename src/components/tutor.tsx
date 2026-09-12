"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Badge, Button, Card, EmptyState, formatDuration, formatRelative } from "./ui";
import { GroundingBadge } from "./learning";
import { renderMarkdown } from "@/lib/markdown";

export interface Citation {
  materialId: string;
  materialName: string;
  page: number;
  chunkId: string;
  quote: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  grounding: string;
  citations: Citation[];
  createdAt: string;
  latencyMs: number;
  model: string | null;
  status: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
}

const SUGGESTIONS = [
  "Summarise the key ideas in my materials",
  "Explain the hardest concept in simpler terms",
  "Give me a practical example",
  "Test my understanding with a question",
  "Build me a revision plan for this project",
];

export function TutorPanel({
  projectId,
  conversations: initialConversations,
  activeId,
  initialMessages,
  hasMaterials,
}: {
  projectId: string;
  conversations: ConversationSummary[];
  activeId: string | null;
  initialMessages: ChatMessage[];
  hasMaterials: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [conversations, setConversations] = useState(initialConversations);
  const [conversationId, setConversationId] = useState(activeId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState(searchParams.get("q") ?? "");
  const [streaming, setStreaming] = useState(false);
  const [streamed, setStreamed] = useState("");
  const [pendingCitations, setPendingCitations] = useState<Citation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamed]);

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const response = await fetch(`/api/projects/${projectId}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message ?? "Could not start a conversation.");
    setConversationId(body.data.id);
    setConversations((prev) => [
      { id: body.data.id, title: body.data.title, messageCount: 0, lastMessageAt: new Date().toISOString() },
      ...prev,
    ]);
    return body.data.id;
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || streaming) return;

    setError(null);
    setInput("");
    setStreaming(true);
    setStreamed("");
    setPendingCitations([]);
    setStatus("Searching your materials…");

    // Optimistic user turn, so the question appears instantly.
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: question,
      grounding: "NA",
      citations: [],
      createdAt: new Date().toISOString(),
      latencyMs: 0,
      model: null,
      status: "COMPLETE",
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const id = await ensureConversation();
      const response = await fetch(`/api/conversations/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: question }),
      });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? "The tutor could not answer that.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      // Parse the SSE frames as they arrive.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;

          const event = eventLine.slice(7).trim();
          const data = JSON.parse(dataLine.slice(6));

          if (event === "meta") {
            setPendingCitations(data.citations ?? []);
            setStatus(
              data.retrievedCount === 0
                ? "No matching passages found…"
                : `Found ${data.retrievedCount} relevant passage${data.retrievedCount === 1 ? "" : "s"}…`,
            );
          } else if (event === "delta") {
            accumulated += data.text;
            setStreamed(accumulated);
            setStatus("");
          } else if (event === "done") {
            setMessages((prev) => [
              ...prev,
              {
                id: data.messageId,
                role: "assistant",
                content: accumulated,
                grounding: data.grounding,
                citations: data.citations ?? [],
                createdAt: new Date().toISOString(),
                latencyMs: data.latencyMs,
                model: data.model ?? null,
                status: "COMPLETE",
              },
            ]);
            setStreamed("");
            setPendingCitations([]);
          } else if (event === "error") {
            throw new Error(data.message);
          }
        }
      }
      // Refresh server components so mastery, context and recommendations
      // reflect this exchange.
      router.refresh();
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "Something went wrong.");
      setStreamed("");
    } finally {
      setStreaming(false);
      setStatus("");
    }
  }

  async function newConversation() {
    setConversationId(null);
    setMessages([]);
    setStreamed("");
    setError(null);
    textareaRef.current?.focus();
  }

  async function openConversation(id: string) {
    setConversationId(id);
    setStreamed("");
    setError(null);
    const response = await fetch(`/api/conversations/${id}`);
    const body = await response.json();
    if (response.ok) setMessages(body.data);
  }

  if (!hasMaterials) {
    return (
      <Card padding={26}>
        <EmptyState
          icon="📄"
          title="The tutor needs something to teach from"
          body="Answers are grounded in your own materials, with page citations. Upload a PDF and wait for processing to finish, then come back."
          action={<Button href={`/projects/${projectId}/materials`}>Add a material</Button>}
        />
      </Card>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 230px", gap: 16, alignItems: "start" }}>
      <Card padding={0} style={{ display: "flex", flexDirection: "column", minHeight: 540 }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 18, maxHeight: "62vh" }}>
          {messages.length === 0 && !streaming ? (
            <div style={{ padding: "20px 0" }}>
              <EmptyState
                icon="💬"
                title="Ask anything about your materials"
                body="Every answer is drawn from the documents in this project and cites the page it came from. If your materials do not cover something, the tutor will say so rather than guess."
              />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, justifyContent: "center", marginTop: 4 }}>
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => void send(suggestion)}
                    style={{
                      border: "1px solid var(--border-strong)",
                      background: "var(--surface)",
                      borderRadius: 999,
                      padding: "5px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      color: "var(--text-muted)",
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 16 }}>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {streaming ? (
              <div>
                {status ? (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 7 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: "var(--accent)",
                        marginRight: 6,
                        animation: "pulse 1.2s ease-in-out infinite",
                      }}
                    />
                    {status}
                  </div>
                ) : null}
                {streamed ? (
                  <div
                    className="prose"
                    style={{ fontSize: 13.5, lineHeight: 1.68 }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(streamed) }}
                  />
                ) : null}
                {pendingCitations.length > 0 && !streamed ? (
                  <div style={{ fontSize: 11.5, color: "var(--text-subtle)" }}>
                    Reading {pendingCitations.length} passage
                    {pendingCitations.length === 1 ? "" : "s"}…
                  </div>
                ) : null}
              </div>
            ) : null}

            {error ? <Alert tone="danger">{error}</Alert> : null}
          </div>
          <div ref={endRef} />
        </div>

        <div style={{ borderTop: "1px solid var(--border)", padding: 13 }}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
            style={{ display: "flex", gap: 8, alignItems: "flex-end" }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Ask about your materials… (Enter to send, Shift+Enter for a new line)"
              rows={2}
              disabled={streaming}
              style={{
                flex: 1,
                background: "var(--surface-2)",
                border: "1px solid var(--border-strong)",
                borderRadius: 9,
                padding: "9px 12px",
                fontSize: 13.5,
                resize: "vertical",
                minHeight: 44,
                maxHeight: 180,
                outline: "none",
              }}
            />
            <Button type="submit" disabled={streaming || !input.trim()}>
              {streaming ? "…" : "Send"}
            </Button>
          </form>
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 11 }}>
          <span style={{ fontSize: 13, fontWeight: 620 }}>Conversations</span>
          <Button size="sm" variant="secondary" onClick={newConversation}>
            New
          </Button>
        </div>
        {conversations.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
            No conversations yet.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 5 }}>
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                onClick={() => void openConversation(conversation.id)}
                style={{
                  textAlign: "left",
                  border: 0,
                  borderRadius: 7,
                  padding: "8px 10px",
                  cursor: "pointer",
                  background:
                    conversation.id === conversationId ? "var(--accent-soft)" : "transparent",
                  color: conversation.id === conversationId ? "var(--accent)" : "var(--text)",
                }}
              >
                <div
                  style={{
                    fontSize: 12.3,
                    fontWeight: 545,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {conversation.title}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-subtle)" }}>
                  {formatRelative(conversation.lastMessageAt)}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: "82%",
            background: "var(--accent)",
            color: "var(--accent-text)",
            borderRadius: "12px 12px 3px 12px",
            padding: "9px 13px",
            fontSize: 13.4,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  const failed = message.status === "FAILED";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 620, color: "var(--text-muted)" }}>AI Tutor</span>
        {failed ? <Badge tone="danger">Failed</Badge> : <GroundingBadge grounding={message.grounding} />}
        {message.latencyMs > 0 ? (
          <span style={{ fontSize: 10.5, color: "var(--text-subtle)" }}>
            {formatDuration(message.latencyMs)}
          </span>
        ) : null}
      </div>

      <div
        className="prose"
        style={{ fontSize: 13.5, lineHeight: 1.68, color: failed ? "var(--danger)" : "var(--text)" }}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
      />

      {message.citations.length > 0 ? (
        <details style={{ marginTop: 10 }}>
          <summary
            style={{
              fontSize: 11.5,
              color: "var(--text-muted)",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            {message.citations.length} source{message.citations.length === 1 ? "" : "s"} from your materials
          </summary>
          <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
            {message.citations.map((citation) => (
              <div
                key={citation.chunkId}
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  padding: "8px 11px",
                }}
              >
                <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 3 }}>
                  {citation.materialName} — Page {citation.page}
                </div>
                <div style={{ fontSize: 11.8, color: "var(--text-muted)", lineHeight: 1.55 }}>
                  “{citation.quote}”
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
