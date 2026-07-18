"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
let testDir;
let dataFile;
let child;
let baseUrl;
const testPort = 43173;

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/state`);
      if (response.ok) return `http://127.0.0.1:${testPort}`;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("测试服务器未启动");
}

test.before(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocabulary-trainer-test-"));
  dataFile = path.join(testDir, "app-data.json");
  fs.writeFileSync(dataFile, JSON.stringify({ version: 1, words: [], reviews: [], settings: { dailyNewLimit: 10 } }));
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, PORT: String(testPort), DATA_FILE: dataFile }
  });
  baseUrl = await waitForServer();
});

test.after(async () => {
  try { await fetch(`${baseUrl}/api/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch {}
  child?.kill();
  if (testDir?.startsWith(os.tmpdir())) fs.rmSync(testDir, { recursive: true, force: true });
});

test("首页和初始状态可读取", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /拾词/);
  assert.match(html, /今天学习几个新词/);
  assert.match(html, /自主复习/);
  assert.doesNotMatch(html, /每天最多学习 10 个/);
  const spellingCard = html.slice(html.indexOf('id="spelling-card"'), html.indexOf('id="recognition-card"'));
  assert.match(spellingCard, /看中文和词性，拼出英文/);
  assert.doesNotMatch(spellingCard, /data-speak-current|播放发音/, "拼写卡不能提供英文发音提示");
  const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.doesNotMatch(html, /先听一遍发音/);
  assert.doesNotMatch(appSource, /听发音、看中文完成拼写/);
  const spellingFlow = appSource.slice(appSource.indexOf("function showNextSpelling"), appSource.indexOf("function requeueLater"));
  assert.doesNotMatch(spellingFlow, /speak\s*\(/, "进入拼写题时不能自动朗读英文");
  assert.match(html.slice(html.indexOf('id="familiarize-card"'), html.indexOf('id="spelling-card"')), /data-speak-current/);
  assert.match(html.slice(html.indexOf('id="recognition-card"'), html.indexOf('id="study-complete"')), /data-speak-current/);
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.version, 1);
  assert.deepEqual(state.reviewDelays, [1, 3, 7, 14, 30]);
  assert.equal(state.settings.dailyNewLimit, 10, "旧设置应保持可读取");
  assert.equal(state.settings.dailyNewPlan, undefined, "旧数据不应自动套用固定数量");
});

test("PaddleOCR 程序、中英文模型与 WASM 已离线打包", () => {
  const required = [
    "public/vendor/paddleocr/runtime/paddle-ocr.js",
    "public/vendor/paddleocr/runtime/ocr-worker.js",
    "public/vendor/paddleocr/models/PP-OCRv5_mobile_det_onnx_infer.tar",
    "public/vendor/paddleocr/models/PP-OCRv5_mobile_rec_onnx_infer.tar",
    "public/vendor/paddleocr/wasm/ort-wasm-simd-threaded.jsep.mjs",
    "public/vendor/paddleocr/wasm/ort-wasm-simd-threaded.jsep.wasm"
  ];
  for (const relative of required) {
    const stat = fs.statSync(path.join(root, relative));
    assert.ok(stat.size > 1000, `${relative} 应为有效资源文件`);
  }
});

test("允许导入重复英文并分别保存", async () => {
  const response = await fetch(`${baseUrl}/api/words/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: [{ spelling: "example", meaning: "例子" }, { spelling: "Example", meaning: "实例" }] })
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.added.length, 2);
  assert.notEqual(data.added[0].id, data.added[1].id);
  assert.equal(data.added[0].partOfSpeech, "");
  assert.equal(data.added[0].partOfSpeechNeedsReview, true);
});

