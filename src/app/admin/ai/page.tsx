import { requireAdmin } from "@/lib/auth/session";
import { getAdminAiUsage } from "@/lib/domain/admin";
import { listPrompts } from "@/lib/ai/prompts";
import { listTools } from "@/lib/ai/tools";
import { ai } from "@/lib/ai/router";
import {
  Badge,
  Card,
  SectionTitle,
  Stat,
  StatGrid,
  formatCost,
  formatDuration,
  formatNumber,
  formatRelative,
} from "@/components/ui";
import { BarChart, ChartTheme, LineChart } from "@/components/charts";
import { Table, Td, Tr } from "@/components/table";

/** Admin AI usage and observability (PRD §43, §44, §63). */
export default async function AdminAiPage() {
  await requireAdmin();
  const [usage, prompts, tools] = await Promise.all([
    getAdminAiUsage(30),
    Promise.resolve(listPrompts()),
    Promise.resolve(listTools()),
  ]);

  const provider = ai.describe();
  const totalRequests = usage.byStatus.reduce((s, r) => s + r.count, 0);
  const failures = usage.byStatus
    .filter((r) => r.status !== "SUCCESS" && r.status !== "FALLBACK")
    .reduce((s, r) => s + r.count, 0);
  const totalCost = usage.byFeature.reduce((s, r) => s + r.costUsd, 0);
  const totalTokens = usage.byFeature.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

  return (
    <ChartTheme>
      <div style={{ display: "grid", gap: 18 }}>
        <Card>
          <SectionTitle
            hint="Last 30 days"
            action={
              <Badge tone={provider.isLive ? "success" : "warning"}>
                {provider.isLive ? `${provider.model} (live)` : "offline deterministic provider"}
              </Badge>
            }
          >
            AI usage
          </SectionTitle>
          <StatGrid min={140}>
            <Stat label="Requests" value={formatNumber(totalRequests)} />
            <Stat
              label="Failures"
              value={failures}
              tone={failures > 0 ? "danger" : "success"}
              sub={totalRequests > 0 ? `${((failures / totalRequests) * 100).toFixed(1)}%` : undefined}
            />
            <Stat label="Tokens" value={formatNumber(totalTokens)} />
            <Stat label="Est. cost" value={formatCost(totalCost)} />
          </StatGrid>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="AI requests per day">Request volume</SectionTitle>
            <BarChart
              data={usage.dailyCost.map((d) => ({ label: d.day, value: d.requests }))}
              emptyMessage="No AI requests recorded"
            />
          </Card>
          <Card>
            <SectionTitle hint="Estimated spend per day">Cost trend</SectionTitle>
            <LineChart
              data={usage.dailyCost.map((d) => ({ label: d.day, value: d.costUsd }))}
              format="currency"
              emptyMessage="No spend recorded"
            />
          </Card>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle>By feature</SectionTitle>
            <Table
              columns={[
                { key: "feature", label: "Feature" },
                { key: "count", label: "Calls", align: "right" },
                { key: "latency", label: "Avg", align: "right" },
                { key: "cost", label: "Cost", align: "right" },
              ]}
              empty="No AI usage in this period."
            >
              {usage.byFeature.map((row) => (
                <Tr key={row.feature}>
                  <Td>{row.feature.replace(/_/g, " ").toLowerCase()}</Td>
                  <Td align="right">{row.count}</Td>
                  <Td align="right" muted>{formatDuration(row.avgLatencyMs)}</Td>
                  <Td align="right" muted>{formatCost(row.costUsd)}</Td>
                </Tr>
              ))}
            </Table>
          </Card>

          <Card>
            <SectionTitle>By model</SectionTitle>
            <Table
              columns={[
                { key: "model", label: "Model" },
                { key: "count", label: "Calls", align: "right" },
                { key: "latency", label: "Avg", align: "right" },
                { key: "cost", label: "Cost", align: "right" },
              ]}
              empty="No model usage in this period."
            >
              {usage.byModel.map((row) => (
                <Tr key={row.model}>
                  <Td mono>{row.model}</Td>
                  <Td align="right">{row.count}</Td>
                  <Td align="right" muted>{formatDuration(row.avgLatencyMs)}</Td>
                  <Td align="right" muted>{formatCost(row.costUsd)}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
        </div>

        <Card>
          <SectionTitle hint="Every model call, newest first — trace ids link a request across AI, retrieval and tool logs">
            Recent AI requests
          </SectionTitle>
          <Table
            columns={[
              { key: "when", label: "When" },
              { key: "feature", label: "Feature" },
              { key: "prompt", label: "Prompt" },
              { key: "model", label: "Model" },
              { key: "status", label: "Status" },
              { key: "latency", label: "Latency", align: "right" },
              { key: "tokens", label: "Tokens", align: "right" },
              { key: "cost", label: "Cost", align: "right" },
              { key: "trace", label: "Trace" },
            ]}
            empty="No AI requests recorded."
          >
            {usage.recent.map((row) => (
              <Tr key={row.id}>
                <Td muted nowrap>{formatRelative(row.createdAt)}</Td>
                <Td nowrap>{row.feature.replace(/_/g, " ").toLowerCase()}</Td>
                <Td muted mono nowrap>
                  {row.promptId ? `${row.promptId}@${row.promptVersion}` : "—"}
                </Td>
                <Td mono nowrap>{row.model}</Td>
                <Td>
                  <Badge
                    tone={
                      row.status === "SUCCESS"
                        ? "success"
                        : row.status === "FALLBACK"
                          ? "warning"
                          : "danger"
                    }
                    title={row.error ?? undefined}
                  >
                    {row.status.toLowerCase()}
                  </Badge>
                </Td>
                <Td align="right" muted>{formatDuration(row.latencyMs)}</Td>
                <Td align="right" muted>{row.inputTokens + row.outputTokens}</Td>
                <Td align="right" muted>{formatCost(row.costUsd)}</Td>
                <Td mono muted nowrap>{row.traceId.slice(0, 12)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Which retrieval calls returned useful context, and which returned nothing">
              Retrieval
            </SectionTitle>
            <Table
              columns={[
                { key: "when", label: "When" },
                { key: "query", label: "Query" },
                { key: "returned", label: "Returned", align: "right" },
                { key: "latency", label: "Latency", align: "right" },
                { key: "status", label: "Status" },
              ]}
              empty="No retrieval recorded."
            >
              {usage.retrieval.map((row) => (
                <Tr key={row.id}>
                  <Td muted nowrap>{formatRelative(row.createdAt)}</Td>
                  <Td>
                    <span
                      title={row.query}
                      style={{
                        display: "block",
                        maxWidth: 240,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.query}
                    </span>
                    <span style={{ fontSize: 10.5, color: "var(--text-subtle)" }}>{row.strategy}</span>
                  </Td>
                  <Td align="right">
                    {row.returnedCount}
                    <span style={{ color: "var(--text-subtle)" }}> / {row.candidateCount}</span>
                  </Td>
                  <Td align="right" muted>{formatDuration(row.latencyMs)}</Td>
                  <Td>
                    <Badge tone={row.status === "SUCCESS" ? "success" : row.status === "EMPTY" ? "warning" : "danger"}>
                      {row.status.toLowerCase()}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </Table>
          </Card>

          <Card>
            <SectionTitle hint="Every AI-initiated call into an application capability, including denials">
              Tool invocations
            </SectionTitle>
            <Table
              columns={[
                { key: "when", label: "When" },
                { key: "tool", label: "Capability" },
                { key: "status", label: "Status" },
                { key: "result", label: "Result" },
              ]}
              empty="No capability calls recorded."
            >
              {usage.tools.map((row) => (
                <Tr key={row.id}>
                  <Td muted nowrap>{formatRelative(row.createdAt)}</Td>
                  <Td mono nowrap>{row.toolName}</Td>
                  <Td>
                    <Badge
                      tone={row.status === "SUCCESS" ? "success" : row.status === "DENIED" ? "warning" : "danger"}
                      title={row.denyReason ?? undefined}
                    >
                      {row.status.toLowerCase()}
                    </Badge>
                  </Td>
                  <Td muted>{row.resultSummary || row.denyReason || "—"}</Td>
                </Tr>
              ))}
            </Table>
          </Card>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 18 }}>
          <Card>
            <SectionTitle hint="Versioned prompts. Every AI request is attributed to one of these.">
              Prompt registry
            </SectionTitle>
            <Table
              columns={[
                { key: "id", label: "Prompt" },
                { key: "version", label: "Version" },
                { key: "feature", label: "Feature" },
                { key: "kind", label: "Output" },
              ]}
            >
              {prompts.map((prompt) => (
                <Tr key={prompt.id}>
                  <Td mono>
                    {prompt.id}
                    <div style={{ fontSize: 10.5, color: "var(--text-subtle)", fontFamily: "var(--font-sans)" }}>
                      {prompt.description}
                    </div>
                  </Td>
                  <Td mono nowrap>{prompt.version}</Td>
                  <Td muted nowrap>{prompt.feature.replace(/_/g, " ").toLowerCase()}</Td>
                  <Td muted>{prompt.kind === "structured" ? "structured" : "text"}</Td>
                </Tr>
              ))}
            </Table>
          </Card>

          <Card>
            <SectionTitle hint="The only application capabilities the AI layer can reach. Everything else is unreachable by design.">
              Registered capabilities
            </SectionTitle>
            <Table
              columns={[
                { key: "name", label: "Capability" },
                { key: "type", label: "Effect" },
              ]}
            >
              {tools.map((tool) => (
                <Tr key={tool.name}>
                  <Td mono>
                    {tool.name}
                    <div style={{ fontSize: 10.5, color: "var(--text-subtle)", fontFamily: "var(--font-sans)" }}>
                      {tool.description}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={tool.mutates ? "warning" : "default"}>
                      {tool.mutates ? "writes state" : "read only"}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>
    </ChartTheme>
  );
}
