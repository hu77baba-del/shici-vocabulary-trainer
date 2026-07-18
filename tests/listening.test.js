"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  isListeningWord,
  pronunciationDistance,
  buildListeningChoices
} = require("../lib/phonetics");

const root = path.resolve(__dirname, "..");
const port = 43175;
const base = `http://127.0.0.1:${port}`;
const ids = {
  right: "b0000000-0000-0000-0000-000000000001",
  write: "b0000000-0000-0000-0000-000000000002",
  light: "b0000000-0000-0000-0000-000000000003",
  night: "b0000000-0000-0000-0000-000000000004",
  apple: "b0000000-0000-0000-0000-000000000005",
  phrase: "b0000000-0000-0000-0000-000000000006",
  fresh: "b0000000-0000-0000-0000-000000000007"
};
let dir;
let file;
let child;

function fixtureWord(id, spelling, meaning, status = "review", partOfSpeech = "n.") {
  const now = "2026-07-18T08:00:00.000Z";
  return { id, spelling, meaning, partOfSpeech, partOfSpeechNeedsReview: false, status, reviewStep: status === "new" ? -1 : 1, nextDueDate: status === "new" ? null : "2026-07-20", failureCount: 2, createdAt: now, updatedAt: now };
}

const words = [
  fixtureWord(ids.right, "right", "正确的", "review", "adj."),
  fixtureWord(ids.write, "write", "书写", "review", "v."),
  fixtureWord(ids.light, "light", "光线"),
  fixtureWord(ids.night, "night", "夜晚"),
  fixtureWord(ids.apple, "apple", "苹果"),
  fixtureWord(ids.phrase, "in this way", "用这种方式", "review", ""),
  fixtureWord(ids.fresh, "bright", "明亮的", "new", "adj.")
];

async function request(pathname, method = "GET", body, expectedOk = true) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.ok, expectedOk, data.error);
  return { response, data };
}

