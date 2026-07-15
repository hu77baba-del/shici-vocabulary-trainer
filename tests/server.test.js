"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dataFile = path.join(root, "data", "app-data.json");
let child;
let originalData;
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
  originalData = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null;
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({ version: 1, words: [], reviews: [], settings: { dailyNewLimit: 10 } }));
  child = spawn(process.execPath, ["server.js"], { cwd: root, stdio: "ignore", env: { ...process.env, PORT: String(testPort) } });
  baseUrl = await waitForServer();
});

test.after(async () => {
  try { await fetch(`${baseUrl}/api/shutdown`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch {}
  child?.kill();
  if (originalData) fs.writeFileSync(dataFile, originalData); else fs.rmSync(dataFile, { force: true });
});

test("首页和初始状态可读取", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /拾词/);
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.version, 1);
  assert.deepEqual(state.reviewDelays, [1, 3, 7, 14, 30]);
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
});

test("拒绝缺少释义或包含非法字符的词条", async () => {
  const response = await fetch(`${baseUrl}/api/words/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ words: [{ spelling: "bad_word!", meaning: "坏词" }] })
  });
  assert.equal(response.status, 400);
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

test("备份导出包含词库和记录", async () => {
  const response = await fetch(`${baseUrl}/api/backup`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  const data = await response.json();
  assert.equal(data.words.length, 2);
  assert.ok(data.reviews.length >= 2);
});
