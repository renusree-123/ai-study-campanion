import { db } from "../db";
import { getProjectMastery } from "./mastery";

/**
 * Analytics (PRD §30, §34, §35, §36).
 *
 * Two tiers, deliberately:
 *
 *  - **Pre-aggregated daily rollups** (ProjectDailyStat / UserDailyStat) power
 *    every time series. Trend charts read one indexed row per day instead of
 *    scanning the event log, which is what keeps the dashboards fast as
 *    history grows.
 *  - **Live aggregates** cover current-state figures (mastery now, concepts
 *    needing attention) where staleness would be misleading.
 *
 * The rollup job is idempotent — it recomputes a day from source and upserts,
 * so re-running it is safe and it self-heals after a missed run.
 */

export function dayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - n);
  return date;
}

export interface GrowthEntry {
  conceptId: string;
  name: string;
  previousLevel: number;
  currentLevel: number;
  delta: number;
  trend: string;
  confidence: number;
  attempts: number;
}

/**
 * Growth analysis (PRD §30, §31): the change in mastery per concept over a
 * window, using the earliest snapshot inside that window as the baseline.
 */
export async function getGrowth(
  projectId: string,
  windowDays = 14,
): Promise<GrowthEntry[]> {
  const since = daysAgo(windowDays);
  const mastery = await getProjectMastery(projectId);

  const entries = await Promise.all(
    mastery.map(async (concept) => {
      const baseline = await db.masterySnapshot.findFirst({
        where: { projectId, conceptId: concept.conceptId, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: { level: true },
      });
      const previousLevel = baseline?.level ?? concept.previousLevel;
      return {
        conceptId: concept.conceptId,
        name: concept.name,
        previousLevel,
        currentLevel: concept.level,
        delta: concept.level - previousLevel,
        trend: concept.trend,
        confidence: concept.confidence,
        attempts: concept.attemptCount,
      };
    }),
  );

  return entries.sort((a, b) => a.currentLevel - b.currentLevel);
}

/** Mastery over time, averaged per day, for the growth chart. */
export async function getMasteryTimeline(projectId: string, days = 30) {
  const since = daysAgo(days);
  const snapshots = await db.masterySnapshot.findMany({
    where: { projectId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { level: true, createdAt: true, conceptId: true },
  });

  // Carry the last known level per concept forward so a day with no activity
  // shows the level as it stood, not a dip toward zero.
  const byDay = new Map<string, Map<string, number>>();
  const running = new Map<string, number>();

  for (const snapshot of snapshots) {
    const key = dayKey(snapshot.createdAt);
    running.set(snapshot.conceptId, snapshot.level);
    byDay.set(key, new Map(running));
  }

  const series: { day: string; avgMastery: number }[] = [];
  let last: Map<string, number> | null = null;
  for (let i = days; i >= 0; i -= 1) {
    const key = dayKey(daysAgo(i));
    const levels: Map<string, number> | null = byDay.get(key) ?? last;
    if (!levels || levels.size === 0) continue;
    last = levels;
    const values = [...levels.values()];
    series.push({
      day: key,
      avgMastery: values.reduce((sum, v) => sum + v, 0) / values.length,
    });
  }
  return series;
}

export interface ProjectAnalytics {
  activity: {
    tutorQuestions: number;
    conversations: number;
    quizAttempts: number;
    quizzesCompleted: number;
    questionsAnswered: number;
    materials: number;
    activeDays: number;
  };
  performance: {
    accuracy: number;
    avgMastery: number;
    conceptsMastered: number;
    conceptsNeedingAttention: number;
    totalConcepts: number;
    openQuestionAvgScore: number;
  };
  aiActivity: {
    requests: number;
    tutorRequests: number;
    generatedQuestions: number;
    evaluations: number;
    recommendations: number;
    costUsd: number;
    avgLatencyMs: number;
    errorRate: number;
  };
  daily: {
    day: string;
    tutorMessages: number;
    questionsAnswered: number;
    correctAnswers: number;
    avgMastery: number;
  }[];
  masteryTimeline: { day: string; avgMastery: number }[];
  assessmentTimeline: { day: string; accuracy: number; answered: number }[];
}

export async function getProjectAnalytics(
  projectId: string,
  days = 30,
): Promise<ProjectAnalytics> {
  const since = daysAgo(days);

  const [
    tutorQuestions,
    conversations,
    quizAttempts,
    quizzesCompleted,
    answers,
    materials,
    mastery,
    aiLogs,
    dailyRows,
    activeDayRows,
    recommendations,
  ] = await Promise.all([
    db.message.count({ where: { conversation: { projectId }, role: "user" } }),
    db.conversation.count({ where: { projectId } }),
    db.quiz.count({ where: { projectId } }),
    db.quiz.count({ where: { projectId, status: "COMPLETED" } }),
    db.quizAnswer.findMany({
      where: { quiz: { projectId } },
      select: {
        isCorrect: true,
        score: true,
        answeredAt: true,
        question: { select: { type: true } },
      },
    }),
    db.material.count({ where: { projectId, status: "READY" } }),
    getProjectMastery(projectId),
    db.aiRequestLog.findMany({
      where: { projectId, createdAt: { gte: since } },
      select: { feature: true, status: true, latencyMs: true, costUsd: true },
    }),
    db.projectDailyStat.findMany({
      where: { projectId, day: { gte: dayKey(since) } },
      orderBy: { day: "asc" },
    }),
    db.activityEvent.findMany({
      where: { projectId },
      select: { createdAt: true },
    }),
    db.recommendation.count({ where: { projectId } }),
  ]);

  const correct = answers.filter((a) => a.isCorrect).length;
  const openAnswers = answers.filter((a) => a.question.type === "OPEN");
  const activeDays = new Set(activeDayRows.map((row) => dayKey(row.createdAt))).size;

  const errors = aiLogs.filter((log) => log.status !== "SUCCESS" && log.status !== "FALLBACK");
  const totalLatency = aiLogs.reduce((sum, log) => sum + log.latencyMs, 0);

  // Assessment accuracy per day, from the answers themselves.
  const answersByDay = new Map<string, { correct: number; total: number }>();
  for (const answer of answers) {
    if (answer.answeredAt < since) continue;
    const key = dayKey(answer.answeredAt);
    const bucket = answersByDay.get(key) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (answer.isCorrect) bucket.correct += 1;
    answersByDay.set(key, bucket);
  }

  return {
    activity: {
      tutorQuestions,
      conversations,
      quizAttempts,
      quizzesCompleted,
      questionsAnswered: answers.length,
      materials,
      activeDays,
    },
    performance: {
      accuracy: answers.length > 0 ? correct / answers.length : 0,
      avgMastery:
        mastery.length > 0 ? mastery.reduce((s, m) => s + m.level, 0) / mastery.length : 0,
      conceptsMastered: mastery.filter((m) => m.level >= 0.8).length,
      conceptsNeedingAttention: mastery.filter(
        (m) => m.trend === "NEEDS_ATTENTION" || (m.level < 0.5 && m.evidenceCount > 0),
      ).length,
      totalConcepts: mastery.length,
      openQuestionAvgScore:
        openAnswers.length > 0
          ? openAnswers.reduce((s, a) => s + a.score, 0) / openAnswers.length
          : 0,
    },
    aiActivity: {
      requests: aiLogs.length,
      tutorRequests: aiLogs.filter((l) => l.feature === "TUTOR").length,
      generatedQuestions: aiLogs.filter((l) => l.feature === "QUIZ_GENERATION").length,
      evaluations: aiLogs.filter((l) => l.feature === "OPEN_GRADING").length,
      recommendations,
      costUsd: aiLogs.reduce((sum, log) => sum + log.costUsd, 0),
      avgLatencyMs: aiLogs.length > 0 ? Math.round(totalLatency / aiLogs.length) : 0,
      errorRate: aiLogs.length > 0 ? errors.length / aiLogs.length : 0,
    },
    daily: dailyRows.map((row) => ({
      day: row.day,
      tutorMessages: row.tutorMessages,
      questionsAnswered: row.questionsAnswered,
      correctAnswers: row.correctAnswers,
      avgMastery: row.avgMastery,
    })),
    masteryTimeline: await getMasteryTimeline(projectId, days),
    assessmentTimeline: [...answersByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, bucket]) => ({
        day,
        accuracy: bucket.total > 0 ? bucket.correct / bucket.total : 0,
        answered: bucket.total,
      })),
  };
}

