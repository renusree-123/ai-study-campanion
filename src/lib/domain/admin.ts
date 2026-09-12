import { db } from "../db";
import { pingDatabase } from "../db";
import { ai } from "../ai/router";
import { queueStats } from "../jobs/queue";
import { eventStats } from "../events/dispatcher";
import { dayKey } from "./analytics";

/**
 * Admin read model (PRD §56-§64).
 *
 * Every query here is explicitly platform-wide and lives in its own module,
 * separate from the ownership-guarded learner queries. Keeping the two apart
 * means an admin query can never be reached from a learner code path, and a
 * learner query never silently loses its `userId` filter.
 *
 * The admin surface is read-only: it answers "is the platform healthy and are
 * people learning", not "let me edit this person's data".
 */

function daysAgo(n: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - n);
  return date;
}

export async function getAdminOverview(days = 30) {
  const since = daysAgo(days);
  const dayAgo = new Date(Date.now() - 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [
    totalUsers,
    activeToday,
    activeWeek,
    totalSpaces,
    totalProjects,
    materials,
    materialsFailed,
    tutorMessages,
    quizzes,
    answers,
    aiLogs,
    activityCount,
    jobs,
    events,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { lastActiveAt: { gte: dayAgo } } }),
    db.user.count({ where: { lastActiveAt: { gte: weekAgo } } }),
    db.space.count({ where: { archivedAt: null } }),
    db.project.count({ where: { archivedAt: null } }),
    db.material.count(),
    db.material.count({ where: { status: "FAILED" } }),
    db.message.count({ where: { role: "user" } }),
    db.quiz.count({ where: { status: "COMPLETED" } }),
    db.quizAnswer.count(),
    db.aiRequestLog.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, latencyMs: true, costUsd: true, inputTokens: true, outputTokens: true },
    }),
    db.activityEvent.count({ where: { createdAt: { gte: since } } }),
    queueStats(),
    eventStats(),
  ]);

  const errors = aiLogs.filter((l) => l.status !== "SUCCESS" && l.status !== "FALLBACK").length;
  const totalLatency = aiLogs.reduce((sum, l) => sum + l.latencyMs, 0);
  const sortedLatencies = aiLogs.map((l) => l.latencyMs).sort((a, b) => a - b);

  return {
    users: { total: totalUsers, activeToday, activeWeek },
    content: {
      spaces: totalSpaces,
      projects: totalProjects,
      materials,
      materialsFailed,
    },
    learning: {
      tutorMessages,
      quizzesCompleted: quizzes,
      questionsAnswered: answers,
      activityEvents: activityCount,
    },
    ai: {
      requests: aiLogs.length,
      errorRate: aiLogs.length > 0 ? errors / aiLogs.length : 0,
      avgLatencyMs: aiLogs.length > 0 ? Math.round(totalLatency / aiLogs.length) : 0,
      p95LatencyMs: sortedLatencies.length
        ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))]
        : 0,
      costUsd: aiLogs.reduce((sum, l) => sum + l.costUsd, 0),
      inputTokens: aiLogs.reduce((sum, l) => sum + l.inputTokens, 0),
      outputTokens: aiLogs.reduce((sum, l) => sum + l.outputTokens, 0),
      provider: ai.describe(),
    },
    jobs,
    events,
  };
}

export async function getAdminUsers(options: { search?: string; limit?: number } = {}) {
  const users = await db.user.findMany({
    where: options.search
      ? {
          OR: [
            { email: { contains: options.search } },
            { name: { contains: options.search } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 100,
    include: {
      _count: { select: { spaces: true, projects: true, activity: true } },
    },
  });

  // One grouped query rather than a mastery query per user.
  const masteryByUser = await db.mastery.groupBy({
    by: ["userId"],
    _avg: { level: true },
    _count: { _all: true },
  });
  const masteryMap = new Map(masteryByUser.map((row) => [row.userId, row]));

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt,
    spaces: user._count.spaces,
    projects: user._count.projects,
    activity: user._count.activity,
    avgMastery: masteryMap.get(user.id)?._avg.level ?? 0,
    concepts: masteryMap.get(user.id)?._count._all ?? 0,
  }));
}

