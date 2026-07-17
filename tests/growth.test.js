"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LEVELS, BADGES, migrateGrowth, achievementSummary } = require("../lib/growth");

const iso = "2026-07-17T08:00:00.000Z";
const day = value => String(value).slice(0, 10);

test("十级门槛和二十八枚勋章固定不漂移", () => {
  assert.deepEqual(LEVELS.map(item => item.threshold), [0, 100, 300, 700, 1200, 2000, 3000, 4500, 6500, 9000]);
  assert.equal(LEVELS.at(-1).name, "星光同行");
  assert.equal(BADGES.length, 28);
  assert.deepEqual(BADGES.filter(item => item.kind === "learned").map(item => item.target), [10, 50, 100, 150, 200, 300, 400, 600, 800, 1000]);
  assert.deepEqual(BADGES.filter(item => item.kind === "mastered").map(item => item.target), [10, 50, 100, 150, 200, 300, 400, 600, 800, 1000]);
});

test("旧状态按可靠历史证据补发且不虚构每日奖励", () => {
  const store = {
    version: 1,
    words: [
      { id: "review", status: "review" },
      { id: "learning-history", status: "learning" },
      { id: "learning-only", status: "learning" },
      { id: "reset-mastered", status: "new" },
      { id: "mastered", status: "mastered" }
    ],
    reviews: [
      { wordId: "learning-history", source: "scheduled", mode: "spelling", correct: true, completedRound: true, stepAfter: 0, reviewedAt: "2026-07-01T08:00:00.000Z" },
      { wordId: "learning-only", source: "scheduled", mode: "spelling", correct: false, completedRound: false, stepAfter: -1, reviewedAt: "2026-07-02T08:00:00.000Z" },
      { wordId: "reset-mastered", source: "scheduled", mode: "spelling", correct: true, completedRound: true, stepAfter: 4, reviewedAt: "2026-07-03T08:00:00.000Z" }
    ],
    settings: {}
  };
  const before = structuredClone({ words: store.words, reviews: store.reviews, settings: store.settings });
  const result = migrateGrowth(store, iso, day);
  assert.equal(result.points, 18);
  assert.equal(store.achievement.rewardLedger.filter(item => item.key.startsWith("word-learned:")).length, 4);
  assert.equal(store.achievement.rewardLedger.filter(item => item.key.startsWith("word-mastered:")).length, 2);
  assert.equal(store.achievement.rewardLedger.some(item => item.key.startsWith("daily-complete:")), false);
  assert.equal(store.achievement.badges.some(item => ["daily-first", "review-days-7"].includes(item.id)), false);
  assert.deepEqual({ words: store.words, reviews: store.reviews, settings: store.settings }, before);
  const again = migrateGrowth(store, iso, day);
  assert.equal(again.migrated, false);
  assert.equal(store.achievement.starlight, 18);
});

test("八十九词模拟迁移只增加成长字段", () => {
  const words = Array.from({ length: 89 }, (_, index) => ({
    id: `word-${index}`, spelling: `word${index}`, meaning: `释义${index}`,
    status: index < 51 ? "review" : "new", reviewStep: index < 51 ? 0 : -1,
    nextDueDate: index < 51 ? "2026-07-18" : null, failureCount: index % 3
  }));
  const store = { version: 1, words: structuredClone(words), reviews: [], settings: { dailyNewPlan: { date: "2026-07-17", count: 2, wordIds: ["word-60", "word-61"], started: false } } };
  const before = structuredClone({ version: store.version, words: store.words, reviews: store.reviews, settings: store.settings });
  migrateGrowth(store, iso, day);
  assert.deepEqual({ version: store.version, words: store.words, reviews: store.reviews, settings: store.settings }, before);
  const summary = achievementSummary(store, "2026-07-17");
  assert.equal(summary.learnedCount, 51);
  assert.equal(summary.starlight, 102);
});

test("完整报告最多保留最近五百场", () => {
  const store = {
    version: 1,
    words: [],
    reviews: [],
    settings: {},
    studySessions: Array.from({ length: 501 }, (_, index) => ({ id: `session-${index}` })),
    achievement: { initializedAt: iso }
  };
  migrateGrowth(store, iso, day);
  assert.equal(store.studySessions.length, 500);
  assert.equal(store.studySessions[0].id, "session-1");
});
