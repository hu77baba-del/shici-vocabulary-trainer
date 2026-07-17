"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DATA_FILE = path.join(ROOT, "data", "app-data.json");

function normalizeSpelling(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US").replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
}

function normalizeMeaning(value) {
  return String(value || "").trim().replace(/\s+/g, " ").replace(/[；;]+/g, "；");
}

function normalizePartOfSpeech(value) {
  return [...new Set(String(value || "").toLocaleLowerCase("en-US")
    .replace(/[，；、|]+/g, "/")
    .split("/").map(token => token.trim()).filter(Boolean))].join("/");
}

function isPhraseSpelling(spelling) {
  return /\s/.test(String(spelling || "").trim());
}

function loadTextbookRows(fixturesDir = path.join(ROOT, "tests", "fixtures")) {
  return fs.readdirSync(fixturesDir)
    .filter(name => /^expected-ocr.*\.json$/i.test(name))
    .flatMap(name => JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8")))
    .filter(row => row && row.spelling && row.partOfSpeech);
}

function buildTextbookIndexes(rows) {
  const exact = new Map();
  const bySpelling = new Map();
  rows.forEach(row => {
    const spelling = normalizeSpelling(row.spelling);
    const partOfSpeech = normalizePartOfSpeech(row.partOfSpeech);
    exact.set(`${spelling}\t${normalizeMeaning(row.meaning)}`, partOfSpeech);
    if (!bySpelling.has(spelling)) bySpelling.set(spelling, new Set());
    bySpelling.get(spelling).add(partOfSpeech);
  });
  return { exact, bySpelling };
}

async function createWordNetLookup() {
  const WordPOS = require("wordpos");
  const wordpos = new WordPOS({ stopwords: false });
  return async spelling => {
    const result = await wordpos.getPOS(spelling);
    const normalized = normalizeSpelling(spelling);
    const values = [];
    if (result.nouns?.some(word => normalizeSpelling(word) === normalized)) values.push("n.");
    if (result.verbs?.some(word => normalizeSpelling(word) === normalized)) values.push("v.");
    if (result.adjectives?.some(word => normalizeSpelling(word) === normalized)) values.push("adj.");
    if (result.adverbs?.some(word => normalizeSpelling(word) === normalized)) values.push("adv.");
    return values.join("/");
  };
}

function invariantSnapshot(store) {
  const copy = JSON.parse(JSON.stringify(store));
  copy.words = (copy.words || []).map(word => {
    delete word.partOfSpeech;
    delete word.partOfSpeechNeedsReview;
    return word;
  });
  return JSON.stringify(copy);
}

async function migrateStore(store, options = {}) {
  const migrated = JSON.parse(JSON.stringify(store));
  const textbookRows = options.textbookRows || loadTextbookRows();
  const { exact, bySpelling } = buildTextbookIndexes(textbookRows);
  const lookupPartOfSpeech = options.lookupPartOfSpeech || await createWordNetLookup();
  const statistics = { total: migrated.words.length, phrases: 0, preserved: 0, textbook: 0, dictionary: 0, unresolved: 0 };

  for (const word of migrated.words) {
    if (isPhraseSpelling(word.spelling)) {
      word.partOfSpeech = "";
      word.partOfSpeechNeedsReview = false;
      statistics.phrases += 1;
      continue;
    }
    if (word.partOfSpeech) {
      word.partOfSpeech = normalizePartOfSpeech(word.partOfSpeech);
      word.partOfSpeechNeedsReview = word.partOfSpeechNeedsReview === true;
      statistics.preserved += 1;
      continue;
    }
    const spelling = normalizeSpelling(word.spelling);
    const exactPartOfSpeech = exact.get(`${spelling}\t${normalizeMeaning(word.meaning)}`);
    const spellingValues = bySpelling.get(spelling);
    const textbookPartOfSpeech = exactPartOfSpeech || (spellingValues?.size === 1 ? [...spellingValues][0] : "");
    if (textbookPartOfSpeech) {
      word.partOfSpeech = textbookPartOfSpeech;
      word.partOfSpeechNeedsReview = false;
      statistics.textbook += 1;
      continue;
    }
    const dictionaryPartOfSpeech = normalizePartOfSpeech(await lookupPartOfSpeech(word.spelling));
    word.partOfSpeech = dictionaryPartOfSpeech;
    word.partOfSpeechNeedsReview = true;
    if (dictionaryPartOfSpeech) statistics.dictionary += 1;
    else statistics.unresolved += 1;
  }

  if (invariantSnapshot(store) !== invariantSnapshot(migrated)) {
    throw new Error("迁移改变了词性字段以外的数据，已停止写入");
  }
  return { store: migrated, statistics };
}

async function applyMigration(options = {}) {
  const dataFile = path.resolve(options.dataFile || DEFAULT_DATA_FILE);
  const originalText = fs.readFileSync(dataFile, "utf8");
  const original = JSON.parse(originalText);
  const result = await migrateStore(original, options);
  let backupPath = null;
  if (options.apply === true) {
    const backupDir = path.join(path.dirname(dataFile), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(backupDir, `pre-part-of-speech-${stamp}.json`);
    fs.writeFileSync(backupPath, originalText, "utf8");
    const temp = `${dataFile}.part-of-speech.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(result.store, null, 2)}\n`, "utf8");
    fs.renameSync(temp, dataFile);
  }
  return { ...result, backupPath, applied: options.apply === true };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const result = await applyMigration({
    dataFile: argumentValue("--data-file") || DEFAULT_DATA_FILE,
    apply: process.argv.includes("--apply")
  });
  console.log(JSON.stringify({ applied: result.applied, backupPath: result.backupPath, statistics: result.statistics }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { applyMigration, buildTextbookIndexes, invariantSnapshot, isPhraseSpelling, loadTextbookRows, migrateStore };