export async function getAdminUserDetail(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: {
      spaces: {
        where: { archivedAt: null },
        include: { _count: { select: { projects: true } } },
      },
      projects: {
        where: { archivedAt: null },
        include: {
          space: { select: { name: true } },
          _count: { select: { materials: true, conversations: true, quizzes: true } },
        },
        orderBy: { lastAccessedAt: "desc" },
      },
    },
  });
  if (!user) return null;

  const [activity, mastery, answers, aiLogs, messages] = await Promise.all([
    db.activityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { project: { select: { id: true, name: true } } },
    }),
    db.mastery.findMany({
      where: { userId },
      include: { concept: { select: { name: true } }, project: { select: { name: true } } },
      orderBy: { level: "asc" },
    }),
    db.quizAnswer.findMany({ where: { userId }, select: { isCorrect: true, score: true } }),
    db.aiRequestLog.findMany({
      where: { userId },
      select: { feature: true, costUsd: true, latencyMs: true, status: true },
    }),
    db.message.count({ where: { conversation: { userId }, role: "user" } }),
  ]);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
      lastActiveAt: user.lastActiveAt,
    },
    spaces: user.spaces,
    projects: user.projects,
    activity,
    mastery,
    performance: {
      answered: answers.length,
      correct: answers.filter((a) => a.isCorrect).length,
      avgScore: answers.length > 0 ? answers.reduce((s, a) => s + a.score, 0) / answers.length : 0,
      avgMastery: mastery.length > 0 ? mastery.reduce((s, m) => s + m.level, 0) / mastery.length : 0,
    },
    usage: {
      tutorMessages: messages,
      aiRequests: aiLogs.length,
      aiCostUsd: aiLogs.reduce((s, l) => s + l.costUsd, 0),
      aiErrors: aiLogs.filter((l) => l.status !== "SUCCESS" && l.status !== "FALLBACK").length,
    },
  };
}

export async function getAdminSpaces(limit = 100) {
  const spaces = await db.space.findMany({
    where: { archivedAt: null },
    orderBy: { lastAccessedAt: "desc" },
    take: limit,
    include: {
      user: { select: { id: true, name: true, email: true } },
      _count: { select: { projects: true, activity: true } },
    },
  });
  return spaces;
}

export async function getAdminProjects(limit = 100) {
  return db.project.findMany({
    where: { archivedAt: null },
    orderBy: { lastAccessedAt: "desc" },
    take: limit,
    include: {
      user: { select: { id: true, name: true, email: true } },
      space: { select: { id: true, name: true } },
      _count: { select: { materials: true, conversations: true, quizzes: true } },
    },
  });
}

