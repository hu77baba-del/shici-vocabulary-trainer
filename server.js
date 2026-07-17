"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { exec } = require("node:child_process");
const {
  LEVELS, BADGES, normalizeAchievement, migrateGrowth, achievementSummary,
  levelFor, addReward, evaluateBadges, uniq
} = require("./lib/growth");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, "data", "app-data.json");
const DATA_DIR = path.dirname(DATA_FILE);
const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(DATA_DIR, "backups");
const PORT_START = Number(process.env.PORT) || 4173;
const MAX_BODY = 12 * 1024 * 1024;
const REVIEW_DELAYS = [1, 3, 7, 14, 30];
const PART_OF_SPEECH_ALIASES = new Map([
  ["n", "n."], ["n.", "n."], ["noun", "n."],
  ["v", "v."], ["v.", "v."], ["verb", "v."],
  ["vt", "vt."], ["vt.", "vt."], ["vi", "vi."], ["vi.", "vi."],
  ["adj", "adj."], ["adj.", "adj."], ["a", "adj."], ["a.", "adj."], ["adjective", "adj."],
  ["adv", "adv."], ["adv.", "adv."], ["adverb", "adv."],
  ["prep", "prep."], ["prep.", "prep."], ["preposition", "prep."],
  ["pron", "pron."], ["pron.", "pron."], ["pronoun", "pron."],
  ["conj", "conj."], ["conj.", "conj."], ["conjunction", "conj."],
  ["num", "num."], ["num.", "num."], ["numeral", "num."],
  ["art", "art."], ["art.", "art."], ["article", "art."],
  ["interj", "interj."], ["interj.", "interj."], ["interjection", "interj."],
  ["aux", "aux."], ["aux.", "aux."], ["auxiliary", "aux."],
  ["modal", "modal v."], ["modal v", "modal v."], ["modal v.", "modal v."]
]);

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
  return { version: 1, words: [], reviews: [], settings: {}, achievement: null, studySessions: [], activeSession: null };
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
  parsed.settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
  parsed.words = parsed.words.map(word => ({ ...word, ...normalizeWord(word) }));
  parsed.studySessions = Array.isArray(parsed.studySessions) ? parsed.studySessions.slice(-500) : [];
  parsed.activeSession = parsed.activeSession && typeof parsed.activeSession === "object" ? parsed.activeSession : null;
  const needsMigration = !parsed.achievement?.initializedAt;
  if (needsMigration) {
    backupBeforeGrowth(parsed);
    migrateGrowth(parsed, new Date().toISOString(), value => dateKey(new Date(value)));
    atomicWrite(parsed);
  } else {
    parsed.achievement = normalizeAchievement(parsed.achievement);
  }
  expireActiveSession(parsed);
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

function addDaysFrom(date, days) {
  const value = new Date(date);
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return dateKey(value);
}

