import { requireAdminPage } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";
import { allCases } from "@/lib/eval/dataset";
import {
  Badge,
  Card,
  SectionTitle,
  Stat,
  StatGrid,
  formatDuration,
  formatPercent,
  formatRelative,
} from "@/components/ui";
import { Table, Td, Tr } from "@/components/table";
import { EvalRunner } from "@/components/eval-runner";
import { ChartTheme, LineChart } from "@/components/charts";

/** AI evaluation & regression view (PRD §46, §47, §63). */
export default async function AdminEvaluationPage() {
  await requireAdminPage();

  const runs = await db.evalRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 15,
  });
  const latest = runs[0];

  const results = latest
    ? await db.evalCaseResult.findMany({
        where: { runId: latest.id },
        orderBy: [{ passed: "asc" }, { caseId: "asc" }],
      })
    : [];

  const diff = latest
    ? parseJson<{ improved: string[]; regressed: string[] }>(latest.diff, {
        improved: [],
        regressed: [],
      })
    : { improved: [], regressed: [] };
  const metrics = latest ? parseJson<Record<string, number>>(latest.metrics, {}) : {};

  const cases = allCases();

  return (
    <ChartTheme>
      <div style={{ display: "grid", gap: 18 }}>
        <Card>
          <SectionTitle hint="Curated cases run against the live retrieval, prompts and domain services">
            AI evaluation
          </SectionTitle>
          <p style={{ margin: "0 0 14px", fontSize: 12.8, color: "var(--text-muted)", lineHeight: 1.65, maxWidth: 720 }}>
            The suite covers tutor groundedness and citation accuracy, correct refusal of
            unsupported questions, project data isolation, prompt-injection resistance, retrieval
            relevance, structured-output validity, grading accuracy, and recommendation
            actionability. Each run is compared against the previous run of the same suite so a
            prompt, model or retrieval change that degrades behaviour is named rather than averaged
            away.
          </p>
          <EvalRunner />
        </Card>

        {latest ? (
          <>
            <Card>
              <SectionTitle
                hint={`${latest.suite} · ${latest.provider}/${latest.model} · ${formatRelative(latest.startedAt)}`}
                action={
                  diff.regressed.length > 0 ? (
                    <Badge tone="danger">{diff.regressed.length} regressed</Badge>
                  ) : diff.improved.length > 0 ? (
                    <Badge tone="success">{diff.improved.length} improved</Badge>
                  ) : (
                    <Badge tone="default">no change</Badge>
                  )
                }
              >
                Latest run
              </SectionTitle>
              <StatGrid min={135}>
                <Stat
                  label="Passed"
                  value={`${latest.passedCases}/${latest.totalCases}`}
                  tone={latest.passedCases === latest.totalCases ? "success" : "warning"}
                />
                <Stat label="Average score" value={latest.avgScore.toFixed(3)} />
                <Stat label="Duration" value={formatDuration(latest.durationMs)} />
                <Stat label="Model" value={latest.model} />
              </StatGrid>

              {diff.regressed.length > 0 ? (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 570, marginBottom: 6, color: "var(--danger)" }}>
                    Regressed since the previous run
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {diff.regressed.map((id) => (
                      <Badge key={id} tone="danger">{id}</Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {diff.improved.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 570, marginBottom: 6, color: "var(--success)" }}>
                    Improved since the previous run
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {diff.improved.map((id) => (
                      <Badge key={id} tone="success">{id}</Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>

            {Object.keys(metrics).length > 0 ? (
              <Card>
                <SectionTitle hint="Averaged across every case that reports them">Metrics</SectionTitle>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: 12,
                  }}
                >
                  {Object.entries(metrics)
                    .filter(([name]) => name !== "returned")
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, value]) => (
                      <div key={name}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.8, marginBottom: 4 }}>
                          <span style={{ color: "var(--text-muted)" }}>
                            {name.replace(/([A-Z])/g, " $1").toLowerCase()}
                          </span>
                          <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                            {formatPercent(value)}
                          </strong>
                        </div>
                        <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${Math.max(2, value * 100)}%`,
                              height: "100%",
                              background:
                                value >= 0.9
                                  ? "var(--success)"
                                  : value >= 0.7
                                    ? "var(--warning)"
                                    : "var(--danger)",
                            }}
                          />
                        </div>
                      </div>
                    ))}
                </div>
              </Card>
            ) : null}

            <Card>
              <SectionTitle hint="Failing cases first">Case results</SectionTitle>
              <Table
                columns={[
                  { key: "case", label: "Case" },
                  { key: "category", label: "Category" },
                  { key: "score", label: "Score", align: "right" },
                  { key: "notes", label: "What happened" },
                ]}
                empty="No results recorded."
              >
                {results.map((result) => {
                  const definition = cases.find((c) => c.id === result.caseId);
                  return (
                    <Tr key={result.id}>
                      <Td>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <Badge tone={result.passed ? "success" : "danger"}>
                            {result.passed ? "pass" : "fail"}
                          </Badge>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.8 }}>
                            {result.caseId}
                          </span>
                        </div>
                        {definition ? (
                          <div style={{ fontSize: 10.8, color: "var(--text-subtle)", marginTop: 3 }}>
                            {definition.note}
                          </div>
                        ) : null}
                      </Td>
                      <Td muted nowrap>{result.category}</Td>
                      <Td align="right">{result.score.toFixed(2)}</Td>
                      <Td muted>
                        <span style={{ display: "block", maxWidth: 520 }}>{result.notes}</span>
                        {result.error ? (
                          <span style={{ color: "var(--danger)", display: "block", marginTop: 3 }}>
                            {result.error}
                          </span>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </Table>
            </Card>
          </>
        ) : (
          <Card>
            <p style={{ fontSize: 12.8, color: "var(--text-muted)", margin: 0 }}>
              No evaluation runs yet. Run one above, or from the command line with{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>npm run eval</code>.
            </p>
          </Card>
        )}

        {runs.length > 1 ? (
          <Card>
            <SectionTitle hint="Average score per run, oldest first — this is the regression signal over time">
              Score history
            </SectionTitle>
            <LineChart
              data={[...runs]
                .reverse()
                .map((run) => ({ label: run.startedAt.toISOString().slice(0, 10), value: run.avgScore }))}
              format="percent"
              yMax={1}
              emptyMessage="Not enough runs yet"
            />
            <div style={{ marginTop: 14 }}>
              <Table
                columns={[
                  { key: "when", label: "When" },
                  { key: "suite", label: "Suite" },
                  { key: "model", label: "Model" },
                  { key: "passed", label: "Passed", align: "right" },
                  { key: "score", label: "Avg score", align: "right" },
                  { key: "label", label: "Label" },
                ]}
              >
                {runs.map((run) => (
                  <Tr key={run.id}>
                    <Td muted nowrap>{formatRelative(run.startedAt)}</Td>
                    <Td>{run.suite}</Td>
                    <Td mono muted nowrap>{run.model}</Td>
                    <Td align="right">
                      {run.passedCases}/{run.totalCases}
                    </Td>
                    <Td align="right">{run.avgScore.toFixed(3)}</Td>
                    <Td muted>{run.label || "—"}</Td>
                  </Tr>
                ))}
              </Table>
            </div>
          </Card>
        ) : null}
      </div>
    </ChartTheme>
  );
}
