"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const app = {
  state: null,
  candidates: [],
  study: null,
  currentView: "home",
  ocrReady: false,
  retryFile: null,
  retryRotation: 0,
  retryObjectUrl: null,
  toastTimer: null
};

const statusLabels = { new: "未学习", learning: "学习中", review: "复习中", mastered: "已掌握" };

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "操作失败，请稍后重试");
  return data;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

function confirmAction(title, message, confirmText = "确认") {
  return new Promise(resolve => {
    $("#modal-title").textContent = title;
    $("#modal-message").textContent = message;
    $("#modal-confirm").textContent = confirmText;
    $("#confirm-modal").classList.remove("hidden");
    const finish = value => {
      $("#confirm-modal").classList.add("hidden");
      $("#modal-confirm").onclick = null;
      $("#modal-cancel").onclick = null;
      resolve(value);
    };
    $("#modal-confirm").onclick = () => finish(true);
    $("#modal-cancel").onclick = () => finish(false);
  });
}

function go(view) {
  app.currentView = view;
  $$(".view").forEach(node => node.classList.toggle("active", node.id === `view-${view}`));
  $$(".nav-item").forEach(node => node.classList.toggle("active", node.dataset.view === view));
  $(".sidebar").classList.remove("open");
  if (view === "home") renderHome();
  if (view === "library") renderLibrary();
  window.scrollTo(0, 0);
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getDailyWords() {
  if (!app.state) return { due: [], fresh: [] };
  const today = app.state.today || localDateKey();
  const due = app.state.words.filter(word => word.status === "learning" || (word.status === "review" && word.nextDueDate <= today));
  const fresh = app.state.words.filter(word => word.status === "new").slice(0, app.state.settings.dailyNewLimit || 10);
  return { due, fresh };
}

function computeStreak() {
  const days = new Set(app.state.reviews.filter(item => item.mode === "spelling" && item.correct).map(item => item.reviewedAt.slice(0, 10)));
  let count = 0;
  const cursor = new Date();
  if (!days.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(localDateKey(cursor))) { count += 1; cursor.setDate(cursor.getDate() - 1); }
  return count;
}

function renderHome() {
  if (!app.state) return;
  const { due, fresh } = getDailyWords();
  const date = new Date();
  $("#today-label").textContent = `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${["星期日","星期一","星期二","星期三","星期四","星期五","星期六"][date.getDay()]}`;
  $("#due-count").textContent = due.length;
  $("#new-count").textContent = fresh.length;
  $("#mastered-count").textContent = app.state.words.filter(word => word.status === "mastered").length;
  $("#streak-count").textContent = computeStreak();
  const total = due.length + fresh.length;
  $("#plan-summary").textContent = total ? `今天有 ${due.length} 个到期复习和 ${fresh.length} 个新单词，预计需要 ${Math.max(3, Math.ceil(total * 0.7))} 分钟。` : app.state.words.length ? "今天的计划已经完成，可以去词库里自由复习。" : "词库还是空的，先添加一些单词吧。";
  $("#start-study").disabled = total === 0;
  $("#start-study").textContent = total ? "开始学习 →" : "今日已完成";
  const trouble = [...app.state.words].filter(word => word.failureCount > 0).sort((a, b) => b.failureCount - a.failureCount).slice(0, 4);
  $("#trouble-list").classList.toggle("empty-state", !trouble.length);
  $("#trouble-list").innerHTML = trouble.length ? trouble.map(word => `<div class="mini-word"><strong>${escapeHtml(word.spelling)}</strong><span>${escapeHtml(word.meaning)} · 错 ${word.failureCount} 次</span></div>`).join("") : "还没有错词记录";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function normalizeAnswer(value) {
  return value.trim().toLocaleLowerCase("en-US");
}

function speak(text) {
  if (!("speechSynthesis" in window)) return toast("当前浏览器不支持系统发音");
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.82;
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find(voice => /^en[-_](US|GB)/i.test(voice.lang) && /Samantha|Daniel|Karen|Google/i.test(voice.name)) || voices.find(voice => /^en/i.test(voice.lang)) || null;
  speechSynthesis.speak(utterance);
}

function renderCandidates() {
  const body = $("#candidate-body");
  const labels = { clear: "清晰", check: "建议检查", missing: "缺少释义", manual: "手工录入" };
  body.innerHTML = app.candidates.map((item, index) => {
    const warning = item.warning || (item.meaning ? "clear" : "missing");
    return `<tr data-index="${index}"><td>${index + 1}</td><td><input class="candidate-spelling" value="${escapeHtml(item.spelling)}" aria-label="第 ${index + 1} 行英文"></td><td><input class="candidate-meaning" value="${escapeHtml(item.meaning)}" aria-label="第 ${index + 1} 行中文释义"></td><td><span class="ocr-badge ${warning}">${labels[warning] || "建议检查"}</span></td><td><button class="row-delete" aria-label="删除第 ${index + 1} 行">×</button></td></tr>`;
  }).join("");
  $("#candidate-count").textContent = `${app.candidates.length} 个词条`;
  $("#candidate-panel").classList.toggle("hidden", !app.candidates.length);
}

function syncCandidateInputs() {
  $$("#candidate-body tr").forEach(row => {
    const index = Number(row.dataset.index);
    app.candidates[index] = {
      ...app.candidates[index],
      spelling: row.querySelector(".candidate-spelling").value,
      meaning: row.querySelector(".candidate-meaning").value
    };
  });
}

function updateOcrProgress(status, value) {
  $("#ocr-status").textContent = status;
  $("#ocr-progress-bar").style.width = `${Math.max(0, Math.min(100, value))}%`;
}

async function ensureOCREngine() {
  if (!window.PaddleOCRRuntime || !window.OcrParser) throw new Error("本地 OCR 程序没有正确加载");
  if (!app.ocrReady) {
    updateOcrProgress("正在加载本地模型……", 12);
    await window.PaddleOCRRuntime.initialize();
    app.ocrReady = true;
  }
}

async function createRotatedCanvas(file, rotation) {
  const normalized = ((rotation % 360) + 360) % 360;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  const swap = normalized === 90 || normalized === 270;
  canvas.width = swap ? bitmap.height : bitmap.width;
  canvas.height = swap ? bitmap.width : bitmap.height;
  const context = canvas.getContext("2d");
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(normalized * Math.PI / 180);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();
  return canvas;
}

function clearRetry() {
  if (app.retryObjectUrl) URL.revokeObjectURL(app.retryObjectUrl);
  app.retryObjectUrl = null;
  app.retryFile = null;
  app.retryRotation = 0;
  $("#ocr-retry").classList.add("hidden");
  $("#ocr-retry-preview").removeAttribute("src");
  $("#ocr-retry-preview").style.transform = "";
}

function showRetry(file, rotation = 0) {
  clearRetry();
  app.retryFile = file;
  app.retryRotation = rotation;
  app.retryObjectUrl = URL.createObjectURL(file);
  $("#ocr-retry-preview").src = app.retryObjectUrl;
  $("#ocr-retry-preview").style.transform = `rotate(${rotation}deg)`;
  $("#ocr-retry").classList.remove("hidden");
}

function releaseCanvas(input) {
  if (input instanceof HTMLCanvasElement) {
    input.width = 1;
    input.height = 1;
  }
}

async function recognizeImage(file, sourceImageIndex, forcedRotation = 0) {
  const firstInput = forcedRotation ? await createRotatedCanvas(file, forcedRotation) : file;
  let firstParsed;
  try {
    const firstResult = await window.PaddleOCRRuntime.recognize(firstInput);
    firstParsed = window.OcrParser.parse(firstResult.items, firstResult.image, sourceImageIndex);
  } finally {
    releaseCanvas(firstInput);
  }

  if (forcedRotation || !firstParsed.rotation) {
    return { parsed: firstParsed, suggestedRotation: forcedRotation || firstParsed.rotation || 0 };
  }

  updateOcrProgress("检测到横置页面，正在自动转正并复核……", 72);
  const rotatedInput = await createRotatedCanvas(file, firstParsed.rotation);
  try {
    const rotatedResult = await window.PaddleOCRRuntime.recognize(rotatedInput);
    const rotatedParsed = window.OcrParser.parse(rotatedResult.items, rotatedResult.image, sourceImageIndex);
    const parsed = window.OcrParser.compareQuality(rotatedParsed, firstParsed) > 0 ? rotatedParsed : firstParsed;
    return { parsed, suggestedRotation: firstParsed.rotation };
  } catch (error) {
    console.warn("Automatic OCR rotation retry failed", error);
    return { parsed: firstParsed, suggestedRotation: firstParsed.rotation };
  } finally {
    releaseCanvas(rotatedInput);
  }
}

async function recognizeFiles(files, forcedRotation = 0) {
  const supported = [...files].filter(file => /image\/(jpeg|png)/.test(file.type));
  if (!supported.length) return toast("请选择 JPG、JPEG 或 PNG 照片");
  $("#drop-zone").classList.add("hidden");
  $("#ocr-progress").classList.remove("hidden");
  updateOcrProgress("正在加载本地模型……", 5);
  const all = forcedRotation ? [...app.candidates] : [];
  let retry = null;
  try {
    await ensureOCREngine();
    for (let i = 0; i < supported.length; i += 1) {
      updateOcrProgress(`正在检测第 ${i + 1} / ${supported.length} 张照片的文字……`, 28 + i / supported.length * 35);
      const recognized = await recognizeImage(supported[i], i, forcedRotation);
      const parsed = recognized.parsed;
      updateOcrProgress(`正在整理第 ${i + 1} / ${supported.length} 张照片的中英文……`, 78 + i / supported.length * 12);
      if (parsed.needsRetry && !retry) retry = { file: supported[i], rotation: recognized.suggestedRotation };
      else all.push(...parsed.candidates);
    }
    updateOcrProgress("正在整理词表……", 94);
    app.candidates = all;
    renderCandidates();
    if (retry) {
      showRetry(retry.file, retry.rotation);
      toast(all.length ? "部分照片需要旋转后重试" : "请调整照片方向后重新识别");
    } else if (all.length) {
      clearRetry();
      toast(`识别完成，请校对 ${all.length} 个词条`);
    } else {
      throw new Error("没有识别到完整的“英文＋中文释义”，请旋转照片重试或使用手工录入");
    }
  } catch (error) {
    console.error("OCR failed", error);
    if (!retry) showRetry(supported[0], forcedRotation);
    toast(error.message || "照片识别失败");
  } finally {
    updateOcrProgress("正在整理词表……", 100);
    $("#ocr-progress").classList.add("hidden");
    $("#drop-zone").classList.remove("hidden");
    $("#image-input").value = "";
  }
}

function parseManual() {
  const rows = $("#manual-text").value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsed = rows.map(line => {
    const parts = line.split(/\t|[:：]/);
    return { spelling: (parts.shift() || "").trim(), meaning: parts.join("：").trim(), confidence: 1, warning: "manual", sourceImageIndex: -1 };
  }).filter(item => item.spelling || item.meaning);
  if (!parsed.length) return toast("请先输入单词和中文释义");
  app.candidates = parsed;
  renderCandidates();
}

async function importCandidates() {
  syncCandidateInputs();
  const words = app.candidates.map(item => ({ spelling: item.spelling.trim(), meaning: item.meaning.trim() })).filter(item => item.spelling || item.meaning);
  if (!words.length) return toast("没有可以保存的词条");
  try {
    const data = await request("/api/words/import", { method: "POST", body: JSON.stringify({ words }) });
    app.state = data.state;
    app.candidates = [];
    renderCandidates();
    $("#manual-text").value = "";
    toast(`已将 ${data.added.length} 个词条存入词库`);
    go("library");
  } catch (error) { toast(error.message); }
}

function renderLibrary() {
  if (!app.state) return;
  const query = $("#word-search").value.trim().toLocaleLowerCase();
  const filter = $("#status-filter").value;
  const words = app.state.words.filter(word => {
    const status = word.status === "learning" ? "review" : word.status;
    return (filter === "all" || status === filter) && (!query || word.spelling.toLocaleLowerCase().includes(query) || word.meaning.includes(query));
  });
  $("#library-body").innerHTML = words.map(word => `<tr data-id="${word.id}"><td class="word-cell"><strong>${escapeHtml(word.spelling)}</strong><button class="speak-row">♬ 播放发音</button></td><td>${escapeHtml(word.meaning)}</td><td><span class="status-pill ${word.status}">${statusLabels[word.status]}</span></td><td>${word.nextDueDate || "—"}</td><td>${word.failureCount}</td><td><button class="table-action edit-word">编辑</button> <button class="table-action reset-word">重学</button> <button class="table-action danger delete-word">删除</button></td></tr>`).join("");
  $("#library-empty").classList.toggle("hidden", words.length > 0);
}

async function editWord(id) {
  const word = app.state.words.find(item => item.id === id);
  if (!word) return;
  const spelling = prompt("修改英文：", word.spelling);
  if (spelling === null) return;
  const meaning = prompt("修改中文释义：", word.meaning);
  if (meaning === null) return;
  try {
    const data = await request(`/api/words/${id}`, { method: "PUT", body: JSON.stringify({ spelling, meaning }) });
    app.state = data.state; renderLibrary(); toast("词条已更新");
  } catch (error) { toast(error.message); }
}

async function resetWord(id) {
  if (!await confirmAction("重新学习这个词？", "该词会回到未学习状态，历史答题记录仍会保留。", "重新学习")) return;
  const data = await request(`/api/words/${id}?action=reset`, { method: "POST", body: "{}" });
  app.state = data.state; renderLibrary(); toast("已放回新词队列");
}

async function deleteWord(id) {
  const word = app.state.words.find(item => item.id === id);
  if (!await confirmAction("删除这个词？", `“${word.spelling}”及其学习记录将被永久删除。`, "删除")) return;
  const data = await request(`/api/words/${id}`, { method: "DELETE" });
  app.state = data.state; renderLibrary(); toast("词条已删除");
}

function startStudy() {
  const { due, fresh } = getDailyWords();
  const tasks = [...due, ...fresh];
  if (!tasks.length) return;
  app.study = {
    sessionId: crypto.randomUUID(),
    fresh,
    tasks,
    familiarIndex: 0,
    queue: tasks.map(word => word.id),
    completed: 0,
    total: tasks.length,
    failed: new Set(),
    streaks: new Map(),
    currentId: null,
    feedbackLocked: false,
    correctAttempts: 0,
    wrongAttempts: 0
  };
  go("study");
  if (fresh.length) showFamiliarize(); else beginSpelling();
}

function updateStudyProgress(label, current, total) {
  $("#study-phase").textContent = label;
  $("#study-counter").textContent = `${Math.min(current, total)} / ${total}`;
  $("#study-progress-bar").style.width = `${total ? Math.min(100, (current / total) * 100) : 0}%`;
}

function showFamiliarize() {
  const study = app.study;
  const word = study.fresh[study.familiarIndex];
  $("#study-card").classList.remove("hidden");
  $("#study-complete").classList.add("hidden");
  $("#familiarize-card").classList.remove("hidden");
  $("#spelling-card").classList.add("hidden");
  study.currentId = word.id;
  $("#familiar-word").textContent = word.spelling;
  $("#familiar-meaning").textContent = word.meaning;
  updateStudyProgress("认读新词", study.familiarIndex + 1, study.fresh.length);
  setTimeout(() => speak(word.spelling), 180);
}

function beginSpelling() {
  $("#familiarize-card").classList.add("hidden");
  $("#spelling-card").classList.remove("hidden");
  showNextSpelling();
}

function currentWord() {
  return app.state.words.find(word => word.id === app.study.currentId);
}

function showNextSpelling() {
  const study = app.study;
  if (!study.queue.length) return finishStudy();
  study.currentId = study.queue.shift();
  study.feedbackLocked = false;
  const word = currentWord();
  $("#spell-meaning").textContent = word.meaning;
  $("#spelling-input").value = "";
  $("#spelling-input").disabled = false;
  $("#answer-feedback").className = "answer-feedback hidden";
  $("#submit-spelling").textContent = "提交答案";
  updateStudyProgress("拼写练习", study.completed + 1, study.total);
  $("#spelling-input").focus();
  speak(word.spelling);
}

function requeueLater(wordId) {
  const queue = app.study.queue;
  const position = Math.min(3, queue.length);
  queue.splice(position, 0, wordId);
}

async function submitSpelling(event) {
  event.preventDefault();
  const study = app.study;
  if (study.feedbackLocked) return showNextSpelling();
  const word = currentWord();
  const answer = $("#spelling-input").value;
  if (!answer.trim()) return toast("请先输入英文拼写");
  const correct = normalizeAnswer(answer) === normalizeAnswer(word.spelling);
  let completedRound = false;
  if (!correct) {
    study.failed.add(word.id);
    study.streaks.set(word.id, 0);
    study.wrongAttempts += 1;
    requeueLater(word.id);
  } else if (study.failed.has(word.id)) {
    const streak = (study.streaks.get(word.id) || 0) + 1;
    study.streaks.set(word.id, streak);
    study.correctAttempts += 1;
    if (streak >= 2) { completedRound = true; study.completed += 1; }
    else requeueLater(word.id);
  } else {
    completedRound = true;
    study.correctAttempts += 1;
    study.completed += 1;
  }
  try {
    const data = await request("/api/attempts", { method: "POST", body: JSON.stringify({ wordId: word.id, sessionId: study.sessionId, mode: "spelling", answer, correct, completedRound }) });
    app.state = data.state;
  } catch (error) {
    if (!correct || !completedRound) study.queue.unshift(word.id);
    return toast(error.message);
  }
  study.feedbackLocked = true;
  $("#spelling-input").disabled = true;
  const feedback = $("#answer-feedback");
  feedback.classList.remove("hidden", "wrong");
  if (correct) {
    const streak = study.streaks.get(word.id) || 0;
    feedback.innerHTML = study.failed.has(word.id) && streak < 2 ? `答对了！还需要再答对 <strong>1 次</strong>` : "答对了，很棒！";
  } else {
    feedback.classList.add("wrong");
    feedback.innerHTML = `这次没拼对，正确答案是 <strong>${escapeHtml(word.spelling)}</strong>`;
  }
  $("#submit-spelling").textContent = study.queue.length ? "继续 →" : "查看结果";
}

function finishStudy() {
  $("#study-card").classList.add("hidden");
  $("#study-complete").classList.remove("hidden");
  $("#complete-summary").textContent = `完成 ${app.study.total} 个单词，答对 ${app.study.correctAttempts} 次，纠正 ${app.study.wrongAttempts} 次。明天记得回来复习。`;
  updateStudyProgress("今日完成", app.study.total, app.study.total);
}

async function restoreBackup(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!await confirmAction("恢复这份备份？", "当前词库和进度会被替换，系统将自动保留一份恢复前数据。", "恢复")) return;
    const data = await request("/api/restore", { method: "POST", body: JSON.stringify(parsed) });
    app.state = data.state; toast("备份恢复成功"); go("home");
  } catch (error) { toast(error.message || "备份文件无法读取"); }
}