export interface GlobalAnalytics {
  overall: {
    spaces: number;
    projects: number;
    materials: number;
    activeDays: number;
    totalActivity: number;
    currentStreak: number;
  };
  performance: {
    avgMastery: number;
    avgAssessmentScore: number;
    conceptsImproving: number;
    conceptsNeedingAttention: number;
    totalConcepts: number;
  };
  aiUsage: {
    tutorInteractions: number;
    questionsAsked: number;
    quizzesCompleted: number;
    aiFeedbackGenerated: number;
    requests: number;
    costUsd: number;
  };
  daily: {
    day: string;
    tutorMessages: number;
    questionsAnswered: number;
    correctAnswers: number;
    avgMastery: number;
  }[];
  projects: {
    id: string;
    name: string;
    spaceName: string;
    mastery: number;
    lastAccessedAt: Date | null;
  }[];
}

export async function getGlobalAnalytics(userId: string, days = 30): Promise<GlobalAnalytics> {
  const since = daysAgo(days);

  const [spaces, projects, materials, masteries, answers, messages, quizzes, aiLogs, dailyRows, activity] =
    await Promise.all([
      db.space.count({ where: { userId, archivedAt: null } }),
      db.project.findMany({
        where: { userId, archivedAt: null },
        select: {
          id: true,
          name: true,
          masteryAvg: true,
          lastAccessedAt: true,
          space: { select: { name: true } },
        },
        orderBy: { lastAccessedAt: "desc" },
      }),
      db.material.count({ where: { userId, status: "READY" } }),
      db.mastery.findMany({ where: { userId }, select: { level: true, trend: true } }),
      db.quizAnswer.findMany({ where: { userId }, select: { isCorrect: true, score: true } }),
      db.message.count({ where: { conversation: { userId }, role: "user" } }),
      db.quiz.count({ where: { userId, status: "COMPLETED" } }),
      db.aiRequestLog.findMany({
        where: { userId, createdAt: { gte: since } },
        select: { costUsd: true, feature: true },
      }),
      db.userDailyStat.findMany({
        where: { userId, day: { gte: dayKey(since) } },
        orderBy: { day: "asc" },
      }),
      db.activityEvent.findMany({ where: { userId }, select: { createdAt: true } }),
    ]);

  const activeDaySet = new Set(activity.map((a) => dayKey(a.createdAt)));

  return {
    overall: {
      spaces,
      projects: projects.length,
      materials,
      activeDays: activeDaySet.size,
      totalActivity: activity.length,
      currentStreak: computeStreak(activeDaySet),
    },
    performance: {
      avgMastery:
        masteries.length > 0
          ? masteries.reduce((s, m) => s + m.level, 0) / masteries.length
          : 0,
      avgAssessmentScore:
        answers.length > 0 ? answers.reduce((s, a) => s + a.score, 0) / answers.length : 0,
      conceptsImproving: masteries.filter((m) => m.trend === "IMPROVING").length,
      conceptsNeedingAttention: masteries.filter((m) => m.trend === "NEEDS_ATTENTION").length,
      totalConcepts: masteries.length,
    },
    aiUsage: {
      tutorInteractions: messages,
      questionsAsked: answers.length,
      quizzesCompleted: quizzes,
      aiFeedbackGenerated: aiLogs.filter((l) => l.feature === "OPEN_GRADING").length,
      requests: aiLogs.length,
      costUsd: aiLogs.reduce((sum, log) => sum + log.costUsd, 0),
    },
    daily: dailyRows.map((row) => ({
      day: row.day,
      tutorMessages: row.tutorMessages,
      questionsAnswered: row.questionsAnswered,
      correctAnswers: row.correctAnswers,
      avgMastery: row.avgMastery,
    })),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      spaceName: project.space.name,
      mastery: project.masteryAvg,
      lastAccessedAt: project.lastAccessedAt,
    })),
  };
}

