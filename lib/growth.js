"use strict";

const LEVELS = [
  { level: 1, name: "星光起步", threshold: 0 },
  { level: 2, name: "稳步前行", threshold: 100 },
  { level: 3, name: "持续积累", threshold: 300 },
  { level: 4, name: "专注进阶", threshold: 700 },
  { level: 5, name: "习惯养成", threshold: 1200 },
  { level: 6, name: "记忆精进", threshold: 2000 },
  { level: 7, name: "稳定掌握", threshold: 3000 },
  { level: 8, name: "自律成长", threshold: 4500 },
  { level: 9, name: "恒心致远", threshold: 6500 },
  { level: 10, name: "星光同行", threshold: 9000 }
];

const BADGES = [
  { id: "daily-first", name: "初次完成", group: "坚持学习", kind: "daily", target: 1, description: "第一次完整完成每日计划" },
  { id: "study-days-3", name: "三日积累", group: "坚持学习", kind: "studyDays", target: 3, description: "累计完成学习 3 天" },
  { id: "study-days-7", name: "七日相伴", group: "坚持学习", kind: "studyDays", target: 7, description: "累计完成学习 7 天" },
  { id: "study-days-30", name: "三十日成长", group: "坚持学习", kind: "studyDays", target: 30, description: "累计完成学习 30 天" },
  { id: "streak-7", name: "连续一周", group: "连续学习", kind: "streak", target: 7, description: "连续学习 7 天" },
  { id: "streak-14", name: "双周坚持", group: "连续学习", kind: "streak", target: 14, description: "连续学习 14 天" },
  { id: "streak-30", name: "月度自律", group: "连续学习", kind: "streak", target: 30, description: "连续学习 30 天" },
  ...[
    [10, "十词起步"], [50, "五十词积累"], [100, "百词新阶"], [150, "一百五十词进阶"],
    [200, "双百积累"], [300, "三百词成长"], [400, "四百词拓展"], [600, "六百词积累"],
    [800, "八百词同行"], [1000, "千词里程"]
  ].map(([target, name]) => ({ id: `learned-${target}`, name, group: "累计学完", kind: "learned", target, description: `累计学完 ${target} 个词条` })),
  ...[
    [10, "掌握十词"], [50, "稳定五十"], [100, "百词掌握"], [150, "一百五十词稳固"],
    [200, "双百掌握"], [300, "三百词精进"], [400, "四百词扎实"], [600, "六百词稳进"],
    [800, "八百词熟练"], [1000, "千词掌握"]
  ].map(([target, name]) => ({ id: `mastered-${target}`, name, group: "累计掌握", kind: "mastered", target, description: `累计掌握 ${target} 个词条` })),
  { id: "review-days-7", name: "复习有恒", group: "坚持复习", kind: "reviewDays", target: 7, description: "在 7 个不同日期完成包含到期复习词的每日计划" }
];

function uniq(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort();
}

function longestStreak(dates) {
  const values = uniq(dates);
  if (!values.length) return 0;
  const set = new Set(values);
  let best = 0;
  for (const value of values) {
    const previous = new Date(`${value}T12:00:00`);
    previous.setDate(previous.getDate() - 1);
    const previousKey = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-${String(previous.getDate()).padStart(2, "0")}`;
    if (set.has(previousKey)) continue;
    let length = 0;
    const cursor = new Date(`${value}T12:00:00`);
    while (set.has(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`)) {
      length += 1;
      cursor.setDate(cursor.getDate() + 1);
    }
    best = Math.max(best, length);
  }
  return best;
}