function bindEvents() {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => go(button.dataset.view)));
  $$('[data-go]').forEach(button => button.addEventListener("click", () => go(button.dataset.go)));
  $("#mobile-menu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#start-study").addEventListener("click", startStudy);
  $("#library-add").addEventListener("click", () => go("import"));
  $$(".tab").forEach(tab => tab.addEventListener("click", () => {
    $$(".tab").forEach(node => node.classList.toggle("active", node === tab));
    $$(".import-mode").forEach(node => node.classList.toggle("active", node.id === `${tab.dataset.importMode}-import`));
  }));
  const drop = $("#drop-zone");
  drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", event => { event.preventDefault(); drop.classList.remove("dragging"); recognizeFiles(event.dataTransfer.files); });
  $("#image-input").addEventListener("change", event => recognizeFiles(event.target.files));
  $("#rotate-left").addEventListener("click", () => {
    app.retryRotation = (app.retryRotation + 270) % 360;
    $("#ocr-retry-preview").style.transform = `rotate(${app.retryRotation}deg)`;
  });
  $("#rotate-right").addEventListener("click", () => {
    app.retryRotation = (app.retryRotation + 90) % 360;
    $("#ocr-retry-preview").style.transform = `rotate(${app.retryRotation}deg)`;
  });
  $("#retry-ocr").addEventListener("click", () => {
    if (app.retryFile) recognizeFiles([app.retryFile], app.retryRotation);
  });
  $("#parse-manual").addEventListener("click", parseManual);
  $("#add-row").addEventListener("click", () => { syncCandidateInputs(); app.candidates.push({ spelling: "", meaning: "", confidence: 1, warning: "manual", sourceImageIndex: -1 }); renderCandidates(); });
  $("#candidate-body").addEventListener("click", event => {
    const button = event.target.closest(".row-delete");
    if (!button) return;
    syncCandidateInputs(); app.candidates.splice(Number(button.closest("tr").dataset.index), 1); renderCandidates();
  });
  $("#confirm-import").addEventListener("click", importCandidates);
  $("#word-search").addEventListener("input", renderLibrary);
  $("#status-filter").addEventListener("change", renderLibrary);
  $("#library-body").addEventListener("click", event => {
    const row = event.target.closest("tr"); if (!row) return;
    const word = app.state.words.find(item => item.id === row.dataset.id);
    if (event.target.closest(".speak-row")) speak(word.spelling);
    if (event.target.closest(".edit-word")) editWord(word.id);
    if (event.target.closest(".reset-word")) resetWord(word.id);
    if (event.target.closest(".delete-word")) deleteWord(word.id);
  });
  $$('[data-speak-current]').forEach(button => button.addEventListener("click", () => { const word = currentWord(); if (word) speak(word.spelling); }));
  $("#next-familiar").addEventListener("click", () => { app.study.familiarIndex += 1; if (app.study.familiarIndex < app.study.fresh.length) showFamiliarize(); else beginSpelling(); });
  $("#spelling-card").addEventListener("submit", submitSpelling);
  $("#leave-study").addEventListener("click", async () => { if (await confirmAction("暂时退出学习？", "已经提交的答题结果会保留，未完成的单词下次会重新安排。", "退出")) go("home"); });
  $("#back-home").addEventListener("click", () => go("home"));
  $("#restore-input").addEventListener("change", event => { if (event.target.files[0]) restoreBackup(event.target.files[0]); event.target.value = ""; });
  $("#shutdown").addEventListener("click", async () => {
    if (!await confirmAction("安全退出工具？", "本地服务会停止。下次使用时重新双击启动文件即可。", "安全退出")) return;
    await request("/api/shutdown", { method: "POST", body: "{}" });
    document.body.innerHTML = '<main style="max-width:600px;margin:18vh auto;padding:30px;text-align:center"><h1>数据已保存</h1><p style="color:#738078">工具已安全退出，现在可以关闭这个页面。</p></main>';
  });
}

async function init() {
  bindEvents();
  try {
    app.state = await request("/api/state");
    renderHome(); renderLibrary();
  } catch (error) {
    toast(`无法读取本地数据：${error.message}`);
  }
}

init();
