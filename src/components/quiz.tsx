"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Badge, Button, Card, EmptyState, formatPercent } from "./ui";
import { DifficultyBadge } from "./learning";
import { ChartTheme, Donut, MasteryMeter } from "./charts";

interface Question {
  id: string;
  index: number;
  type: "MCQ" | "OPEN";
  prompt: string;
  options: string[];
  difficulty: string;
  concept: { id: string; name: string } | null;
  selectionReason: string;
  sources: { label: string }[];
}

interface AnswerResult {
  isCorrect: boolean;
  score: number;
  feedback: string;
  coveredPoints: string[];
  missingPoints: string[];
  correctIndex: number | null;
  explanation: string;
  evaluatedBy?: string;
}

interface MasteryDelta {
  conceptId: string;
  conceptName: string;
  previousLevel: number;
  level: number;
  delta: number;
}

type Phase = "idle" | "loading" | "question" | "graded" | "finished";

export function QuizPanel({
  projectId,
  conceptCount,
  history,
}: {
  projectId: string;
  conceptCount: number;
  history: { id: string; score: number; answeredCount: number; correctCount: number; completedAt: string | null }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusParam = (searchParams.get("focus") ?? "").split(",").filter(Boolean);

  const [phase, setPhase] = useState<Phase>("idle");
  const [quizId, setQuizId] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [written, setWritten] = useState("");
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [mastery, setMastery] = useState<MasteryDelta | null>(null);
  const [progress, setProgress] = useState({ answered: 0, planned: 5 });
  const [summary, setSummary] = useState<{ score: number; answered: number; correct: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState(5);

  const loadNext = useCallback(
    async (id: string) => {
      setPhase("loading");
      setError(null);
      setResult(null);
      setMastery(null);
      setSelected(null);
      setWritten("");

      const response = await fetch(`/api/quizzes/${id}/next`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Could not generate the next question.");
        setPhase("idle");
        return;
      }
      if (body.data.finished) {
        await complete(id);
        return;
      }
      setQuestion(body.data.question);
      setProgress(body.data.progress);
      setPhase("question");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function start() {
    setError(null);
    setPhase("loading");
    const response = await fetch(`/api/projects/${projectId}/quizzes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionCount, focusConceptIds: focusParam }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body?.error?.message ?? "Could not start the quiz.");
      setPhase("idle");
      return;
    }
    setQuizId(body.data.id);
    setProgress({ answered: body.data.answeredCount ?? 0, planned: body.data.plannedCount });
    await loadNext(body.data.id);
  }

  async function submit() {
    if (!quizId || !question) return;
    setPhase("loading");
    setError(null);

    const response = await fetch(`/api/quizzes/${quizId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        questionId: question.id,
        selectedIndex: question.type === "MCQ" ? selected : null,
        answer: question.type === "OPEN" ? written : "",
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body?.error?.message ?? "Could not submit that answer.");
      setPhase("question");
      return;
    }

    setResult(body.data.result);
    setMastery(body.data.mastery);
    setProgress(body.data.progress);
    setPhase("graded");
  }

  async function complete(id: string) {
    const response = await fetch(`/api/quizzes/${id}/complete`, { method: "POST" });
    const body = await response.json();
    if (response.ok) {
      setSummary({
        score: body.data.score,
        answered: body.data.answered,
        correct: body.data.correct,
      });
    }
    setPhase("finished");
    setQuestion(null);
    // Mastery, growth and recommendations all change after a quiz.
    router.refresh();
  }

  async function next() {
    if (!quizId) return;
    if (progress.answered >= progress.planned) {
      await complete(quizId);
      return;
    }
    await loadNext(quizId);
  }

  // ---------------------------------------------------------------- idle ---
  if (phase === "idle" && !quizId) {
    if (conceptCount === 0) {
      return (
        <Card padding={26}>
          <EmptyState
            icon="🎯"
            title="Nothing to quiz on yet"
            body="Questions are generated from your own materials. Upload a PDF and wait for processing to finish."
            action={<Button href={`/projects/${projectId}/materials`}>Add a material</Button>}
          />
        </Card>
      );
    }

    return (
      <ChartTheme>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 280px", gap: 16, alignItems: "start" }}>
          <Card padding={24}>
            <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 640 }}>Adaptive quiz</h2>
            <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.65, maxWidth: 560 }}>
              Questions are written from your own materials and chosen for you: the concept with the
              most to learn from right now, at a difficulty matched to your current mastery. Both
              multiple-choice and written answers are used — written answers are marked against a
              rubric with specific feedback.
            </p>

            {focusParam.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <Alert tone="accent">
                  This quiz will focus on the concepts from your recommendation.
                </Alert>
              </div>
            ) : null}

            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12.5, fontWeight: 570, marginBottom: 7 }}>Number of questions</div>
              <div style={{ display: "flex", gap: 7 }}>
                {[3, 5, 8, 10].map((count) => (
                  <button
                    key={count}
                    onClick={() => setQuestionCount(count)}
                    aria-pressed={questionCount === count}
                    style={{
                      padding: "6px 15px",
                      borderRadius: 8,
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 560,
                      border: `1px solid ${questionCount === count ? "var(--accent)" : "var(--border-strong)"}`,
                      background: questionCount === count ? "var(--accent-soft)" : "var(--surface)",
                      color: questionCount === count ? "var(--accent)" : "var(--text)",
                    }}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>

            {error ? <div style={{ marginBottom: 14 }}><Alert tone="danger">{error}</Alert></div> : null}
            <Button onClick={start}>Start quiz</Button>
          </Card>

          <Card>
            <div style={{ fontSize: 13, fontWeight: 620, marginBottom: 11 }}>Past attempts</div>
            {history.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>No attempts yet.</p>
            ) : (
              <div style={{ display: "grid", gap: 9 }}>
                {history.map((attempt) => (
                  <div
                    key={attempt.id}
                    style={{ display: "flex", justifyContent: "space-between", fontSize: 12.3 }}
                  >
                    <span style={{ color: "var(--text-muted)" }}>
                      {attempt.correctCount}/{attempt.answeredCount} correct
                    </span>
                    <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                      {formatPercent(attempt.score)}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </ChartTheme>
    );
  }

  // ------------------------------------------------------------ finished ---
  if (phase === "finished") {
    return (
      <ChartTheme>
        <Card padding={26}>
          <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
            <Donut value={summary?.score ?? 0} size={104} label="score" />
            <div style={{ flex: 1, minWidth: 240 }}>
              <h2 style={{ margin: "0 0 5px", fontSize: 17, fontWeight: 645 }}>Quiz complete</h2>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                You answered {summary?.correct ?? 0} of {summary?.answered ?? 0} correctly. Your
                concept mastery has been updated, and a new recommendation is being prepared in the
                background.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button href={`/projects/${projectId}/growth`}>See what changed →</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuizId(null);
                    setSummary(null);
                    setPhase("idle");
                  }}
                >
                  Another quiz
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </ChartTheme>
    );
  }

  // ------------------------------------------------------------- running ---
  const percentComplete = progress.planned > 0 ? progress.answered / progress.planned : 0;

  return (
    <ChartTheme>
      <Card padding={22}>
        {/* Progress through the quiz */}
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11.5,
              color: "var(--text-muted)",
              marginBottom: 5,
            }}
          >
            <span>
              Question {Math.min(progress.answered + 1, progress.planned)} of {progress.planned}
            </span>
            <span>{Math.round(percentComplete * 100)}% complete</span>
          </div>
          <div style={{ height: 4, background: "var(--surface-2)", borderRadius: 2, overflow: "hidden" }}>
            <div
              style={{
                width: `${percentComplete * 100}%`,
                height: "100%",
                background: "var(--accent)",
                transition: "width 300ms ease",
              }}
            />
          </div>
        </div>

        {phase === "loading" && !question ? (
          <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            Choosing the most useful question for you…
          </div>
        ) : null}

        {question ? (
          <>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 11 }}>
              {question.concept ? <Badge tone="accent">{question.concept.name}</Badge> : null}
              <DifficultyBadge difficulty={question.difficulty} />
              <Badge tone="default">
                {question.type === "MCQ" ? "multiple choice" : "written answer"}
              </Badge>
            </div>

            {question.selectionReason ? (
              <div style={{ fontSize: 11.3, color: "var(--text-subtle)", marginBottom: 13 }}>
                Chosen because: {question.selectionReason}
              </div>
            ) : null}

            <p style={{ margin: "0 0 18px", fontSize: 15, lineHeight: 1.6, fontWeight: 520 }}>
              {question.prompt}
            </p>

            {question.type === "MCQ" ? (
              <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
                {question.options.map((option, index) => {
                  const isSelected = selected === index;
                  const isCorrectOption = result && result.correctIndex === index;
                  const isWrongPick = result && isSelected && !result.isCorrect;

                  let border = "var(--border-strong)";
                  let background = "var(--surface)";
                  if (result) {
                    if (isCorrectOption) {
                      border = "var(--success)";
                      background = "var(--success-soft)";
                    } else if (isWrongPick) {
                      border = "var(--danger)";
                      background = "var(--danger-soft)";
                    }
                  } else if (isSelected) {
                    border = "var(--accent)";
                    background = "var(--accent-soft)";
                  }

                  return (
                    <button
                      key={index}
                      onClick={() => !result && setSelected(index)}
                      disabled={Boolean(result)}
                      style={{
                        textAlign: "left",
                        border: `1px solid ${border}`,
                        background,
                        borderRadius: 9,
                        padding: "11px 14px",
                        fontSize: 13.3,
                        lineHeight: 1.55,
                        cursor: result ? "default" : "pointer",
                        display: "flex",
                        gap: 10,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          fontWeight: 640,
                          color: "var(--text-muted)",
                          minWidth: 14,
                        }}
                      >
                        {String.fromCharCode(65 + index)}
                      </span>
                      <span style={{ flex: 1 }}>{option}</span>
                      {isCorrectOption ? <span aria-label="correct">✓</span> : null}
                      {isWrongPick ? <span aria-label="your answer, incorrect">✕</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <textarea
                value={written}
                onChange={(e) => setWritten(e.target.value)}
                disabled={Boolean(result)}
                placeholder="Explain in your own words…"
                rows={6}
                style={{
                  width: "100%",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 9,
                  padding: "11px 13px",
                  fontSize: 13.4,
                  lineHeight: 1.6,
                  resize: "vertical",
                  marginBottom: 18,
                  outline: "none",
                }}
              />
            )}

            {error ? <div style={{ marginBottom: 14 }}><Alert tone="danger">{error}</Alert></div> : null}

            {/* Feedback */}
            {result ? (
              <div style={{ marginBottom: 18 }}>
                <div
                  style={{
                    background: result.isCorrect ? "var(--success-soft)" : "var(--warning-soft)",
                    color: result.isCorrect ? "var(--success)" : "var(--warning)",
                    borderRadius: 9,
                    padding: "12px 15px",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
                    <strong style={{ fontSize: 13.5 }}>
                      {result.isCorrect ? "Correct" : result.score >= 0.4 ? "Partly right" : "Not quite"}
                    </strong>
                    {question.type === "OPEN" ? (
                      <Badge tone={result.isCorrect ? "success" : "warning"}>
                        {Math.round(result.score * 100)}%
                      </Badge>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12.8, lineHeight: 1.6 }}>{result.feedback}</div>
                </div>

                {result.coveredPoints.length > 0 || result.missingPoints.length > 0 ? (
                  <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
                    {result.coveredPoints.length > 0 ? (
                      <div style={{ fontSize: 12.3 }}>
                        <strong style={{ color: "var(--success)" }}>Covered:</strong>{" "}
                        <span style={{ color: "var(--text-muted)" }}>
                          {result.coveredPoints.join("; ")}
                        </span>
                      </div>
                    ) : null}
                    {result.missingPoints.length > 0 ? (
                      <div style={{ fontSize: 12.3 }}>
                        <strong style={{ color: "var(--warning)" }}>Focus on:</strong>{" "}
                        <span style={{ color: "var(--text-muted)" }}>
                          {result.missingPoints.join("; ")}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {mastery ? (
                  <div
                    style={{
                      background: "var(--surface-2)",
                      borderRadius: 9,
                      padding: "11px 14px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        marginBottom: 6,
                      }}
                    >
                      <span style={{ fontWeight: 570 }}>{mastery.conceptName} mastery</span>
                      <span
                        style={{
                          fontWeight: 620,
                          color: mastery.delta >= 0 ? "var(--success)" : "var(--danger)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {mastery.delta >= 0 ? "+" : ""}
                        {Math.round(mastery.delta * 100)} pts
                      </span>
                    </div>
                    <MasteryMeter level={mastery.level} previous={mastery.previousLevel} />
                    <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 5 }}>
                      {Math.round(mastery.previousLevel * 100)}% → {Math.round(mastery.level * 100)}%
                    </div>
                  </div>
                ) : null}

                {question.sources.length > 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 10 }}>
                    From: {question.sources.map((s) => s.label).join(" · ")}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8 }}>
              {result ? (
                <Button onClick={next} disabled={phase === "loading"}>
                  {progress.answered >= progress.planned ? "Finish quiz" : "Next question →"}
                </Button>
              ) : (
                <Button
                  onClick={submit}
                  disabled={
                    phase === "loading" ||
                    (question.type === "MCQ" ? selected === null : written.trim().length === 0)
                  }
                >
                  {phase === "loading" ? "Checking…" : "Submit answer"}
                </Button>
              )}
              {!result ? (
                <Button variant="ghost" onClick={() => quizId && complete(quizId)}>
                  End quiz
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </Card>
    </ChartTheme>
  );
}