function cleanText(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function isPhraseSpelling(spelling) {
  return /\s/.test(String(spelling || "").trim());
}

function normalizePartOfSpeech(raw) {
  const value = cleanText(raw, 80)
    .toLocaleLowerCase("en-US")
    .replace(/[，；、|]+/g, "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "");
  if (!value) return { value: "", recognized: true };
  if (!/^[a-z.\-/\s]+$/i.test(value)) throw new Error(`词性格式不正确：${value}`);
  let recognized = true;
  const tokens = value.split("/").map(token => token.replace(/\s+/g, " ").trim()).filter(Boolean);
  const normalized = tokens.map(token => {
    const alias = PART_OF_SPEECH_ALIASES.get(token);
    if (!alias) recognized = false;
    return alias || token;
  });
  return { value: [...new Set(normalized)].join("/"), recognized };
}

function normalizeWord(raw) {
  const spelling = cleanText(raw.spelling, 120).replace(/\s*\/\s*/g, "/");
  const meaning = cleanText(raw.meaning, 300);
  if (!spelling || !meaning) throw new Error("英文和中文释义不能为空");
  if (!/^[A-Za-z][A-Za-z\s'’.\/-]*$/.test(spelling) || /(?:^|[^A-Za-z])\/|\/(?:[^A-Za-z]|$)/.test(spelling)) {
    throw new Error(`英文格式不正确：${spelling}`);
  }
  const phrase = isPhraseSpelling(spelling);
  const normalizedPartOfSpeech = phrase ? { value: "", recognized: true } : normalizePartOfSpeech(raw.partOfSpeech);
  return {
    spelling,
    meaning,
    partOfSpeech: normalizedPartOfSpeech.value,
    partOfSpeechNeedsReview: phrase ? false : (
      !normalizedPartOfSpeech.value || raw.partOfSpeechNeedsReview === true || !normalizedPartOfSpeech.recognized
    )
  };
}

function activeDailyPlan(store) {
  const plan = store.settings?.dailyNewPlan;
  if (!plan || plan.date !== dateKey() || !Array.isArray(plan.wordIds)) return null;
  const existingIds = new Set(store.words.map(word => word.id));
  const wordIds = [...new Set(plan.wordIds)].filter(id => existingIds.has(id));
  return { date: plan.date, count: wordIds.length, wordIds, started: plan.started === true };
}

function saveDailyPlan(store, count) {
  if (!Number.isInteger(count) || count < 0) throw new Error("每日新词数量必须是 0 或正整数");
  const current = activeDailyPlan(store) || { date: dateKey(), count: 0, wordIds: [], started: false };
  if (current.started && count < current.count) throw new Error("今天已经开始学习，只能增加新词数量");
  const assigned = new Set(current.wordIds);
  const available = store.words.filter(word => word.status === "new" && !assigned.has(word.id));
  const maximum = current.wordIds.length + available.length;
  if (count > maximum) throw new Error(`当前最多可以安排 ${maximum} 个新词`);
  const wordIds = count <= current.wordIds.length
    ? current.wordIds.slice(0, count)
    : [...current.wordIds, ...available.slice(0, count - current.wordIds.length).map(word => word.id)];
  const plan = { date: dateKey(), count: wordIds.length, wordIds, started: current.started };
  store.settings ||= {};
  store.settings.dailyNewPlan = plan;
  const progress = store.settings.dailyStudyProgress;
  if (progress?.date === plan.date && !progress.reportId) {
    const addedIds = wordIds.filter(id => !progress.taskIds.includes(id));
    progress.taskIds.push(...addedIds);
    progress.newIds.push(...addedIds);
    if (store.activeSession?.date === plan.date && store.activeSession.kind === "daily") {
      store.activeSession.taskIds.push(...addedIds);
      store.activeSession.newIds.push(...addedIds);
      store.activeSession.familiarizeQueue.push(...addedIds);
      store.activeSession.queue.push(...addedIds);
    }
  }
  return plan;
}

function removeWords(store, wordIds) {
  const ids = new Set(wordIds);
  store.words = store.words.filter(word => !ids.has(word.id));
  store.reviews = store.reviews.filter(record => !ids.has(record.wordId));
  const plan = activeDailyPlan(store);
  if (plan) store.settings.dailyNewPlan = plan;
  if (store.activeSession) {
    for (const key of ["taskIds", "newIds", "dueIds", "queue", "familiarizeQueue", "completedIds", "failedIds", "correctedIds", "continueIds"]) {
      if (Array.isArray(store.activeSession[key])) store.activeSession[key] = store.activeSession[key].filter(id => !ids.has(id));
    }
  }
  const progress = store.settings?.dailyStudyProgress;
  if (progress) {
    for (const key of ["taskIds", "newIds", "dueIds", "completedIds", "failedIds", "correctedIds"]) {
      if (Array.isArray(progress[key])) progress[key] = progress[key].filter(id => !ids.has(id));
    }
  }
}

function publicState(store) {
  const today = dateKey();
  const achievement = achievementSummary(store, today);
  const pendingReport = [...store.studySessions].reverse().find(item => !item.acknowledgedAt) || null;
  return {
    version: store.version,
    words: store.words,
    reviews: store.reviews.slice(-2000),
    settings: store.settings,
    today,
    reviewDelays: REVIEW_DELAYS,
    achievement,
    activeSession: publicActiveSession(store),
    pendingReport,
    recentSessions: store.studySessions.slice(-10).reverse().map(sessionSummary),
    sessionTotal: store.studySessions.length
  };
}

function publicActiveSession(store) {
  const session = store.activeSession;
  if (!session) return null;
  return {
    id: session.id, date: session.date, source: session.source, mode: session.mode, kind: session.kind,
    taskIds: session.taskIds, newIds: session.newIds, dueIds: session.dueIds,
    queue: session.queue, familiarizeQueue: session.familiarizeQueue,
    completed: session.completedIds.length, total: session.taskIds.length,
    failedIds: session.failedIds, correctedIds: session.correctedIds, continueIds: session.continueIds,
    currentWordId: session.familiarizeQueue[0] || session.queue[0] || null
  };
}

function sessionSummary(session) {
  return {
    id: session.id, date: session.date, completedAt: session.completedAt, source: session.source,
    mode: session.mode, title: session.title, totalWords: session.totalWords,
    newWords: session.newWords, dueWords: session.dueWords, practiceWords: session.practiceWords,
    starlightEarned: session.starlightEarned, acknowledgedAt: session.acknowledgedAt
  };
}

function backupBeforeGrowth(store) {
  if (!fs.existsSync(DATA_FILE)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `pre-v1.3.0-achievement-${stamp}.json`);
  fs.writeFileSync(target, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function expireActiveSession(store) {
  if (store.activeSession && store.activeSession.date !== dateKey()) {
    store.activeSession = null;
    if (store.settings?.dailyStudyProgress?.date !== dateKey()) delete store.settings.dailyStudyProgress;
    atomicWrite(store);
  }
}

function wordSnapshot(word) {
  return word ? { id: word.id, spelling: word.spelling, partOfSpeech: word.partOfSpeech || "", meaning: word.meaning } : null;
}

function normalizeAnswer(value) {
  return cleanText(value, 150).toLocaleLowerCase("en-US").replace(/[’]/g, "'").replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/").trim();
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

function dueWords(store) {
  const today = dateKey();
  return store.words.filter(word => word.status === "learning" || (word.status === "review" && word.nextDueDate && word.nextDueDate <= today));
}

function createStudySession(store, body) {
  expireActiveSession(store);
  if (store.activeSession) throw new Error("还有一场未完成学习，请先继续或结束原场次");
  const now = new Date().toISOString();
  const today = dateKey();
  const source = ["scheduled", "manual-free", "manual-formal"].includes(body.source) ? body.source : "scheduled";
  let mode = body.mode === "recognition" ? "recognition" : "spelling";
  let kind = source === "scheduled" ? "daily" : "manual";
  let tasks = [];
  let fresh = [];
  let due = [];

  if (source === "scheduled") {
    const plan = activeDailyPlan(store);
    fresh = (plan?.wordIds || []).map(id => store.words.find(word => word.id === id)).filter(word => word?.status === "new");
    due = dueWords(store);
    let progress = store.settings.dailyStudyProgress;
    if (!progress || progress.date !== today) {
      const taskIds = [...new Set([...due, ...fresh].map(word => word.id))];
      if (!taskIds.length) throw new Error("今天没有需要完成的学习任务");
      progress = {
        date: today, id: crypto.randomUUID(), taskIds, newIds: fresh.map(word => word.id), dueIds: due.map(word => word.id),
        completedIds: [], failedIds: [], correctedIds: [], rewardKeys: [], reportId: null, levelBefore: levelFor(store.achievement.starlight).level
      };
      store.settings.dailyStudyProgress = progress;
    } else if (!progress.reportId) {
      const additions = fresh.map(word => word.id).filter(id => !progress.taskIds.includes(id));
      progress.taskIds.push(...additions);
      progress.newIds.push(...additions);
    } else {
      const additionIds = fresh.map(word => word.id).filter(id => !progress.taskIds.includes(id));
      if (!additionIds.length) throw new Error("今天的计划已经完成");
      kind = "addition";
      tasks = additionIds.map(id => store.words.find(word => word.id === id)).filter(Boolean);
      fresh = tasks;
      due = [];
    }
    if (kind === "daily") {
      const progressNow = store.settings.dailyStudyProgress;
      tasks = progressNow.taskIds.filter(id => !progressNow.completedIds.includes(id)).map(id => store.words.find(word => word.id === id)).filter(Boolean);
      fresh = progressNow.newIds.map(id => store.words.find(word => word.id === id)).filter(Boolean);
      due = progressNow.dueIds.map(id => store.words.find(word => word.id === id)).filter(Boolean);
    }
    if (!tasks.length) throw new Error("今天的计划已经完成");
    if (plan) {
      plan.started = true;
      store.settings.dailyNewPlan = plan;
    }
  } else {
    const ids = [...new Set(Array.isArray(body.wordIds) ? body.wordIds.map(id => cleanText(id, 80)) : [])];
    tasks = ids.map(id => store.words.find(word => word.id === id)).filter(Boolean);
    if (!tasks.length || tasks.length !== ids.length) throw new Error("请选择有效的已学习词条");
    if (tasks.some(word => word.status === "new")) throw new Error("未学习的新词不能进入自主复习");
    if (source === "manual-formal") mode = "spelling";
    due = tasks.filter(word => word.status === "learning" || (word.status === "review" && word.nextDueDate && word.nextDueDate <= today));
  }

  const session = {
    id: crypto.randomUUID(), date: today, source, mode, kind, startedAt: now, updatedAt: now,
    taskIds: tasks.map(word => word.id), newIds: fresh.filter(word => tasks.some(item => item.id === word.id)).map(word => word.id),
    dueIds: due.filter(word => tasks.some(item => item.id === word.id)).map(word => word.id),
    queue: tasks.map(word => word.id),
    familiarizeQueue: source === "scheduled" ? fresh.filter(word => word.status === "new" && tasks.some(item => item.id === word.id)).map(word => word.id) : [],
    completedIds: [],
    failedIds: kind === "daily" ? uniq(store.settings.dailyStudyProgress?.failedIds) : [],
    correctedIds: [], continueIds: [], correctStreaks: {}, rewardKeys: [],
    levelBefore: levelFor(store.achievement.starlight).level
  };
  store.activeSession = session;
  return session;
}

function addSessionReward(store, session, reward) {
  const result = addReward(store, reward);
  if (result.added) {
    session.rewardKeys.push(result.reward.key);
    const progress = store.settings.dailyStudyProgress;
    if (session.kind === "daily" && progress?.date === session.date) progress.rewardKeys.push(result.reward.key);
  }
  return result;
}

function rewardDetails(store, keys) {
  const selected = new Set(keys || []);
  return store.achievement.rewardLedger.filter(item => selected.has(item.key));
}

function completeStudySession(store, session, nowIso) {
  const today = dateKey(new Date(nowIso));
  let taskIds = session.taskIds;
  let newIds = session.newIds;
  let dueIds = session.dueIds;
  let correctedIds = session.correctedIds;
  let keys = session.rewardKeys;
  let title = session.source === "manual-free" ? "自由练习完成" : session.source === "manual-formal" ? "正式复习完成" : "今日追加学习";

  if (session.kind === "daily") {
    const progress = store.settings.dailyStudyProgress;
    if (!progress || progress.date !== today || progress.taskIds.some(id => !progress.completedIds.includes(id))) return null;
    taskIds = progress.taskIds;
    newIds = progress.newIds;
    dueIds = progress.dueIds;
    correctedIds = progress.correctedIds;
    keys = progress.rewardKeys;
    title = "今日学习完成";
    const dailyReward = addReward(store, { key: `daily-complete:${today}`, points: 20, reason: "完整完成每日计划", createdAt: nowIso });
    if (dailyReward.added) keys.push(dailyReward.reward.key);
    if (dueIds.length) store.achievement.reviewPlanDates = uniq([...store.achievement.reviewPlanDates, today]);
  }

  store.achievement.studyDates = uniq([...store.achievement.studyDates, today]);
  const newBadges = evaluateBadges(store, nowIso);
  const details = rewardDetails(store, keys);
  const snapshots = ids => ids.map(id => wordSnapshot(store.words.find(word => word.id === id))).filter(Boolean);
  const nextReviewDate = store.words.map(word => word.nextDueDate).filter(Boolean).sort()[0] || null;
  const completedLevel = levelFor(store.achievement.starlight);
  const report = {
    id: session.kind === "daily" ? store.settings.dailyStudyProgress.id : session.id,
    date: today, source: session.source, mode: session.mode, kind: session.kind, title,
    startedAt: session.startedAt, completedAt: nowIso, acknowledgedAt: null,
    totalWords: taskIds.length, newWords: newIds.length, dueWords: dueIds.length,
    practiceWords: session.source === "scheduled" ? 0 : taskIds.length,
    correctedWords: snapshots(correctedIds), continueWords: snapshots(session.continueIds),
    nextReviewDate, rewardDetails: details, starlightEarned: details.reduce((sum, item) => sum + item.points, 0),
    levelBefore: session.kind === "daily" ? store.settings.dailyStudyProgress.levelBefore : session.levelBefore,
    levelAfter: completedLevel.level, levelSummary: completedLevel, starlightAfter: store.achievement.starlight,
    newBadgeIds: newBadges.map(item => item.id)
  };
  store.studySessions.push(report);
  if (store.studySessions.length > 500) store.studySessions = store.studySessions.slice(-500);
  if (session.kind === "daily") store.settings.dailyStudyProgress.reportId = report.id;
  store.activeSession = null;
  return report;
}

function processAuthoritativeAttempt(store, body) {
  const attemptId = cleanText(body.attemptId, 80);
  if (!attemptId) throw new Error("答题请求缺少唯一编号");
  const duplicate = store.reviews.find(item => item.attemptId === attemptId);
  if (duplicate) return { duplicate: true, report: [...store.studySessions].reverse().find(item => !item.acknowledgedAt) || null };
  const session = store.activeSession;
  if (!session || session.id !== cleanText(body.sessionId, 80)) throw new Error("学习场次已结束，请返回首页刷新");
  if (session.date !== dateKey()) {
    store.activeSession = null;
    throw new Error("昨天的未完成场次已经结束，请按今天的计划重新开始");
  }
  if (session.familiarizeQueue.length) throw new Error("请先完成新词认读");
  const wordId = cleanText(body.wordId, 80);
  if (session.queue[0] !== wordId) throw new Error("答题顺序已变化，请刷新后继续");
  const word = store.words.find(item => item.id === wordId);
  if (!word) throw new Error("当前词条已不存在");
  const nowIso = new Date().toISOString();
  const beforeStatus = word.status;
  const beforeStep = word.reviewStep;
  const recognition = session.mode === "recognition";
  const correct = recognition ? body.remembered === true : normalizeAnswer(body.answer) === normalizeAnswer(word.spelling);
  let completedRound = recognition;
  session.queue.shift();

  if (recognition) {
    if (!correct) {
      word.failureCount += 1;
      session.continueIds = uniq([...session.continueIds, word.id]);
    }
    session.completedIds = uniq([...session.completedIds, word.id]);
  } else if (!correct) {
    session.failedIds = uniq([...session.failedIds, word.id]);
    session.correctStreaks[word.id] = 0;
    const position = Math.min(3, session.queue.length);
    session.queue.splice(position, 0, word.id);
    word.failureCount += 1;
    if (session.source !== "manual-free") {
      word.status = "learning";
      word.reviewStep = -1;
      word.nextDueDate = null;
    }
  } else if (session.failedIds.includes(word.id)) {
    const streak = (session.correctStreaks[word.id] || 0) + 1;
    session.correctStreaks[word.id] = streak;
    if (streak >= 2) {
      completedRound = true;
      session.completedIds = uniq([...session.completedIds, word.id]);
      session.correctedIds = uniq([...session.correctedIds, word.id]);
    } else {
      const position = Math.min(3, session.queue.length);
      session.queue.splice(position, 0, word.id);
    }
  } else {
    completedRound = true;
    session.completedIds = uniq([...session.completedIds, word.id]);
  }

  if (!recognition && session.source !== "manual-free" && correct && completedRound) {
    word.reviewStep = Math.min(word.reviewStep + 1, REVIEW_DELAYS.length - 1);
    if (word.reviewStep >= REVIEW_DELAYS.length - 1) {
      word.status = "mastered";
      word.nextDueDate = null;
    } else {
      word.status = "review";
      word.nextDueDate = addDaysFrom(nowIso, REVIEW_DELAYS[word.reviewStep]);
    }
    if (word.status === "review" || word.status === "mastered") addSessionReward(store, session, {
      key: `word-learned:${word.id}`, points: 2, reason: "首次学完词条", wordId: word.id, createdAt: nowIso
    });
    if (word.status === "mastered") addSessionReward(store, session, {
      key: `word-mastered:${word.id}`, points: 5, reason: "首次掌握词条", wordId: word.id, createdAt: nowIso
    });
  }

  word.updatedAt = nowIso;
  const progress = store.settings.dailyStudyProgress;
  if (session.kind === "daily" && progress?.date === session.date) {
    if (session.failedIds.includes(word.id)) progress.failedIds = uniq([...(progress.failedIds || []), word.id]);
    if (completedRound) progress.completedIds = uniq([...progress.completedIds, word.id]);
    if (session.correctedIds.includes(word.id)) progress.correctedIds = uniq([...progress.correctedIds, word.id]);
  }
  const willComplete = session.queue.length === 0 && session.familiarizeQueue.length === 0 && (
    session.kind !== "daily" || !progress.taskIds.some(id => !progress.completedIds.includes(id))
  );
  store.reviews.push({
    id: crypto.randomUUID(), attemptId, wordId: word.id, sessionId: session.id, source: session.source,
    mode: session.mode, answer: recognition ? (correct ? "认识" : "还不认识") : cleanText(body.answer, 150),
    correct, completedRound, sessionCompleted: willComplete, reviewedAt: nowIso,
    statusBefore: beforeStatus, statusAfter: word.status, stepBefore: beforeStep, stepAfter: word.reviewStep
  });
  if (store.reviews.length > 10000) store.reviews = store.reviews.slice(-10000);
  session.updatedAt = nowIso;
  const report = willComplete ? completeStudySession(store, session, nowIso) : null;
  return { duplicate: false, report, correct, completedRound, word };
}

async function api(req, res, url) {
  const store = readStore();

  if (req.method === "GET" && url.pathname === "/api/state") {
    return send(res, 200, publicState(store));
  }

  if (req.method === "POST" && url.pathname === "/api/achievement/migration-notice/acknowledge") {
    if (store.achievement.migrationNotice) store.achievement.migrationNotice.acknowledgedAt = new Date().toISOString();
    atomicWrite(store);
    return send(res, 200, { state: publicState(store) });
  }

  if (req.method === "POST" && url.pathname === "/api/study-sessions") {
    const body = await readBody(req);
    const session = createStudySession(store, body);
    atomicWrite(store);
    return send(res, 201, { session: publicActiveSession(store), state: publicState(store) });
  }

  if (req.method === "GET" && url.pathname === "/api/study-sessions") {
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "10", 10) || 10));
    const newest = [...store.studySessions].reverse();
    return send(res, 200, { sessions: newest.slice(offset, offset + limit).map(sessionSummary), total: newest.length, nextOffset: offset + limit < newest.length ? offset + limit : null });
  }

  const studyMatch = url.pathname.match(/^\/api\/study-sessions\/([0-9a-f-]+)(?:\/(familiarize|abandon|acknowledge))?$/i);
  if (studyMatch && req.method === "GET" && !studyMatch[2]) {
    const report = store.studySessions.find(item => item.id === studyMatch[1]);
    if (!report) return send(res, 404, { error: "没有找到这份学习报告" });
    return send(res, 200, { report });
  }
  if (studyMatch && req.method === "POST" && studyMatch[2] === "familiarize") {
    const body = await readBody(req);
    const session = store.activeSession;
    if (!session || session.id !== studyMatch[1]) throw new Error("学习场次已结束");
    if (session.familiarizeQueue[0] !== cleanText(body.wordId, 80)) throw new Error("认读顺序已变化，请刷新后继续");
    session.familiarizeQueue.shift();
    session.updatedAt = new Date().toISOString();
    atomicWrite(store);
    return send(res, 200, { session: publicActiveSession(store), state: publicState(store) });
  }
  if (studyMatch && req.method === "POST" && studyMatch[2] === "abandon") {
    if (store.activeSession?.id !== studyMatch[1]) throw new Error("学习场次已经结束");
    store.activeSession = null;
    atomicWrite(store);
    return send(res, 200, { state: publicState(store) });
  }
  if (studyMatch && req.method === "POST" && studyMatch[2] === "acknowledge") {
    const report = store.studySessions.find(item => item.id === studyMatch[1]);
    if (!report) return send(res, 404, { error: "没有找到这份学习报告" });
    report.acknowledgedAt ||= new Date().toISOString();
    atomicWrite(store);
    return send(res, 200, { report, state: publicState(store) });
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/daily-new-plan") {
    const body = await readBody(req);
    const plan = saveDailyPlan(store, body.count);
    atomicWrite(store);
    return send(res, 200, { plan, state: publicState(store) });
  }

  if (req.method === "POST" && url.pathname === "/api/settings/daily-new-plan/start") {
    const plan = activeDailyPlan(store);
    if (!plan) throw new Error("请先选择今天的新词数量");
    plan.started = true;
    store.settings.dailyNewPlan = plan;
    atomicWrite(store);
    return send(res, 200, { plan, state: publicState(store) });
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

  if (req.method === "DELETE" && url.pathname === "/api/words") {
    const body = await readBody(req);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 5000) throw new Error("请选择 1 至 5000 个要删除的单词");
    if (body.ids.some(id => typeof id !== "string" || !/^[0-9a-f-]+$/i.test(id))) throw new Error("批量删除请求包含无效词条");
    const ids = [...new Set(body.ids)];
    const existingIds = new Set(store.words.map(word => word.id));
    if (ids.some(id => !existingIds.has(id))) throw new Error("部分词条已不存在，请刷新词库后重试");
    removeWords(store, ids);
    atomicWrite(store);
    return send(res, 200, { deletedCount: ids.length, deletedIds: ids, state: publicState(store) });
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
    removeWords(store, [wordMatch[1]]);
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
    if (body.attemptId) {
      const result = processAuthoritativeAttempt(store, body);
      atomicWrite(store);
      return send(res, 200, {
        duplicate: result.duplicate, correct: result.correct, completedRound: result.completedRound,
        word: result.word, completionReport: result.report, state: publicState(store)
      });
    }
    const word = store.words.find(item => item.id === cleanText(body.wordId, 80));
    if (!word) return send(res, 404, { error: "没有找到该词条" });
    const sources = new Set(["scheduled", "manual-free", "manual-formal"]);
    const source = sources.has(body.source) ? body.source : "scheduled";
    const mode = body.mode === "recognition" ? "recognition" : body.mode === "spelling" ? "spelling" : "familiarize";
    if (source.startsWith("manual-") && word.status === "new") throw new Error("未学习的新词不能进入自主复习");
    if (source === "manual-formal" && mode !== "spelling") throw new Error("正式复习只支持拼写练习");
    const correct = body.correct === true;
    const completedRound = body.completedRound === true;
    const before = word.reviewStep;
    if (source === "manual-free") {
      if (!correct) word.failureCount += 1;
    } else if (!correct) {
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
      source, mode, answer: cleanText(body.answer, 150), correct, completedRound,
      sessionCompleted: body.sessionCompleted === true, reviewedAt: new Date().toISOString(),
      stepBefore: before, stepAfter: word.reviewStep
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
    const words = body.words.map(word => ({ ...word, ...normalizeWord(word) }));
    backupStore(store);
    atomicWrite({
      version: 1, words, reviews: body.reviews,
      settings: body.settings && typeof body.settings === "object" ? body.settings : {},
      achievement: body.achievement && typeof body.achievement === "object" ? body.achievement : null,
      studySessions: Array.isArray(body.studySessions) ? body.studySessions : [],
      activeSession: body.activeSession && typeof body.activeSession === "object" ? body.activeSession : null
    });
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
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval' blob: data:; worker-src 'self' blob: data:; connect-src 'self' data:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'"
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