function currentStreak(dates, today) {
  const set = new Set(uniq(dates));
  const cursor = new Date(`${today}T12:00:00`);
  if (!set.has(today)) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (set.has(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`)) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function rewardCount(achievement, prefix) {
  return achievement.rewardLedger.filter(item => item.key.startsWith(prefix)).length;
}

function progressFor(achievement, badge) {
  if (badge.kind === "daily") return rewardCount(achievement, "daily-complete:");
  if (badge.kind === "studyDays") return achievement.studyDates.length;
  if (badge.kind === "streak") return longestStreak(achievement.studyDates);
  if (badge.kind === "learned") return rewardCount(achievement, "word-learned:");
  if (badge.kind === "mastered") return rewardCount(achievement, "word-mastered:");
  if (badge.kind === "reviewDays") return achievement.reviewPlanDates.length;
  return 0;
}

function normalizeAchievement(raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  return {
    initializedAt: typeof raw.initializedAt === "string" ? raw.initializedAt : null,
    starlight: Number.isFinite(raw.starlight) ? Math.max(0, Math.trunc(raw.starlight)) : 0,
    rewardLedger: Array.isArray(raw.rewardLedger) ? raw.rewardLedger.filter(item => item && typeof item.key === "string") : [],
    badges: Array.isArray(raw.badges) ? raw.badges.filter(item => item && typeof item.id === "string") : [],
    studyDates: uniq(raw.studyDates),
    reviewPlanDates: uniq(raw.reviewPlanDates),
    migrationNotice: raw.migrationNotice && typeof raw.migrationNotice === "object" ? raw.migrationNotice : null
  };
}

function levelFor(starlight) {
  const current = [...LEVELS].reverse().find(item => starlight >= item.threshold) || LEVELS[0];
  const next = LEVELS[current.level] || null;
  return {
    ...current,
    next,
    remaining: next ? Math.max(0, next.threshold - starlight) : 0,
    progress: next ? Math.max(0, Math.min(1, (starlight - current.threshold) / (next.threshold - current.threshold))) : 1
  };
}

function addReward(store, reward) {
  const achievement = store.achievement;
  const existing = achievement.rewardLedger.find(item => item.key === reward.key);
  if (existing) return { added: false, reward: existing };
  const item = { key: reward.key, points: reward.points, reason: reward.reason, createdAt: reward.createdAt, retroactive: reward.retroactive === true };
  if (reward.wordId) item.wordId = reward.wordId;
  achievement.rewardLedger.push(item);
  achievement.starlight += reward.points;
  return { added: true, reward: item };
}

function thresholdDate(values, target, fallback) {
  const sorted = [...values].filter(Boolean).sort();
  return sorted[target - 1] || fallback;
}

function evaluateBadges(store, nowIso, options = {}) {
  const achievement = store.achievement;
  const existing = new Map(achievement.badges.map(item => [item.id, item]));
  const excluded = new Set(options.exclude || []);
  const newBadges = [];
  for (const badge of BADGES) {
    if (existing.has(badge.id) || excluded.has(badge.id)) continue;
    const progress = progressFor(achievement, badge);
    if (progress < badge.target) continue;
    let unlockedAt = nowIso;
    if (options.retroactive) {
      if (badge.kind === "studyDays" || badge.kind === "streak") unlockedAt = thresholdDate(achievement.studyDates, badge.target, nowIso);
      if (badge.kind === "learned") unlockedAt = thresholdDate(achievement.rewardLedger.filter(item => item.key.startsWith("word-learned:")).map(item => item.createdAt), badge.target, nowIso);
      if (badge.kind === "mastered") unlockedAt = thresholdDate(achievement.rewardLedger.filter(item => item.key.startsWith("word-mastered:")).map(item => item.createdAt), badge.target, nowIso);
    }
    const unlocked = { id: badge.id, unlockedAt, retroactive: options.retroactive === true };
    achievement.badges.push(unlocked);
    existing.set(badge.id, unlocked);
    newBadges.push(unlocked);
  }
  return newBadges;
}

function achievementSummary(store, today) {
  const achievement = normalizeAchievement(store.achievement);
  store.achievement = achievement;
  const unlocked = new Map(achievement.badges.map(item => [item.id, item]));
  return {
    starlight: achievement.starlight,
    level: levelFor(achievement.starlight),
    levels: LEVELS,
    studyDays: achievement.studyDates.length,
    streak: currentStreak(achievement.studyDates, today),
    longestStreak: longestStreak(achievement.studyDates),
    learnedCount: rewardCount(achievement, "word-learned:"),
    masteredCount: rewardCount(achievement, "word-mastered:"),
    badges: BADGES.map(badge => ({ ...badge, progress: Math.min(progressFor(achievement, badge), badge.target), unlockedAt: unlocked.get(badge.id)?.unlockedAt || null, retroactive: unlocked.get(badge.id)?.retroactive === true })),
    migrationNotice: achievement.migrationNotice
  };
}

function legacyEventDate(reviews, wordId, predicate, fallback) {
  const match = reviews.filter(item => item.wordId === wordId && predicate(item)).sort((a, b) => String(a.reviewedAt).localeCompare(String(b.reviewedAt)))[0];
  return match?.reviewedAt || fallback;
}

function migrateGrowth(store, nowIso, toDateKey) {
  store.achievement = normalizeAchievement(store.achievement);
  store.studySessions = Array.isArray(store.studySessions) ? store.studySessions.slice(-500) : [];
  store.activeSession = store.activeSession && typeof store.activeSession === "object" ? store.activeSession : null;
  if (store.achievement.initializedAt) return { migrated: false, points: 0, badgeCount: 0 };

  const beforePoints = store.achievement.starlight;
  for (const word of store.words) {
    const wordReviews = store.reviews.filter(item => item.wordId === word.id);
    const learnedByHistory = wordReviews.some(item => Number(item.stepAfter) >= 0 && item.completedRound === true);
    const masteredByHistory = wordReviews.some(item => Number(item.stepAfter) >= 4);
    const learned = word.status === "review" || word.status === "mastered" || learnedByHistory;
    const mastered = word.status === "mastered" || masteredByHistory;
    if (learned) addReward(store, {
      key: `word-learned:${word.id}`, points: 2, reason: "首次学完词条", wordId: word.id,
      createdAt: legacyEventDate(wordReviews, word.id, item => Number(item.stepAfter) >= 0 && item.completedRound === true, nowIso), retroactive: true
    });
    if (mastered) addReward(store, {
      key: `word-mastered:${word.id}`, points: 5, reason: "首次掌握词条", wordId: word.id,
      createdAt: legacyEventDate(wordReviews, word.id, item => Number(item.stepAfter) >= 4, nowIso), retroactive: true
    });
  }

  const historicDates = store.reviews.filter(item => {
    if (item.source === "manual-free" || item.source === "manual-formal") return item.sessionCompleted === true;
    return item.source === "scheduled" && item.mode === "spelling" && item.correct === true;
  }).map(item => toDateKey(item.reviewedAt)).filter(Boolean);
  store.achievement.studyDates = uniq([...store.achievement.studyDates, ...historicDates]);
  const newBadges = evaluateBadges(store, nowIso, { retroactive: true, exclude: ["daily-first", "review-days-7"] });
  store.achievement.initializedAt = nowIso;
  const points = store.achievement.starlight - beforePoints;
  store.achievement.migrationNotice = store.words.length || store.reviews.length
    ? { points, badgeCount: newBadges.length, createdAt: nowIso, acknowledgedAt: null }
    : null;
  return { migrated: true, points, badgeCount: newBadges.length };
}

module.exports = {
  LEVELS, BADGES, normalizeAchievement, migrateGrowth, achievementSummary, levelFor,
  addReward, evaluateBadges, longestStreak, currentStreak, uniq
};
