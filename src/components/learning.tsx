import Link from "next/link";
import { Badge, Card, formatRelative } from "./ui";
import { MasteryMeter } from "./charts";

export function TrendBadge({ trend }: { trend: string }) {
  // Status colour never carries the meaning alone — every badge is labelled.
  switch (trend) {
    case "IMPROVING":
      return <Badge tone="success">↑ Improving</Badge>;
    case "NEEDS_ATTENTION":
      return <Badge tone="danger">↓ Needs attention</Badge>;
    case "STABLE":
      return <Badge tone="info">→ Stable</Badge>;
    default:
      return <Badge tone="default">New</Badge>;
  }
}

export function GroundingBadge({ grounding }: { grounding: string }) {
  switch (grounding) {
    case "GROUNDED":
      return <Badge tone="success" title="Every claim is supported by a cited passage from your materials.">Grounded</Badge>;
    case "PARTIAL":
      return <Badge tone="warning" title="Evidence was found, but the answer did not cite it explicitly.">Partly grounded</Badge>;
    case "UNSUPPORTED":
      return <Badge tone="default" title="Your materials do not cover this, so the tutor declined to answer.">Not in your materials</Badge>;
    default:
      return null;
  }
}

export function MaterialStatusBadge({ status, stage }: { status: string; stage: string }) {
  if (status === "READY") return <Badge tone="success">Ready</Badge>;
  if (status === "FAILED") return <Badge tone="danger">Failed</Badge>;
  return <Badge tone="info">{stage.replace(/_/g, " ").toLowerCase()}</Badge>;
}

export function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const tone = difficulty === "HARD" ? "danger" : difficulty === "EASY" ? "success" : "warning";
  return <Badge tone={tone}>{difficulty.toLowerCase()}</Badge>;
}

export interface ConceptRow {
  conceptId: string;
  name: string;
  level: number;
  previousLevel: number;
  trend: string;
  evidenceCount: number;
  attemptCount?: number;
}

export function ConceptMasteryList({
  concepts,
  limit,
  showTrend = true,
}: {
  concepts: ConceptRow[];
  limit?: number;
  showTrend?: boolean;
}) {
  const rows = limit ? concepts.slice(0, limit) : concepts;
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
        No concepts yet. They appear once a material has finished processing.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: 13 }}>
      {rows.map((concept) => (
        <div key={concept.conceptId}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 12.8, fontWeight: 545 }}>{concept.name}</span>
            {showTrend ? <TrendBadge trend={concept.trend} /> : null}
          </div>
          <MasteryMeter level={concept.level} previous={concept.previousLevel} />
          <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 3 }}>
            {concept.evidenceCount === 0
              ? "no assessment evidence yet"
              : `${concept.evidenceCount} data point${concept.evidenceCount === 1 ? "" : "s"}`}
          </div>
        </div>
      ))}
    </div>
  );
}

export function RecommendationCard({
  recommendation,
  projectId,
  compact,
}: {
  recommendation: {
    id: string;
    title: string;
    body: string;
    actionType: string;
    actionPayload: Record<string, unknown>;
    rationale: string;
  };
  projectId: string;
  compact?: boolean;
}) {
  const conceptIds = (recommendation.actionPayload.conceptIds as string[] | undefined) ?? [];
  const prompt = recommendation.actionPayload.prompt as string | undefined;

  const cta = (() => {
    switch (recommendation.actionType) {
      case "TAKE_QUIZ":
        return {
          href: `/projects/${projectId}/quiz?focus=${conceptIds.join(",")}`,
          label: "Start a focused quiz",
        };
      case "ASK_TUTOR":
        return {
          href: `/projects/${projectId}/tutor${prompt ? `?q=${encodeURIComponent(prompt)}` : ""}`,
          label: "Ask the tutor",
        };
      case "REVIEW_MATERIAL":
        return { href: `/projects/${projectId}/materials`, label: "Review the material" };
      default:
        return { href: `/projects/${projectId}/materials`, label: "Add a material" };
    }
  })();

  return (
    <Card padding={compact ? 14 : 16} style={{ borderColor: "var(--accent)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <Badge tone="accent">Recommended next step</Badge>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 620, marginBottom: 4 }}>{recommendation.title}</div>
      <p style={{ margin: "0 0 11px", fontSize: 12.8, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {recommendation.body}
      </p>
      <Link
        href={cta.href}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          background: "var(--accent)",
          color: "var(--accent-text)",
          borderRadius: 8,
          padding: "6px 13px",
          fontSize: 12.5,
          fontWeight: 570,
        }}
      >
        {cta.label} →
      </Link>
      {recommendation.rationale ? (
        <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 9 }}>
          Based on: {recommendation.rationale}
        </div>
      ) : null}
    </Card>
  );
}

export function ActivityList({
  events,
  showProject,
}: {
  events: {
    id: string;
    type: string;
    summary: string;
    createdAt: Date;
    project?: { id: string; name: string } | null;
  }[];
  showProject?: boolean;
}) {
  if (events.length === 0) {
    return (
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>No activity recorded yet.</p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 9 }}>
      {events.map((event) => (
        <li key={event.id} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "var(--border-strong)",
              flexShrink: 0,
              marginTop: 6,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>{event.summary}</div>
            <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
              {formatRelative(event.createdAt)}
              {showProject && event.project ? (
                <>
                  {" · "}
                  <Link href={`/projects/${event.project.id}`} style={{ color: "var(--text-muted)" }}>
                    {event.project.name}
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