async function startServer() {
  child = spawn(process.execPath, ["server.js"], { cwd: root, stdio: "ignore", env: { ...process.env, PORT: String(port), DATA_FILE: file, BACKUP_DIR: path.join(dir, "backups") } });
  for (let index = 0; index < 50; index += 1) {
    try { if ((await fetch(`${base}/api/state`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("听力测试服务未启动");
}

test("离线音素会优先识别同音和近音单词", () => {
  assert.equal(pronunciationDistance("right", "write"), 0);
  assert.ok(pronunciationDistance("right", "light") < pronunciationDistance("right", "apple"));
  const choices = buildListeningChoices(words[0], words, 4);
  assert.deepEqual(new Set(choices), new Set([ids.right, ids.write, ids.light, ids.night]));
  assert.equal(isListeningWord(words.find(word => word.id === ids.phrase)), false);
  assert.equal(isListeningWord(words.find(word => word.id === ids.fresh)), false);
});

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocabulary-listening-test-"));
  file = path.join(dir, "app-data.json");
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({
    version: 1, words, reviews: [], settings: {},
    achievement: { initializedAt: now, starlight: 30, rewardLedger: [], badges: [], studyDates: [], reviewPlanDates: [], migrationNotice: null },
    studySessions: [], activeSession: null
  }));
  await startServer();
});

test.after(async () => {
  try { await request("/api/shutdown", "POST", {}); } catch {}
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("听力场次固定四选项、服务端判题并独立记录错题", async () => {
  let result = await request("/api/state");
  const before = result.data.words.find(word => word.id === ids.right);
  assert.equal(before.listeningFailureCount, 0);
  assert.equal(before.lastListeningFailedAt, null);

  await request("/api/study-sessions", "POST", { source: "manual-formal", mode: "listening", wordIds: [ids.right] }, false);
  await request("/api/study-sessions", "POST", { source: "scheduled", mode: "listening" }, false);
  await request("/api/study-sessions", "POST", { source: "manual-free", mode: "listening", wordIds: [ids.phrase] }, false);

  result = await request("/api/study-sessions", "POST", { source: "manual-free", mode: "listening", wordIds: [ids.right] });
  const sessionId = result.data.session.id;
  const question = result.data.session.listeningQuestion;
  assert.equal(question.options.length, 4);
  assert.equal(new Set(question.options.map(option => option.meaning)).size, 4);
  const optionIds = question.options.map(option => option.id);
  assert.ok(optionIds.includes(ids.right));
  assert.ok(optionIds.includes(ids.write));
  assert.equal(optionIds.includes(ids.phrase), false);
  assert.equal(optionIds.includes(ids.fresh), false);
  assert.equal(Object.hasOwn(question, "spelling"), false);

  await request("/api/attempts", "POST", { attemptId: "listen-invalid", sessionId, wordId: ids.right, selectedWordId: ids.fresh }, false);
  result = await request(`/api/study-sessions/${sessionId}/listening-replay`, "POST", {});
  assert.equal(result.data.session.listeningQuestion.replayUsed, true);
  await request(`/api/study-sessions/${sessionId}/listening-replay`, "POST", {}, false);

  const wrongId = optionIds.find(id => id !== ids.right);
  result = await request("/api/attempts", "POST", { attemptId: "listen-wrong", sessionId, wordId: ids.right, selectedWordId: wrongId });
  assert.equal(result.data.correct, false);
  const afterWrong = result.data.state.words.find(word => word.id === ids.right);
  assert.equal(afterWrong.listeningFailureCount, 1);
  assert.ok(afterWrong.lastListeningFailedAt);
  assert.equal(afterWrong.failureCount, before.failureCount);
  assert.equal(afterWrong.status, before.status);
  assert.equal(afterWrong.reviewStep, before.reviewStep);
  assert.equal(afterWrong.nextDueDate, before.nextDueDate);
  assert.equal(result.data.state.achievement.starlight, 30);
  assert.equal(result.data.state.activeSession.listeningQuestion.replayUsed, false);

  const retryOptions = result.data.state.activeSession.listeningQuestion.options.map(option => option.id);
  const exited = new Promise(resolve => child.once("exit", resolve));
  await request("/api/shutdown", "POST", {});
  await exited;
  await startServer();
  result = await request("/api/state");
  assert.deepEqual(result.data.activeSession.listeningQuestion.options.map(option => option.id), retryOptions);
  assert.equal(result.data.activeSession.currentWordId, ids.right);

  result = await request("/api/attempts", "POST", { attemptId: "listen-correct", sessionId, wordId: ids.right, selectedWordId: ids.right });
  assert.equal(result.data.correct, true);
  assert.equal(result.data.completionReport.title, "听力认词完成");
  assert.equal(result.data.completionReport.starlightEarned, 0);
  assert.deepEqual(result.data.completionReport.correctedWords.map(word => word.id), [ids.right]);
  assert.equal(result.data.state.achievement.starlight, 30);
  assert.equal(result.data.state.achievement.studyDays, 1);
  const record = result.data.state.reviews.at(-1);
  assert.equal(record.mode, "listening");
  assert.equal(record.selectedWordId, ids.right);

  result = await request("/api/attempts", "POST", { attemptId: "listen-wrong", sessionId, wordId: ids.right, selectedWordId: wrongId });
  assert.equal(result.data.duplicate, true);
  assert.equal(result.data.state.words.find(word => word.id === ids.right).listeningFailureCount, 1);

  result = await request(`/api/words/${ids.right}?action=reset`, "POST", {});
  const resetWord = result.data.state.words.find(word => word.id === ids.right);
  assert.equal(resetWord.failureCount, 0);
  assert.equal(resetWord.listeningFailureCount, 0);
  assert.equal(resetWord.lastListeningFailedAt, null);
});

test("听力界面作答前不包含预置英文答案并限制一次重播", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const card = html.slice(html.indexOf('id="listening-card"'), html.indexOf('id="study-complete"'));
  assert.match(card, /听发音，选择正确的中文意思/);
  assert.match(card, /id="listening-options"/);
  assert.doesNotMatch(card, /example|apple|英文答案/);
  const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(source, /question\.options\.length !== 4/);
  assert.match(source, /listening-replay/);
  assert.match(source, /option\.meaning/);
  assert.match(source, /listeningOption\.disabled = formal \|\| !enoughListeningChoices/);
  assert.match(source, /setTimeout\(\(\) => speak\(word\.spelling, \{ errorMessage:/);
});