test("每日新词计划固定词条，开始后只能增加", async () => {
  await fetch(`${baseUrl}/api/words/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: [{ spelling: "another", meaning: "另一个" }] })
  });
  let response = await fetch(`${baseUrl}/api/settings/daily-new-plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 0 })
  });
  let data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.plan.count, 0, "应允许当天不学习新词");

  response = await fetch(`${baseUrl}/api/settings/daily-new-plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 2 })
  });
  data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.plan.count, 2);
  assert.equal(data.plan.wordIds.length, 2);
  const assigned = data.plan.wordIds;

  data = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.deepEqual(data.settings.dailyNewPlan.wordIds, assigned, "刷新后应保留同一批新词");

  response = await fetch(`${baseUrl}/api/settings/daily-new-plan/start`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/settings/daily-new-plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 })
  });
  assert.equal(response.status, 400);
  response = await fetch(`${baseUrl}/api/settings/daily-new-plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1.5 })
  });
  assert.equal(response.status, 400);
  response = await fetch(`${baseUrl}/api/settings/daily-new-plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 3 })
  });
  data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.plan.count, 3);
});

test("批量删除同步清理学习记录和当天计划", async () => {
  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  const assignedId = state.settings.dailyNewPlan.wordIds[0];
  let response = await fetch(`${baseUrl}/api/words/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: [{ spelling: "remove", meaning: "删除" }, { spelling: "replacement", meaning: "替补" }] })
  });
  let data = await response.json();
  const [removeWord, replacementWord] = data.added;
  await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wordId: removeWord.id, sessionId: "batch-delete", mode: "spelling", answer: "remove", correct: true, completedRound: true })
  });

  response = await fetch(`${baseUrl}/api/words`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [assignedId, removeWord.id, removeWord.id] })
  });
  data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.deletedCount, 2, "重复 ID 只应删除一次");
  assert.equal(data.state.words.length, 3);
  assert.equal(data.state.settings.dailyNewPlan.count, 2);
  assert.ok(!data.state.settings.dailyNewPlan.wordIds.includes(assignedId));
  assert.ok(!data.state.reviews.some(record => record.wordId === removeWord.id));

  response = await fetch(`${baseUrl}/api/words`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [] })
  });
  assert.equal(response.status, 400);

  response = await fetch(`${baseUrl}/api/settings/daily-new-plan`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 3 })
  });
  data = await response.json();
  assert.equal(data.plan.count, 3);
  assert.ok(data.plan.wordIds.includes(replacementWord.id));
});

test("拒绝缺少释义或包含非法字符的词条", async () => {
  const response = await fetch(`${baseUrl}/api/words/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: [{ spelling: "bad_word!", meaning: "坏词" }] })
  });
  assert.equal(response.status, 400);
});

test("允许导入由斜杠连接的同义英文短语", async () => {
  const response = await fetch(`${baseUrl}/api/words/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: [{ spelling: "meet with / face many difficulties", meaning: "遇到／面临许多困难" }] })
  });
  const data = await response.json();
  assert.equal(response.status, 201);
  assert.equal(data.added[0].spelling, "meet with/face many difficulties");
  assert.equal(data.added[0].partOfSpeech, "");
  assert.equal(data.added[0].partOfSpeechNeedsReview, false);
  const cleanup = await fetch(`${baseUrl}/api/words/${data.added[0].id}`, { method: "DELETE" });
  assert.equal(cleanup.status, 200);
});

test("词性可导入、规范化、编辑并进入备份", async () => {
  let response = await fetch(`${baseUrl}/api/words/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: [
      { spelling: "heart", partOfSpeech: "N / Adj", meaning: "心脏；内心" },
      { spelling: "to be honest", partOfSpeech: "n.", meaning: "说实话" },
      { spelling: "future", partOfSpeech: "lex.", meaning: "未来" }
    ] })
  });
  let data = await response.json();
  assert.equal(response.status, 201);
  const [heart, phrase, unfamiliar] = data.added;
  assert.equal(heart.partOfSpeech, "n./adj.");
  assert.equal(heart.partOfSpeechNeedsReview, false);
  assert.equal(phrase.partOfSpeech, "");
  assert.equal(phrase.partOfSpeechNeedsReview, false);
  assert.equal(unfamiliar.partOfSpeech, "lex.");
  assert.equal(unfamiliar.partOfSpeechNeedsReview, true);

  response = await fetch(`${baseUrl}/api/words/${heart.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spelling: "heart", partOfSpeech: "noun", meaning: "心脏；内心" })
  });
  data = await response.json();
  assert.equal(data.word.partOfSpeech, "n.");
  assert.equal(data.word.partOfSpeechNeedsReview, false);

  data = await (await fetch(`${baseUrl}/api/backup`)).json();
  assert.equal(data.words.find(word => word.id === heart.id).partOfSpeech, "n.");

  response = await fetch(`${baseUrl}/api/words`, {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [heart.id, phrase.id, unfamiliar.id] })
  });
  assert.equal(response.status, 200);
});

