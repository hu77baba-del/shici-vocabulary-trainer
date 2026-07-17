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
  toastTimer: null,
  streakAnimationTimer: null,
  lastRenderedStreak: null,
  librarySelection: new Set(),
  reviewSelection: new Set()
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
  if (view === "review") renderReviewPlanner();
  window.scrollTo(0, 0);
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getDailyWords() {
  if (!app.state) return { due: [], fresh: [], allNew: [], plan: null };
  const today = app.state.today || localDateKey();
  const due = app.state.words.filter(word => word.status === "learning" || (word.status === "review" && word.nextDueDate <= today));
  const allNew = app.state.words.filter(word => word.status === "new");
  const storedPlan = app.state.settings?.dailyNewPlan;
  const plan = storedPlan?.date === today && Array.isArray(storedPlan.wordIds) ? storedPlan : null;
  const fresh = plan
    ? plan.wordIds.map(id => app.state.words.find(word => word.id === id)).filter(word => word?.status === "new")
    : [];
  return { due, fresh, allNew, plan };
}

function computeStreak() {
  const days = new Set(app.state.reviews.filter(item => {
    if (item.source === "manual-free" || item.source === "manual-formal") return item.sessionCompleted === true;
    return item.mode === "spelling" && item.correct;
  }).map(item => item.reviewedAt.slice(0, 10)));
  let count = 0;
  const cursor = new Date();
  if (!days.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(localDateKey(cursor))) { count += 1; cursor.setDate(cursor.getDate() - 1); }
  return count;
}

function streakMessage(days) {
  if (days === 0) return "今天完成学习，点亮第一颗星";
  const milestoneMessages = new Map([
    [1, "第一颗星已点亮"],
    [3, "3 天小成就已解锁"],
    [7, "一周星光已点亮"],
    [14, "双周坚持已达成"],
    [30, "30 天习惯徽章已解锁"]
  ]);
  if (milestoneMessages.has(days)) return milestoneMessages.get(days);
  const nextMilestone = [3, 7, 14, 30].find(value => value > days);
  return nextMilestone ? `再坚持 ${nextMilestone - days} 天，点亮新星` : "每一天都在为星光加码";
}

function renderStreak() {
  const days = computeStreak();
  const badge = $("#streak-badge");
  const message = streakMessage(days);
  $("#streak-count").textContent = days;
  $("#streak-message").textContent = message;
  badge.classList.toggle("has-streak", days > 0);
  badge.setAttribute("aria-label", `已连续学习 ${days} 天。${message}`);
  if (app.lastRenderedStreak !== null && days > app.lastRenderedStreak) {
    badge.classList.remove("celebrate");
    void badge.offsetWidth;
    badge.classList.add("celebrate");
    clearTimeout(app.streakAnimationTimer);
    app.streakAnimationTimer = setTimeout(() => badge.classList.remove("celebrate"), 1250);
  }
  app.lastRenderedStreak = days;
}