/** Consecutive active days ending today or yesterday. */
function computeStreak(activeDays: Set<string>): number {
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const key = dayKey(daysAgo(i));
    if (activeDays.has(key)) {
      streak += 1;
    } else if (i > 0) {
      // Today not yet active is fine; a gap before that ends the streak.
      break;
    }
  }
  return streak;
}

/**
 * Recomputes daily rollups for a project and its owner. Idempotent: computes
 * each day from source rows and upserts.
 */
export async function rollupDailyStats(projectId: string, days = 3): Promise<number> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  });
  if (!project) return 0;

  let written = 0;
  for (let i = 0; i < days; i += 1) {
    const dayStart = daysAgo(i);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const day = dayKey(dayStart);
    const range = { gte: dayStart, lt: dayEnd };

    const [tutorMessages, quizzesStarted, quizzesCompleted, answers, materialsAdded, aiLogs, mastery] =
      await Promise.all([
        db.message.count({
          where: { conversation: { projectId }, role: "user", createdAt: range },
        }),
        db.quiz.count({ where: { projectId, startedAt: range } }),
        db.quiz.count({ where: { projectId, status: "COMPLETED", completedAt: range } }),
        db.quizAnswer.findMany({
          where: { quiz: { projectId }, answeredAt: range },
          select: { isCorrect: true },
        }),
        db.material.count({ where: { projectId, createdAt: range } }),
        db.aiRequestLog.findMany({
          where: { projectId, createdAt: range },
          select: { costUsd: true },
        }),
        db.mastery.findMany({ where: { projectId }, select: { level: true } }),
      ]);

    const avgMastery =
      mastery.length > 0 ? mastery.reduce((s, m) => s + m.level, 0) / mastery.length : 0;

    const data = {
      tutorMessages,
      quizzesStarted,
      quizzesCompleted,
      questionsAnswered: answers.length,
      correctAnswers: answers.filter((a) => a.isCorrect).length,
      materialsAdded,
      aiRequests: aiLogs.length,
      aiCostUsd: aiLogs.reduce((sum, log) => sum + log.costUsd, 0),
      avgMastery,
      activeSessions: 0,
    };

    await db.projectDailyStat.upsert({
      where: { projectId_day: { projectId, day } },
      create: { projectId, day, ...data },
      update: data,
    });
    written += 1;
  }

  await rollupUserStats(project.userId, days);
  return written;
}