test("答错后重置阶段，连续过关后进入一天复习", async () => {
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const word = state.words[0];
  let response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wordId: word.id, sessionId: "test", mode: "spelling", answer: "exampel", correct: false, completedRound: false })
  });
  let data = await response.json();
  assert.equal(data.word.status, "learning");
  assert.equal(data.word.reviewStep, -1);
  response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wordId: word.id, sessionId: "test", mode: "spelling", answer: "example", correct: true, completedRound: true })
  });
  data = await response.json();
  assert.equal(data.word.status, "review");
  assert.equal(data.word.reviewStep, 0);
  assert.ok(data.word.nextDueDate);
});

test("自由练习只累计错误，不改变正式复习进度", async () => {
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const word = state.words[0];
  const before = { status: word.status, reviewStep: word.reviewStep, nextDueDate: word.nextDueDate, failureCount: word.failureCount };
  const response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wordId: word.id, sessionId: "manual-free", source: "manual-free", mode: "spelling",
      answer: "wrong", correct: false, completedRound: false, sessionCompleted: true
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.word.status, before.status);
  assert.equal(data.word.reviewStep, before.reviewStep);
  assert.equal(data.word.nextDueDate, before.nextDueDate);
  assert.equal(data.word.failureCount, before.failureCount + 1);
  const record = data.state.reviews.at(-1);
  assert.equal(record.source, "manual-free");
  assert.equal(record.sessionCompleted, true);
});

test("自主复习拒绝新词和正式认读，正式拼写沿用复习阶段", async () => {
  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  const newWord = state.words.find(word => word.status === "new");
  let response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wordId: newWord.id, source: "manual-free", mode: "recognition", correct: true })
  });
  assert.equal(response.status, 400);

  response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wordId: newWord.id, sessionId: "prepare", mode: "spelling", answer: newWord.spelling, correct: true, completedRound: true })
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wordId: newWord.id, source: "manual-formal", mode: "recognition", correct: true })
  });
  assert.equal(response.status, 400);

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  const learned = state.words.find(word => word.id === newWord.id);
  response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wordId: learned.id, sessionId: "manual-formal", source: "manual-formal", mode: "spelling",
      answer: learned.spelling, correct: true, completedRound: true, sessionCompleted: true
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.word.reviewStep, 1);
  assert.equal(data.state.reviews.at(-1).source, "manual-formal");
});

test("备份导出包含词库和记录", async () => {
  const response = await fetch(`${baseUrl}/api/backup`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  const data = await response.json();
  assert.equal(data.words.length, 3);
  assert.ok(data.reviews.length >= 2);
  assert.equal(data.settings.dailyNewPlan.count, 3);
});

test("旧格式备份恢复后自动补齐词性兼容字段", async () => {
  const response = await fetch(`${baseUrl}/api/restore`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 1,
      words: [
        { id: "legacy-word", spelling: "example", meaning: "例子", status: "new", reviewStep: -1, nextDueDate: null, failureCount: 0 },
        { id: "legacy-phrase", spelling: "in this way", meaning: "用这种方式", status: "new", reviewStep: -1, nextDueDate: null, failureCount: 0 }
      ],
      reviews: [], settings: {}
    })
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.state.words[0].partOfSpeech, "");
  assert.equal(data.state.words[0].partOfSpeechNeedsReview, true);
  assert.equal(data.state.words[1].partOfSpeech, "");
  assert.equal(data.state.words[1].partOfSpeechNeedsReview, false);
  assert.equal(data.state.words[0].listeningFailureCount, 0);
  assert.equal(data.state.words[0].lastListeningFailedAt, null);
});