function renderHome() {
  if (!app.state) return;
  const { due, fresh, allNew, plan } = getDailyWords();
  const date = new Date();
  $("#today-label").textContent = `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${["星期日","星期一","星期二","星期三","星期四","星期五","星期六"][date.getDay()]}`;
  $("#due-count").textContent = due.length;
  $("#new-count").textContent = allNew.length;
  $("#mastered-count").textContent = app.state.words.filter(word => word.status === "mastered").length;
  renderStreak();
  const total = due.length + fresh.length;
  const needsChoice = allNew.length > 0 && !plan;
  if (!app.state.words.length) {
    $("#plan-summary").textContent = "词库还是空的，先添加一些单词吧。";
  } else if (needsChoice) {
    $("#plan-summary").textContent = `今天有 ${due.length} 个到期复习。请先决定今天要学习几个新词，也可以选择 0。`;
  } else if (total) {
    $("#plan-summary").textContent = `今天有 ${due.length} 个到期复习和 ${fresh.length} 个计划新词，预计需要 ${Math.max(3, Math.ceil(total * 0.7))} 分钟。`;
  } else {
    $("#plan-summary").textContent = "今天的计划已经完成，可以去自主复习。";
  }
  const planControl = $("#daily-plan-control");
  planControl.classList.toggle("hidden", !allNew.length);
  if (!planControl.classList.contains("hidden")) {
    const assigned = new Set(plan?.wordIds || []);
    const maximum = (plan?.wordIds.length || 0) + allNew.filter(word => !assigned.has(word.id)).length;
    $("#daily-new-count").max = String(maximum);
    $("#daily-new-count").min = String(plan?.started ? plan.count : 0);
    if (document.activeElement !== $("#daily-new-count")) $("#daily-new-count").value = plan ? String(plan.count) : "";
    $("#daily-plan-hint").textContent = plan
      ? plan.started ? `今天已安排 ${plan.count} 个，开始学习后只能继续增加。` : `今天已安排 ${plan.count} 个，开始前还可以调整。`
      : `可选择 0 至 ${maximum} 个；当天会记住这次选择。`;
    $("#save-daily-plan").textContent = plan ? "更新数量" : "确认数量";
  }
  $("#start-study").disabled = needsChoice || total === 0;
  $("#start-study").textContent = needsChoice ? "先选择新词数量" : total ? "开始学习 →" : "今日已完成";
  const trouble = [...app.state.words].filter(word => word.failureCount > 0).sort((a, b) => b.failureCount - a.failureCount).slice(0, 4);
  $("#trouble-list").classList.toggle("empty-state", !trouble.length);
  $("#trouble-list").innerHTML = trouble.length ? trouble.map(word => `<div class="mini-word"><strong>${escapeHtml(word.spelling)}</strong><span>${escapeHtml(word.meaning)} · 错 ${word.failureCount} 次</span></div>`).join("") : "还没有错词记录";
}