export async function getAdminActivity(filters: {
  userId?: string;
  projectId?: string;
  type?: string;
  days?: number;
  limit?: number;
}) {
  const since = daysAgo(filters.days ?? 30);
  return db.activityEvent.findMany({
    where: {
      createdAt: { gte: since },
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: filters.limit ?? 100,
    include: {
      user: { select: { id: true, name: true, email: true } },
      project: { select: { id: true, name: true } },
    },
  });
}

export async function getAdminLearningAnalytics(days = 30) {
  const since = daysAgo(days);

  const [daily, featureUsage, masteryStats, hardestConcepts, activeProjects, typeCounts] =
    await Promise.all([
      db.userDailyStat.groupBy({
        by: ["day"],
        where: { day: { gte: dayKey(since) } },
        _sum: {
          tutorMessages: true,
          questionsAnswered: true,
          correctAnswers: true,
          aiRequests: true,
        },
        orderBy: { day: "asc" },
      }),
      db.aiRequestLog.groupBy({
        by: ["feature"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { costUsd: true },
        _avg: { latencyMs: true },
      }),
      db.mastery.aggregate({ _avg: { level: true }, _count: { _all: true } }),
      // Where users most commonly struggle, aggregated across the platform.
      db.mastery.groupBy({
        by: ["conceptId"],
        where: { evidenceCount: { gt: 0 } },
        _avg: { level: true },
        _count: { _all: true },
        having: { conceptId: { _count: { gt: 0 } } },
      }),
      db.project.count({ where: { lastAccessedAt: { gte: since }, archivedAt: null } }),
      db.activityEvent.groupBy({
        by: ["type"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { type: "desc" } },
        take: 12,
      }),
    ]);

  const conceptIds = hardestConcepts
    .sort((a, b) => (a._avg.level ?? 1) - (b._avg.level ?? 1))
    .slice(0, 10)
    .map((c) => c.conceptId);
  const conceptNames = await db.concept.findMany({
    where: { id: { in: conceptIds } },
    select: { id: true, name: true, project: { select: { name: true } } },
  });
  const nameMap = new Map(conceptNames.map((c) => [c.id, c]));

  return {
    daily: daily.map((row) => ({
      day: row.day,
      tutorMessages: row._sum.tutorMessages ?? 0,
      questionsAnswered: row._sum.questionsAnswered ?? 0,
      correctAnswers: row._sum.correctAnswers ?? 0,
      aiRequests: row._sum.aiRequests ?? 0,
    })),
    featureUsage: featureUsage
      .map((row) => ({
        feature: row.feature,
        count: row._count._all,
        costUsd: row._sum.costUsd ?? 0,
        avgLatencyMs: Math.round(row._avg.latencyMs ?? 0),
      }))
      .sort((a, b) => b.count - a.count),
    avgMastery: masteryStats._avg.level ?? 0,
    trackedConcepts: masteryStats._count._all,
    activeProjects,
    strugglingConcepts: conceptIds
      .map((id) => {
        const stat = hardestConcepts.find((c) => c.conceptId === id);
        const concept = nameMap.get(id);
        return concept
          ? {
              id,
              name: concept.name,
              project: concept.project.name,
              avgLevel: stat?._avg.level ?? 0,
              learners: stat?._count._all ?? 0,
            }
          : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null),
    activityTypes: typeCounts.map((row) => ({ type: row.type, count: row._count._all })),
  };
}

export async function getAdminAiUsage(days = 30) {
  const since = daysAgo(days);

  const [byFeature, byModel, byStatus, recent, retrieval, tools, dailyCost] = await Promise.all([
    db.aiRequestLog.groupBy({
      by: ["feature"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
      _avg: { latencyMs: true },
    }),
    db.aiRequestLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costUsd: true },
      _avg: { latencyMs: true },
    }),
    db.aiRequestLog.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.aiRequestLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: {
        id: true,
        traceId: true,
        feature: true,
        promptId: true,
        promptVersion: true,
        model: true,
        status: true,
        latencyMs: true,
        inputTokens: true,
        outputTokens: true,
        costUsd: true,
        error: true,
        createdAt: true,
      },
    }),
    db.retrievalLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        id: true,
        traceId: true,
        query: true,
        strategy: true,
        latencyMs: true,
        candidateCount: true,
        returnedCount: true,
        topScore: true,
        status: true,
        createdAt: true,
      },
    }),
    db.toolInvocation.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        id: true,
        traceId: true,
        toolName: true,
        status: true,
        denyReason: true,
        latencyMs: true,
        resultSummary: true,
        createdAt: true,
      },
    }),
    db.projectDailyStat.groupBy({
      by: ["day"],
      where: { day: { gte: dayKey(since) } },
      _sum: { aiRequests: true, aiCostUsd: true },
      orderBy: { day: "asc" },
    }),
  ]);

  return {
    byFeature: byFeature
      .map((row) => ({
        feature: row.feature,
        count: row._count._all,
        costUsd: row._sum.costUsd ?? 0,
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        avgLatencyMs: Math.round(row._avg.latencyMs ?? 0),
      }))
      .sort((a, b) => b.count - a.count),
    byModel: byModel.map((row) => ({
      model: row.model,
      count: row._count._all,
      costUsd: row._sum.costUsd ?? 0,
      avgLatencyMs: Math.round(row._avg.latencyMs ?? 0),
    })),
    byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
    recent,
    retrieval,
    tools,
    dailyCost: dailyCost.map((row) => ({
      day: row.day,
      requests: row._sum.aiRequests ?? 0,
      costUsd: row._sum.aiCostUsd ?? 0,
    })),
  };
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export async function getSystemHealth() {
  const [database, provider, jobs, events, recentErrors, stuckMaterials, failedEvents] =
    await Promise.all([
      pingDatabase(),
      ai.describe().isLive
        ? ai.health()
        : Promise.resolve({
            ok: true,
            latencyMs: 0,
            detail: "Offline deterministic provider (no API key configured)",
          }),
      queueStats(),
      eventStats(),
      db.aiRequestLog.count({
        where: {
          status: { notIn: ["SUCCESS", "FALLBACK"] },
          createdAt: { gte: new Date(Date.now() - 3600_000) },
        },
      }),
      db.material.count({
        where: { status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
      }),
      db.domainEvent.count({ where: { status: "FAILED" } }),
    ]);

  const totalRecentAi = await db.aiRequestLog.count({
    where: { createdAt: { gte: new Date(Date.now() - 3600_000) } },
  });
  const errorRate = totalRecentAi > 0 ? recentErrors / totalRecentAi : 0;

  const checks: HealthCheck[] = [
    {
      name: "Database",
      ok: database.ok,
      detail: database.ok ? "Responding to queries" : (database.error ?? "Unreachable"),
      latencyMs: database.latencyMs,
    },
    {
      name: "AI provider",
      ok: provider.ok,
      detail: provider.detail,
      latencyMs: provider.latencyMs,
    },
    {
      name: "Background jobs",
      // A backlog older than five minutes means the worker is not keeping up
      // (or is not running at all).
      ok: jobs.oldestQueuedAgeMs < 5 * 60_000 && jobs.counts.DEAD === 0,
      detail:
        jobs.counts.DEAD > 0
          ? `${jobs.counts.DEAD} job(s) exhausted their retries`
          : jobs.oldestQueuedAgeMs > 5 * 60_000
            ? `Oldest queued job is ${Math.round(jobs.oldestQueuedAgeMs / 60_000)}m old — is the worker running?`
            : `${jobs.backlog} in flight, ${jobs.counts.SUCCEEDED} completed`,
    },
    {
      name: "Event pipeline",
      ok: failedEvents === 0,
      detail:
        failedEvents > 0
          ? `${failedEvents} event(s) failed after all retries`
          : `${events.PROCESSED} processed, ${events.PENDING} pending`,
    },
    {
      name: "AI error rate (1h)",
      ok: errorRate < 0.1,
      detail:
        totalRecentAi === 0
          ? "No AI requests in the last hour"
          : `${(errorRate * 100).toFixed(1)}% of ${totalRecentAi} requests failed`,
    },
    {
      name: "Document processing",
      ok: stuckMaterials === 0,
      detail:
        stuckMaterials > 0
          ? `${stuckMaterials} material(s) stuck in processing for over 15 minutes`
          : "No stalled documents",
    },
  ];

  return { checks, jobs, events, healthy: checks.every((c) => c.ok) };
}
