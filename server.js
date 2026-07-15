"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { exec } = require("node:child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "app-data.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PORT_START = Number(process.env.PORT) || 4173;
const MAX_BODY = 12 * 1024 * 1024;
const REVIEW_DELAYS = [1, 3, 7, 14, 30];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".wasm": "application/wasm",
  ".tar": "application/x-tar",
  ".gz": "application/gzip"
};

function emptyStore() {
  return { version: 1, words: [], reviews: [], settings: { dailyNewLimit: 10 } };
}

function ensureData() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) atomicWrite(emptyStore());
}

function readStore() {
  ensureData();
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.words) || !Array.isArray(parsed.reviews)) {
    throw new Error("数据文件结构无效");
  }
  parsed.settings ||= { dailyNewLimit: 10 };
  return parsed;
}

function atomicWrite(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temp, DATA_FILE);
}

function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

function cleanText(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeWord(raw) {
  const spelling = cleanText(raw.spelling, 120);
  const meaning = cleanText(raw.meaning, 300);
  if (!spelling || !meaning) throw new Error("英文和中文释义不能为空");
  if (!/^[A-Za-z][A-Za-z\s'’.-]*$/.test(spelling)) throw new Error(`英文格式不正确：${spelling}`);
  return { spelling, meaning };
}

function publicState(store) {
  return {
    version: store.version,
    words: store.words,
    reviews: store.reviews.slice(-2000),
    settings: store.settings,
    today: dateKey(),
    reviewDelays: REVIEW_DELAYS
  };
}

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("请求内容不是有效 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function backupStore(store) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(BACKUP_DIR, `backup-${stamp}.json`), JSON.stringify(store, null, 2));
  const files = fs.readdirSync(BACKUP_DIR).filter(name => name.endsWith(".json")).sort().reverse();
  for (const old of files.slice(5)) fs.unlinkSync(path.join(BACKUP_DIR, old));
}

async function api(req, res, url) {
  const store = readStore();

  if (req.method === "GET" && url.pathname === "/api/state") {
    return send(res, 200, publicState(store));
  }

  if (req.method === "POST" && url.pathname === "/api/words/import") {
    const body = await readBody(req);
    if (!Array.isArray(body.words) || !body.words.length || body.words.length > 500) throw new Error("请选择 1 至 500 个词条");
    const now = new Date().toISOString();
    const added = body.words.map(item => {
      const word = normalizeWord(item);
      return {
        id: crypto.randomUUID(), ...word, status: "new", reviewStep: -1,
        nextDueDate: null, failureCount: 0, createdAt: now, updatedAt: now
      };
    });
    store.words.push(...added);
    atomicWrite(store);
    return send(res, 201, { added, state: publicState(store) });
  }

  const wordMatch = url.pathname.match(/^\/api\/words\/([0-9a-f-]+)$/i);
  if (wordMatch && req.method === "PUT") {
    const body = await readBody(req);
    const index = store.words.findIndex(word => word.id === wordMatch[1]);
    if (index < 0) return send(res, 404, { error: "没有找到该词条" });
    store.words[index] = { ...store.words[index], ...normalizeWord(body), updatedAt: new Date().toISOString() };
    atomicWrite(store);
    return send(res, 200, { word: store.words[index], state: publicState(store) });
  }

  if (wordMatch && req.method === "DELETE") {
    const index = store.words.findIndex(word => word.id === wordMatch[1]);
    if (index < 0) return send(res, 404, { error: "没有找到该词条" });
    store.words.splice(index, 1);
    store.reviews = store.reviews.filter(record => record.wordId !== wordMatch[1]);
    atomicWrite(store);
    return send(res, 200, { state: publicState(store) });
  }

  if (wordMatch && req.method === "POST" && url.searchParams.get("action") === "reset") {
    const word = store.words.find(item => item.id === wordMatch[1]);
    if (!word) return send(res, 404, { error: "没有找到该词条" });
    Object.assign(word, { status: "new", reviewStep: -1, nextDueDate: null, failureCount: 0, updatedAt: new Date().toISOString() });
    atomicWrite(store);
    return send(res, 200, { state: publicState(store) });
  }

  if (req.method === "POST" && url.pathname === "/api/attempts") {
    const body = await readBody(req);
    const word = store.words.find(item => item.id === cleanText(body.wordId, 80));
    if (!word) return send(res, 404, { error: "没有找到该词条" });
    const correct = body.correct === true;
    const completedRound = body.completedRound === true;
    const before = word.reviewStep;
    if (!correct) {
      word.failureCount += 1;
      word.status = "learning";
      word.reviewStep = -1;
      word.nextDueDate = null;
    } else if (completedRound) {
      word.reviewStep = Math.min(word.reviewStep + 1, REVIEW_DELAYS.length - 1);
      if (word.reviewStep >= REVIEW_DELAYS.length - 1) {
        word.status = "mastered";
        word.nextDueDate = null;
      } else {
        word.status = "review";
        word.nextDueDate = addDays(REVIEW_DELAYS[word.reviewStep]);
      }
    }
    word.updatedAt = new Date().toISOString();
    store.reviews.push({
      id: crypto.randomUUID(), wordId: word.id, sessionId: cleanText(body.sessionId, 80),
      mode: body.mode === "spelling" ? "spelling" : "familiarize", answer: cleanText(body.answer, 150),
      correct, completedRound, reviewedAt: new Date().toISOString(), stepBefore: before, stepAfter: word.reviewStep
    });
    if (store.reviews.length > 10000) store.reviews = store.reviews.slice(-10000);
    atomicWrite(store);
    return send(res, 200, { word, state: publicState(store) });
  }

  if (req.method === "GET" && url.pathname === "/api/backup") {
    const filename = `英语单词学习备份-${dateKey()}.json`;
    return send(res, 200, JSON.stringify(store, null, 2), {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    });
  }

  if (req.method === "POST" && url.pathname === "/api/restore") {
    const body = await readBody(req);
    if (!body || body.version !== 1 || !Array.isArray(body.words) || !Array.isArray(body.reviews)) throw new Error("备份文件结构无效");
    for (const word of body.words) normalizeWord(word);
    backupStore(store);
    atomicWrite({ version: 1, words: body.words, reviews: body.reviews, settings: body.settings || { dailyNewLimit: 10 } });
    return send(res, 200, { state: publicState(readStore()) });
  }

  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    send(res, 200, { ok: true });
    setTimeout(() => server.close(() => process.exit(0)), 150);
    return;
  }

  return send(res, 404, { error: "接口不存在" });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const resolved = path.resolve(PUBLIC_DIR, requested);
  if (!resolved.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, "index.html")) {
    return send(res, 403, { error: "禁止访问" });
  }
  let target = resolved;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(PUBLIC_DIR, "index.html");
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval' blob: data:; worker-src 'self' blob: data:; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'"
  });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) send(res, 400, { error: error.message || "操作失败" });
  }
});

function openBrowser(url) {
  const command = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

function listen(port) {
  server.once("error", error => {
    if (error.code === "EADDRINUSE" && port < PORT_START + 20) return listen(port + 1);
    console.error(`无法启动：${error.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    ensureData();
    const url = `http://127.0.0.1:${port}`;
    console.log(`英语背单词工具已启动：${url}`);
    console.log("请保留此窗口；在网页中点击“退出工具”可安全关闭。\n");
    if (process.argv.includes("--open")) openBrowser(url);
  });
}

listen(PORT_START);

module.exports = { normalizeWord, dateKey, REVIEW_DELAYS };