export async function rollupUserStats(userId: string, days = 3): Promise<void> {
  for (let i = 0; i < days; i += 1) {
    const dayStart = daysAgo(i);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const day = dayKey(dayStart);
    const range = { gte: dayStart, lt: dayEnd };

    const [tutorMessages, quizzesCompleted, answers, materialsAdded, aiLogs, mastery] =
      await Promise.all([
        db.message.count({
          where: { conversation: { userId }, role: "user", createdAt: range },
        }),
        db.quiz.count({ where: { userId, status: "COMPLETED", completedAt: range } }),
        db.quizAnswer.findMany({ where: { userId, answeredAt: range }, select: { isCorrect: true } }),
        db.material.count({ where: { userId, createdAt: range } }),
        db.aiRequestLog.findMany({ where: { userId, createdAt: range }, select: { costUsd: true } }),
        db.mastery.findMany({ where: { userId }, select: { level: true } }),
      ]);

    const data = {
      tutorMessages,
      quizzesCompleted,
      questionsAnswered: answers.length,
      correctAnswers: answers.filter((a) => a.isCorrect).length,
      materialsAdded,
      aiRequests: aiLogs.length,
      aiCostUsd: aiLogs.reduce((sum, log) => sum + log.costUsd, 0),
      avgMastery:
        mastery.length > 0 ? mastery.reduce((s, m) => s + m.level, 0) / mastery.length : 0,
      activeMinutes: 0,
    };

    await db.userDailyStat.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day, ...data },
      update: data,
    });
  }
}
