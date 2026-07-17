"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const port = 43174;
const base = `http://127.0.0.1:${port}`;
let dir;
let file;
let child;

async function api(pathname, method = "GET", body) {
  const response = await fetch(`${base}${pathname}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.ok, true, data.error);
  return data;
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocabulary-growth-test-"));
  file = path.join(dir, "app-data.json");
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    words: [
      { id: "a0000000-0000-0000-0000-000000000001", spelling: "apple", partOfSpeech: "n.", partOfSpeechNeedsReview: false, meaning: "苹果", status: "new", reviewStep: -1, nextDueDate: null, failureCount: 0, createdAt: now, updatedAt: now },
      { id: "a0000000-0000-0000-0000-000000000002", spelling: "in this way", partOfSpeech: "", partOfSpeechNeedsReview: false, meaning: "用这种方式", status: "new", reviewStep: -1, nextDueDate: null, failureCount: 0, createdAt: now, updatedAt: now }
    ],
    reviews: [], settings: {},
    achievement: { initializedAt: now, starlight: 0, rewardLedger: [], badges: [], studyDates: [], reviewPlanDates: [], migrationNotice: null },
    studySessions: [], activeSession: null
  }));
  child = spawn(process.execPath, ["server.js"], { cwd: root, stdio: "ignore", env: { ...process.env, PORT: String(port), DATA_FILE: file, BACKUP_DIR: path.join(dir, "backups") } });
  for (let index = 0; index < 50; index += 1) {
    try { if ((await fetch(`${base}/api/state`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("成长测试服务未启动");
});

test.after(async () => {
  try { await api("/api/shutdown", "POST", {}); } catch {}
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("每日计划由服务端判题、纠错并只结算一次", async () => {
  await api("/api/settings/daily-new-plan", "PUT", { count: 2 });
  let data = await api("/api/study-sessions", "POST", { source: "scheduled", mode: "spelling" });
  const sessionId = data.session.id;
  for (const wordId of [...data.session.familiarizeQueue]) data = await api(`/api/study-sessions/${sessionId}/familiarize`, "POST", { wordId });
  let active = data.state.activeSession;
  const firstId = active.queue[0];
  const secondId = active.queue[1];
  await api("/api/attempts", "POST", { attemptId: "try-1", sessionId, wordId: firstId, answer: "wrong" });
  await api("/api/attempts", "POST", { attemptId: "try-2", sessionId, wordId: secondId, answer: "in this way" });
  await api(`/api/study-sessions/${sessionId}/abandon`, "POST", {});
  data = await api("/api/study-sessions", "POST", { source: "scheduled", mode: "spelling" });
  const resumedSessionId = data.session.id;
  assert.deepEqual(data.session.failedIds, [firstId]);
  await api("/api/attempts", "POST", { attemptId: "try-3", sessionId: resumedSessionId, wordId: firstId, answer: "apple" });
  data = await api("/api/attempts", "POST", { attemptId: "try-4", sessionId: resumedSessionId, wordId: firstId, answer: "apple" });
  assert.equal(data.completionReport.starlightEarned, 24);
  assert.equal(data.completionReport.correctedWords.length, 1);
  assert.equal(data.state.achievement.starlight, 24);
  assert.equal(data.state.achievement.learnedCount, 2);
  const duplicate = await api("/api/attempts", "POST", { attemptId: "try-4", sessionId: resumedSessionId, wordId: firstId, answer: "apple" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.achievement.starlight, 24);
});

test("自由认读生成继续巩固报告但不增加星光", async () => {
  let data = await api("/api/study-sessions", "POST", { source: "manual-free", mode: "recognition", wordIds: ["a0000000-0000-0000-0000-000000000001"] });
  const sessionId = data.session.id;
  data = await api("/api/attempts", "POST", { attemptId: "recognition-1", sessionId, wordId: data.session.queue[0], remembered: false });
  assert.equal(data.completionReport.starlightEarned, 0);
  assert.equal(data.completionReport.continueWords.length, 1);
  assert.equal(data.state.achievement.starlight, 24);
  assert.equal(data.state.achievement.studyDays, 1);
});

test("完成日报后追加新词只发词条奖励", async () => {
  const imported = await api("/api/words/import", "POST", { words: [{ spelling: "banana", partOfSpeech: "n.", meaning: "香蕉" }] });
  const bananaId = imported.added[0].id;
  await api("/api/settings/daily-new-plan", "PUT", { count: 3 });
  let data = await api("/api/study-sessions", "POST", { source: "scheduled", mode: "spelling" });
  assert.equal(data.session.kind, "addition");
  const sessionId = data.session.id;
  data = await api(`/api/study-sessions/${sessionId}/familiarize`, "POST", { wordId: bananaId });
  data = await api("/api/attempts", "POST", { attemptId: "addition-1", sessionId, wordId: bananaId, answer: "banana" });
  assert.equal(data.completionReport.title, "今日追加学习");
  assert.equal(data.completionReport.starlightEarned, 2);
  assert.equal(data.completionReport.rewardDetails.some(item => item.key.startsWith("daily-complete:")), false);
  assert.equal(data.completionReport.starlightAfter, 26);
  assert.equal(data.completionReport.levelSummary.level, 1);
});

test("同一时间只允许一场未完成学习且可以明确结束", async () => {
  const wordId = "a0000000-0000-0000-0000-000000000001";
  const data = await api("/api/study-sessions", "POST", { source: "manual-free", mode: "recognition", wordIds: [wordId] });
  const second = await fetch(`${base}/api/study-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "manual-free", mode: "recognition", wordIds: [wordId] })
  });
  assert.equal(second.ok, false);
  assert.match((await second.json()).error, /未完成|继续/);
  const abandoned = await api(`/api/study-sessions/${data.session.id}/abandon`, "POST", {});
  assert.equal(abandoned.state.activeSession, null);
});

test("完成历史支持分页、完整报告和确认查看", async () => {
  const page = await api("/api/study-sessions?offset=0&limit=2");
  assert.equal(page.sessions.length, 2);
  assert.equal(page.nextOffset, 2);
  const detail = await api(`/api/study-sessions/${page.sessions[0].id}`);
  assert.equal(detail.report.id, page.sessions[0].id);
  const acknowledged = await api(`/api/study-sessions/${page.sessions[0].id}/acknowledge`, "POST", {});
  assert.ok(acknowledged.report.acknowledgedAt);
});

test("删除词条不回退终身星光和累计数量", async () => {
  const before = await api("/api/state");
  await api("/api/words/a0000000-0000-0000-0000-000000000001", "DELETE");
  const after = await api("/api/state");
  assert.equal(after.achievement.starlight, before.achievement.starlight);
  assert.equal(after.achievement.learnedCount, before.achievement.learnedCount);
  assert.equal(after.achievement.badges.length, 28);
  assert.equal(after.achievement.levels.length, 10);
});