async function saveDailyPlan() {
  const value = Number($("#daily-new-count").value);
  if (!Number.isInteger(value) || value < 0) return toast("请输入 0 或正整数");
  try {
    const data = await request("/api/settings/daily-new-plan", { method: "PUT", body: JSON.stringify({ count: value }) });
    app.state = data.state;
    renderHome();
    toast(`今天安排学习 ${value} 个新词`);
  } catch (error) { toast(error.message); }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function normalizeAnswer(value) {
  return value.trim().toLocaleLowerCase("en-US");
}

function isPhraseSpelling(spelling) {
  return /\s/.test(String(spelling || "").trim());
}

function isKnownPartOfSpeech(value) {
  return /^(?:(?:n|v|vt|vi|adj|adv|prep|pron|conj|num|art|interj|aux)\.?|modal\s+v\.)(?:\s*[\/，；、|]\s*(?:(?:n|v|vt|vi|adj|adv|prep|pron|conj|num|art|interj|aux)\.?|modal\s+v\.))*$/i.test(String(value || "").trim());
}

function formatPartOfSpeech(value) {
  return String(value || "").split("/").filter(Boolean).join(" / ");
}

function partOfSpeechHtml(word) {
  if (isPhraseSpelling(word.spelling)) return "";
  if (!word.partOfSpeech) return '<span class="pos-pill missing">词性待补充</span>';
  return `<span class="pos-pill${word.partOfSpeechNeedsReview ? " needs-review" : ""}">${escapeHtml(formatPartOfSpeech(word.partOfSpeech))}</span>`;
}

function renderStudyPartOfSpeech(selector, word) {
  const node = $(selector);
  const phrase = isPhraseSpelling(word.spelling);
  node.classList.toggle("hidden", phrase);
  node.classList.toggle("needs-review", !phrase && (!word.partOfSpeech || word.partOfSpeechNeedsReview));
  node.textContent = word.partOfSpeech ? formatPartOfSpeech(word.partOfSpeech) : "词性待补充";
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
  const labels = { clear: "清晰", check: "建议检查", missing: "缺少释义", "missing-pos": "缺少词性", manual: "手工录入" };
  body.innerHTML = app.candidates.map((item, index) => {
    const phrase = isPhraseSpelling(item.spelling);
    const warning = !item.meaning ? "missing" : !phrase && !item.partOfSpeech ? "missing-pos" : item.partOfSpeechNeedsReview ? "check" : item.warning || "clear";
    return `<tr data-index="${index}"><td>${index + 1}</td><td><input class="candidate-spelling" value="${escapeHtml(item.spelling)}" aria-label="第 ${index + 1} 行英文"></td><td><input class="candidate-pos" value="${escapeHtml(item.partOfSpeech || "")}" data-original="${escapeHtml(item.partOfSpeech || "")}" placeholder="${phrase ? "词组无需填写" : "如 n."}" aria-label="第 ${index + 1} 行词性"></td><td><input class="candidate-meaning" value="${escapeHtml(item.meaning)}" aria-label="第 ${index + 1} 行中文释义"></td><td><span class="ocr-badge ${warning}">${labels[warning] || "建议检查"}</span></td><td><button class="row-delete" aria-label="删除第 ${index + 1} 行">×</button></td></tr>`;
  }).join("");
  $("#candidate-count").textContent = `${app.candidates.length} 个词条`;
  $("#candidate-panel").classList.toggle("hidden", !app.candidates.length);
}

function syncCandidateInputs() {
  $$("#candidate-body tr").forEach(row => {
    const index = Number(row.dataset.index);
    const partOfSpeechInput = row.querySelector(".candidate-pos");
    const partOfSpeech = partOfSpeechInput.value.trim();
    const spelling = row.querySelector(".candidate-spelling").value;
    const phrase = isPhraseSpelling(spelling);
    const manuallyChanged = partOfSpeech !== partOfSpeechInput.dataset.original;
    app.candidates[index] = {
      ...app.candidates[index],
      spelling,
      partOfSpeech: phrase ? "" : partOfSpeech,
      partOfSpeechNeedsReview: phrase ? false : !partOfSpeech || !isKnownPartOfSpeech(partOfSpeech)
        || (!manuallyChanged && app.candidates[index].partOfSpeechNeedsReview === true),
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

function showRetry(file, rotation = 0, reason = "unmatched") {
  clearRetry();
  app.retryFile = file;
  app.retryRotation = rotation;
  app.retryObjectUrl = URL.createObjectURL(file);
  $("#ocr-retry-preview").src = app.retryObjectUrl;
  $("#ocr-retry-preview").style.transform = `rotate(${rotation}deg)`;
  const orientationLikely = reason === "orientation";
  $("#ocr-retry-title").textContent = orientationLikely ? "这张照片可能需要调整方向" : "暂时没有配对成功";
  $("#ocr-retry-message").textContent = orientationLikely
    ? "检测到页面方向可能不正，可以按建议旋转后重新识别；照片仍只在本机处理。"
    : "没有形成完整的“英文＋中文释义”。旋转不一定有效，也可以重新拍摄或使用手工录入。";
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
  let needsReview = false;
  try {
    await ensureOCREngine();
    for (let i = 0; i < supported.length; i += 1) {
      updateOcrProgress(`正在检测第 ${i + 1} / ${supported.length} 张照片的文字……`, 28 + i / supported.length * 35);
      const recognized = await recognizeImage(supported[i], i, forcedRotation);
      const parsed = recognized.parsed;
      updateOcrProgress(`正在整理第 ${i + 1} / ${supported.length} 张照片的中英文……`, 78 + i / supported.length * 12);
      if (parsed.needsRetry && !retry) {
        retry = { file: supported[i], rotation: recognized.suggestedRotation, reason: recognized.suggestedRotation ? "orientation" : "unmatched" };
      } else {
        all.push(...parsed.candidates);
        needsReview ||= parsed.needsReview === true;
      }
    }
    updateOcrProgress("正在整理词表……", 94);
    app.candidates = all;
    renderCandidates();
    if (retry) {
      showRetry(retry.file, retry.rotation, retry.reason);
      toast(all.length ? "部分照片没有形成可靠配对" : (retry.reason === "orientation" ? "可以按建议旋转后重新识别" : "没有形成可靠的中英配对"));
    } else if (all.length) {
      clearRetry();
      toast(needsReview ? `识别完成，${all.length} 个词条中有内容需要校对` : `识别完成，请校对 ${all.length} 个词条`);
    } else {
      throw new Error("没有识别到完整的“英文＋中文释义”，请重新拍摄或使用手工录入");
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
    const tabParts = line.split("\t").map(part => part.trim());
    if (tabParts.length >= 3) {
      const spelling = tabParts.shift() || "";
      const partOfSpeech = tabParts.shift() || "";
      return { spelling, partOfSpeech, partOfSpeechNeedsReview: !isPhraseSpelling(spelling) && !partOfSpeech, meaning: tabParts.join(" ").trim(), confidence: 1, warning: "manual", sourceImageIndex: -1 };
    }
    if (tabParts.length === 2) {
      return { spelling: tabParts[0], partOfSpeech: "", partOfSpeechNeedsReview: !isPhraseSpelling(tabParts[0]), meaning: tabParts[1], confidence: 1, warning: "manual", sourceImageIndex: -1 };
    }
    const parts = line.split(/[:：]/);
    const spelling = (parts.shift() || "").trim();
    return { spelling, partOfSpeech: "", partOfSpeechNeedsReview: !isPhraseSpelling(spelling), meaning: parts.join("：").trim(), confidence: 1, warning: "manual", sourceImageIndex: -1 };
  }).filter(item => item.spelling || item.meaning);
  if (!parsed.length) return toast("请先输入单词和中文释义");
  app.candidates = parsed;
  renderCandidates();
}

async function importCandidates() {
  syncCandidateInputs();
  const words = app.candidates.map(item => ({
    spelling: item.spelling.trim(), partOfSpeech: (item.partOfSpeech || "").trim(),
    partOfSpeechNeedsReview: item.partOfSpeechNeedsReview === true, meaning: item.meaning.trim()
  })).filter(item => item.spelling || item.meaning);
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

function filteredLibraryWords() {
  const query = $("#word-search").value.trim().toLocaleLowerCase();
  const filter = $("#status-filter").value;
  return app.state.words.filter(word => {
    const status = word.status === "learning" ? "review" : word.status;
    return (filter === "all" || status === filter) && (!query || word.spelling.toLocaleLowerCase().includes(query)
      || String(word.partOfSpeech || "").toLocaleLowerCase().includes(query) || word.meaning.includes(query));
  });
}

function renderLibrary() {
  if (!app.state) return;
  const words = filteredLibraryWords();
  const existingIds = new Set(app.state.words.map(word => word.id));
  app.librarySelection = new Set([...app.librarySelection].filter(id => existingIds.has(id)));
  $("#library-body").innerHTML = words.map(word => `<tr data-id="${word.id}" class="${app.librarySelection.has(word.id) ? "library-row-selected" : ""}"><td><input class="library-word-check" type="checkbox" aria-label="选择 ${escapeHtml(word.spelling)}" ${app.librarySelection.has(word.id) ? "checked" : ""}></td><td class="word-cell"><strong>${escapeHtml(word.spelling)}</strong><button class="speak-row">♬ 播放发音</button></td><td class="pos-cell">${partOfSpeechHtml(word)}</td><td>${escapeHtml(word.meaning)}</td><td><span class="status-pill ${word.status}">${statusLabels[word.status]}</span></td><td>${word.nextDueDate || "—"}</td><td>${word.failureCount}</td><td><button class="table-action edit-word">编辑</button> <button class="table-action reset-word">重学</button> <button class="table-action danger delete-word">删除</button></td></tr>`).join("");
  $("#library-empty").classList.toggle("hidden", words.length > 0);
  const selectAll = $("#library-select-all");
  selectAll.disabled = words.length === 0;
  selectAll.checked = words.length > 0 && words.every(word => app.librarySelection.has(word.id));
  selectAll.indeterminate = words.some(word => app.librarySelection.has(word.id)) && !words.every(word => app.librarySelection.has(word.id));
  $("#library-selection-count").textContent = `已选 ${app.librarySelection.size} 个`;
  $("#delete-selected-words").disabled = app.librarySelection.size === 0;
}

function learnedWords() {
  return app.state ? app.state.words.filter(word => word.status !== "new") : [];
}

function reviewPool(kind) {
  const words = learnedWords();
  if (kind === "trouble") return words.filter(word => word.failureCount > 0).sort((a, b) => b.failureCount - a.failureCount || a.spelling.localeCompare(b.spelling));
  if (kind === "mastered") return words.filter(word => word.status === "mastered");
  return words;
}

function shuffled(words) {
  const copy = [...words];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function syncReviewMode() {
  const formal = $("#review-kind").value === "manual-formal";
  if (formal) $("#review-activity").value = "spelling";
  $("#review-activity option[value='recognition']").disabled = formal;
  $("#review-kind-hint").textContent = formal
    ? "答题结果会推进或重置正式复习阶段。"
    : "答错会计入易错统计，但不会改变原来的复习计划。";
  $("#review-activity-hint").textContent = formal
    ? "正式复习使用拼写检测，答错词会在本轮自动回来。"
    : $("#review-activity").value === "recognition"
      ? "先看英文回想释义，再选择“认识”或“不认识”。"
      : "听发音、看中文完成拼写，答错词会在本轮自动回来。";
}

function filteredReviewWords() {
  const query = $("#review-search").value.trim().toLocaleLowerCase();
  const status = $("#review-status-filter").value;
  return learnedWords().filter(word => (status === "all" || word.status === status)
    && (!query || word.spelling.toLocaleLowerCase().includes(query)
      || String(word.partOfSpeech || "").toLocaleLowerCase().includes(query) || word.meaning.includes(query)));
}

function renderReviewWords() {
  const words = filteredReviewWords();
  const eligibleIds = new Set(learnedWords().map(word => word.id));
  app.reviewSelection = new Set([...app.reviewSelection].filter(id => eligibleIds.has(id)));
  $("#review-word-body").innerHTML = words.map(word => `<tr data-id="${word.id}"><td><input class="review-word-check" type="checkbox" aria-label="选择 ${escapeHtml(word.spelling)}" ${app.reviewSelection.has(word.id) ? "checked" : ""}></td><td class="word-cell"><strong>${escapeHtml(word.spelling)}</strong></td><td class="pos-cell">${partOfSpeechHtml(word)}</td><td>${escapeHtml(word.meaning)}</td><td><span class="status-pill ${word.status}">${statusLabels[word.status]}</span></td><td>${word.failureCount}</td></tr>`).join("");
  $("#review-empty").classList.toggle("hidden", words.length > 0);
  $("#review-select-all").checked = words.length > 0 && words.every(word => app.reviewSelection.has(word.id));
  $("#review-select-all").indeterminate = words.some(word => app.reviewSelection.has(word.id)) && !words.every(word => app.reviewSelection.has(word.id));
  $("#start-selected-review").disabled = app.reviewSelection.size === 0;
  $("#start-selected-review").textContent = `复习已选 ${app.reviewSelection.size} 个`;
}

function renderReviewAuto() {
  const kind = $("#review-pool").value;
  const pool = reviewPool(kind);
  $("#review-eligible-count").textContent = `${learnedWords().length} 个可复习`;
  $("#review-count").max = String(pool.length);
  $("#review-auto-hint").textContent = pool.length ? `当前范围共有 ${pool.length} 个单词，请输入 1 至 ${pool.length}。` : "当前范围还没有可复习的单词。";
  $("#start-auto-review").disabled = pool.length === 0;
}

function renderReviewPlanner() {
  if (!app.state) return;
  syncReviewMode();
  renderReviewAuto();
  renderReviewWords();
}

function startManualReview(words) {
  const eligible = words.filter(word => word?.status !== "new");
  if (!eligible.length) return toast("请选择至少一个已经学习过的单词");
  const source = $("#review-kind").value;
  const activity = source === "manual-formal" ? "spelling" : $("#review-activity").value;
  app.study = {
    sessionId: crypto.randomUUID(), source, activity, manual: true, fresh: [], tasks: eligible,
    familiarIndex: 0, recognitionIndex: 0, queue: eligible.map(word => word.id), completed: 0,
    total: eligible.length, failed: new Set(), streaks: new Map(), currentId: null,
    feedbackLocked: false, correctAttempts: 0, wrongAttempts: 0
  };
  go("study");
  if (activity === "recognition") showNextRecognition(); else beginSpelling();
}

function startAutoReview() {
  const pool = reviewPool($("#review-pool").value);
  const count = Number($("#review-count").value);
  if (!Number.isInteger(count) || count < 1 || count > pool.length) return toast(`请输入 1 至 ${pool.length} 的整数`);
  const words = $("#review-pool").value === "trouble" ? pool.slice(0, count) : shuffled(pool).slice(0, count);
  startManualReview(words);
}

function startSelectedReview() {
  const words = [...app.reviewSelection].map(id => app.state.words.find(word => word.id === id)).filter(Boolean);
  if (words.length) app.reviewSelection.clear();
  startManualReview(words);
}

async function editWord(id) {
  const word = app.state.words.find(item => item.id === id);
  if (!word) return;
  const spelling = prompt("修改英文：", word.spelling);
  if (spelling === null) return;
  const partOfSpeech = prompt("修改词性（词组可留空）：", word.partOfSpeech || "");
  if (partOfSpeech === null) return;
  const meaning = prompt("修改中文释义：", word.meaning);
  if (meaning === null) return;
  try {
    const data = await request(`/api/words/${id}`, { method: "PUT", body: JSON.stringify({ spelling, partOfSpeech, meaning }) });
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

async function deleteSelectedWords() {
  const ids = [...app.librarySelection];
  if (!ids.length) return;
  const selectedWords = ids.map(id => app.state.words.find(word => word.id === id)).filter(Boolean);
  const names = selectedWords.slice(0, 3).map(word => `“${word.spelling}”`).join("、");
  if (!await confirmAction(`批量删除 ${selectedWords.length} 个单词？`, `${names}${selectedWords.length > 3 ? "等" : ""}及其学习记录将被永久删除。此操作不能撤销。`, `删除 ${selectedWords.length} 个单词`)) return;
  try {
    const data = await request("/api/words", { method: "DELETE", body: JSON.stringify({ ids }) });
    app.state = data.state;
    app.librarySelection.clear();
    renderLibrary();
    toast(`已删除 ${data.deletedCount} 个单词`);
  } catch (error) { toast(error.message); }
}

async function startStudy() {
  let daily = getDailyWords();
  if (daily.allNew.length && !daily.plan) return toast("请先选择今天的新词数量");
  try {
    if (daily.plan && !daily.plan.started) {
      const data = await request("/api/settings/daily-new-plan/start", { method: "POST", body: "{}" });
      app.state = data.state;
      daily = getDailyWords();
    }
  } catch (error) { return toast(error.message); }
  const { due, fresh } = daily;
  const tasks = [...new Map([...due, ...fresh].map(word => [word.id, word])).values()];
  if (!tasks.length) return;
  app.study = {
    sessionId: crypto.randomUUID(), source: "scheduled", activity: "spelling", manual: false,
    fresh, tasks, familiarIndex: 0, recognitionIndex: 0, queue: tasks.map(word => word.id),
    completed: 0, total: tasks.length, failed: new Set(), streaks: new Map(), currentId: null,
    feedbackLocked: false, correctAttempts: 0, wrongAttempts: 0
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
  $("#recognition-card").classList.add("hidden");
  study.currentId = word.id;
  $("#familiar-word").textContent = word.spelling;
  renderStudyPartOfSpeech("#familiar-pos", word);
  $("#familiar-meaning").textContent = word.meaning;
  updateStudyProgress("认读新词", study.familiarIndex + 1, study.fresh.length);
  setTimeout(() => speak(word.spelling), 180);
}

function beginSpelling() {
  $("#study-card").classList.remove("hidden");
  $("#study-complete").classList.add("hidden");
  $("#familiarize-card").classList.add("hidden");
  $("#recognition-card").classList.add("hidden");
  $("#spelling-card").classList.remove("hidden");
  showNextSpelling();
}

function currentWord() {
  return app.state.words.find(word => word.id === app.study.currentId);
}

function showNextRecognition() {
  const study = app.study;
  if (study.recognitionIndex >= study.tasks.length) return finishStudy();
  const word = study.tasks[study.recognitionIndex];
  study.currentId = word.id;
  $("#study-card").classList.remove("hidden");
  $("#study-complete").classList.add("hidden");
  $("#familiarize-card").classList.add("hidden");
  $("#spelling-card").classList.add("hidden");
  $("#recognition-card").classList.remove("hidden");
  $("#recognition-word").textContent = word.spelling;
  renderStudyPartOfSpeech("#recognition-pos", word);
  $("#recognition-meaning").textContent = word.meaning;
  $("#recognition-answer").classList.add("hidden");
  $("#reveal-recognition").classList.remove("hidden");
  updateStudyProgress("自主认读", study.recognitionIndex + 1, study.total);
  setTimeout(() => speak(word.spelling), 180);
}

async function gradeRecognition(correct) {
  const study = app.study;
  const word = currentWord();
  const sessionCompleted = study.recognitionIndex === study.tasks.length - 1;
  try {
    const data = await request("/api/attempts", {
      method: "POST",
      body: JSON.stringify({
        wordId: word.id, sessionId: study.sessionId, source: "manual-free", mode: "recognition",
        answer: correct ? "认识" : "不认识", correct, completedRound: true, sessionCompleted
      })
    });
    app.state = data.state;
  } catch (error) { return toast(error.message); }
  study.completed += 1;
  if (correct) study.correctAttempts += 1; else study.wrongAttempts += 1;
  study.recognitionIndex += 1;
  showNextRecognition();
}

function showNextSpelling() {
  const study = app.study;
  if (!study.queue.length) return finishStudy();
  study.currentId = study.queue.shift();
  study.feedbackLocked = false;
  const word = currentWord();
  renderStudyPartOfSpeech("#spell-pos", word);
  $("#spell-meaning").textContent = word.meaning;
  $("#spelling-input").value = "";
  $("#spelling-input").disabled = false;
  $("#answer-feedback").className = "answer-feedback hidden";
  $("#submit-spelling").textContent = "提交答案";
  updateStudyProgress(study.manual ? "自主拼写" : "拼写练习", study.completed + 1, study.total);
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
  const sessionCompleted = study.manual && completedRound && study.queue.length === 0;
  try {
    const data = await request("/api/attempts", { method: "POST", body: JSON.stringify({
      wordId: word.id, sessionId: study.sessionId, source: study.source, mode: "spelling",
      answer, correct, completedRound, sessionCompleted
    }) });
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
  $("#complete-summary").textContent = app.study.manual
    ? `完成 ${app.study.total} 个单词的自主复习，记住或答对 ${app.study.correctAttempts} 次，纠正 ${app.study.wrongAttempts} 次。`
    : `完成 ${app.study.total} 个单词，答对 ${app.study.correctAttempts} 次，纠正 ${app.study.wrongAttempts} 次。明天记得回来复习。`;
  updateStudyProgress(app.study.manual ? "自主复习完成" : "今日完成", app.study.total, app.study.total);
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
  $("#save-daily-plan").addEventListener("click", saveDailyPlan);
  $("#library-add").addEventListener("click", () => go("import"));
  $$('[data-import-mode]').forEach(tab => tab.addEventListener("click", () => {
    $$('[data-import-mode]').forEach(node => node.classList.toggle("active", node === tab));
    $$(".import-mode").forEach(node => node.classList.toggle("active", node.id === `${tab.dataset.importMode}-import`));
  }));
  $$('[data-review-pick]').forEach(tab => tab.addEventListener("click", () => {
    $$('[data-review-pick]').forEach(node => node.classList.toggle("active", node === tab));
    $$(".review-picker").forEach(node => node.classList.toggle("active", node.id === `review-${tab.dataset.reviewPick}`));
  }));
  $("#review-kind").addEventListener("change", syncReviewMode);
  $("#review-activity").addEventListener("change", syncReviewMode);
  $("#review-pool").addEventListener("change", renderReviewAuto);
  $("#start-auto-review").addEventListener("click", startAutoReview);
  $("#start-selected-review").addEventListener("click", startSelectedReview);
  $("#review-search").addEventListener("input", renderReviewWords);
  $("#review-status-filter").addEventListener("change", renderReviewWords);
  $("#review-select-all").addEventListener("change", event => {
    for (const word of filteredReviewWords()) {
      if (event.target.checked) app.reviewSelection.add(word.id); else app.reviewSelection.delete(word.id);
    }
    renderReviewWords();
  });
  $("#review-word-body").addEventListener("change", event => {
    const checkbox = event.target.closest(".review-word-check");
    if (!checkbox) return;
    const id = checkbox.closest("tr").dataset.id;
    if (checkbox.checked) app.reviewSelection.add(id); else app.reviewSelection.delete(id);
    renderReviewWords();
  });
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
  $("#add-row").addEventListener("click", () => { syncCandidateInputs(); app.candidates.push({ spelling: "", partOfSpeech: "", partOfSpeechNeedsReview: true, meaning: "", confidence: 1, warning: "manual", sourceImageIndex: -1 }); renderCandidates(); });
  $("#candidate-body").addEventListener("click", event => {
    const button = event.target.closest(".row-delete");
    if (!button) return;
    syncCandidateInputs(); app.candidates.splice(Number(button.closest("tr").dataset.index), 1); renderCandidates();
  });
  $("#confirm-import").addEventListener("click", importCandidates);
  $("#word-search").addEventListener("input", renderLibrary);
  $("#status-filter").addEventListener("change", renderLibrary);
  $("#library-select-all").addEventListener("change", event => {
    for (const word of filteredLibraryWords()) {
      if (event.target.checked) app.librarySelection.add(word.id); else app.librarySelection.delete(word.id);
    }
    renderLibrary();
  });
  $("#delete-selected-words").addEventListener("click", deleteSelectedWords);
  $("#library-body").addEventListener("change", event => {
    const checkbox = event.target.closest(".library-word-check");
    if (!checkbox) return;
    const id = checkbox.closest("tr").dataset.id;
    if (checkbox.checked) app.librarySelection.add(id); else app.librarySelection.delete(id);
    renderLibrary();
  });
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
  $("#reveal-recognition").addEventListener("click", () => { $("#reveal-recognition").classList.add("hidden"); $("#recognition-answer").classList.remove("hidden"); });
  $("#recognition-remembered").addEventListener("click", () => gradeRecognition(true));
  $("#recognition-forgot").addEventListener("click", () => gradeRecognition(false));
  $("#leave-study").addEventListener("click", async () => {
    const manual = app.study?.manual;
    const message = manual ? "已经提交的练习结果会保留，本次未完成的内容不会计入连续学习。" : "已经提交的答题结果会保留，未完成的单词下次会重新安排。";
    if (await confirmAction("暂时退出学习？", message, "退出")) go(manual ? "review" : "home");
  });
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
