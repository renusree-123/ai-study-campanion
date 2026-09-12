import { requireUser } from "@/lib/auth/session";
import { assertProjectAccess } from "@/lib/auth/ownership";
import { getGrowth, getMasteryTimeline } from "@/lib/domain/analytics";
import { activeRecommendations } from "@/lib/domain/recommendations";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  Stat,
  StatGrid,
  formatPercent,
} from "@/components/ui";
import { ChartTheme, LineChart, MasteryMeter } from "@/components/charts";
import { RecommendationCard, TrendBadge } from "@/components/learning";

/** Growth analysis (PRD §30, §31, §32). */
export default async function GrowthPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;
  await assertProjectAccess(user.id, projectId);

  const [growth, timeline, recommendations] = await Promise.all([
    getGrowth(projectId, 14),
    getMasteryTimeline(projectId, 30),
    activeRecommendations(projectId, 1),
  ]);

  const measured = growth.filter((entry) => entry.attempts > 0);

  if (measured.length === 0) {
    return (
      <Card padding={26}>
        <EmptyState
          icon="📈"
          title="No growth data yet"
          body="Growth compares your mastery now against where it was, per concept. Take a quiz so there is something to compare."
          action={<Button href={`/projects/${projectId}/quiz`}>Take a quiz</Button>}
        />
      </Card>
    );
  }

  const improving = measured.filter((e) => e.delta >= 0.05);
  const declining = measured.filter((e) => e.delta <= -0.05);
  const stable = measured.filter((e) => Math.abs(e.delta) < 0.05);
  const strong = measured.filter((e) => e.currentLevel >= 0.75);
  const weak = measured.filter((e) => e.currentLevel < 0.5);

  return (
    <ChartTheme>
      <Card style={{ marginBottom: 18 }}>
        <StatGrid min={140}>
          <Stat label="Improving" value={improving.length} sub="concepts" tone="success" />
          <Stat label="Stable" value={stable.length} sub="concepts" tone="info" />
          <Stat
            label="Needs attention"
            value={declining.length + weak.filter((e) => e.delta < 0.05).length}
            sub="concepts"
            tone="danger"
          />
          <Stat label="Strong areas" value={strong.length} sub="at 75% or above" />
        </StatGrid>
      </Card>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(290px, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 18 }}>
          <Card>
            <SectionTitle hint="Average mastery across every concept in this project">
              Mastery over time
            </SectionTitle>
            <LineChart
              data={timeline.map((point) => ({ label: point.day, value: point.avgMastery }))}
              format="percent"
              yMax={1}
              emptyMessage="Not enough history yet — take another quiz"
            />
          </Card>

          <Card>
            <SectionTitle hint="Where your understanding stood two weeks ago, and where it stands now">
              Concept-level change
            </SectionTitle>
            <div style={{ display: "grid", gap: 16 }}>
              {measured.map((entry) => (
                <div key={entry.conceptId}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      marginBottom: 5,
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 560 }}>{entry.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          fontSize: 11.5,
                          color: "var(--text-muted)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {Math.round(entry.previousLevel * 100)}% → {Math.round(entry.currentLevel * 100)}%
                      </span>
                      <TrendBadge trend={entry.trend} />
                    </div>
                  </div>
                  <MasteryMeter level={entry.currentLevel} previous={entry.previousLevel} />
                  <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 4 }}>
                    {entry.attempts} question{entry.attempts === 1 ? "" : "s"} answered ·{" "}
                    {entry.delta >= 0 ? "+" : ""}
                    {Math.round(entry.delta * 100)} points ·{" "}
                    {Math.round(entry.confidence * 100)}% confidence in this estimate
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div style={{ display: "grid", gap: 18 }}>
          {recommendations.length > 0 ? (
            <RecommendationCard projectId={projectId} recommendation={recommendations[0]} />
          ) : null}

          <Card>
            <SectionTitle>Strong areas</SectionTitle>
            {strong.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                Nothing above 75% yet.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {strong.map((entry) => (
                  <div
                    key={entry.conceptId}
                    style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
                  >
                    <span style={{ fontSize: 12.4 }}>{entry.name}</span>
                    <Badge tone="success">{formatPercent(entry.currentLevel)}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle>Weak areas</SectionTitle>
            {weak.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                Nothing below 50%. Good place to be.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {weak.map((entry) => (
                  <div
                    key={entry.conceptId}
                    style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
                  >
                    <span style={{ fontSize: 12.4 }}>{entry.name}</span>
                    <Badge tone="danger">{formatPercent(entry.currentLevel)}</Badge>
                  </div>
                ))}
              </div>
            )}
            {weak.length > 0 ? (
              <div style={{ marginTop: 13 }}>
                <Button
                  href={`/projects/${projectId}/quiz?focus=${weak.slice(0, 3).map((e) => e.conceptId).join(",")}`}
                  size="sm"
                  full
                >
                  Quiz me on these
                </Button>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </ChartTheme>
  );
}
