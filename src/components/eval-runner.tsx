"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button } from "./ui";

const SUITES = ["all", "tutor", "retrieval", "assessment", "recommendation"] as const;

export function EvalRunner() {
  const router = useRouter();
  const [suite, setSuite] = useState<string>("all");
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/evaluation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suite, label: "run from admin dashboard" }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "The evaluation run failed.");
        return;
      }
      const { passed, total, avgScore, diff, durationMs } = body.data;
      const regressions = diff.regressed.length;
      setMessage(
        `${passed}/${total} passed · avg ${avgScore.toFixed(3)} · ${durationMs}ms` +
          (regressions > 0
            ? ` — ${regressions} regression${regressions === 1 ? "" : "s"} vs the previous run`
            : diff.improved.length > 0
              ? ` — ${diff.improved.length} improved`
              : " — no change vs the previous run"),
      );
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={suite}
          onChange={(e) => setSuite(e.target.value)}
          disabled={running}
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12.5,
            outline: "none",
          }}
        >
          {SUITES.map((option) => (
            <option key={option} value={option}>
              {option === "all" ? "All suites" : option}
            </option>
          ))}
        </select>
        <Button onClick={run} disabled={running} size="sm">
          {running ? "Running…" : "Run evaluation"}
        </Button>
        <span style={{ fontSize: 11.5, color: "var(--text-subtle)" }}>
          Also runnable in CI: <code style={{ fontFamily: "var(--font-mono)" }}>npm run eval</code>
        </span>
      </div>

      {message ? (
        <div style={{ marginTop: 11 }}>
          <Alert tone="info">{message}</Alert>
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 11 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}
