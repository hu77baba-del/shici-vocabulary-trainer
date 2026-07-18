"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DICTIONARY_FILE = path.join(__dirname, "..", "resources", "pronunciation", "cmudict.json");
const VOWELS = new Set(["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"]);
let dictionaryCache = null;

function loadDictionary() {
  if (!dictionaryCache) dictionaryCache = JSON.parse(fs.readFileSync(DICTIONARY_FILE, "utf8"));
  return dictionaryCache;
}

function isListeningWord(word) {
  const spelling = String(word?.spelling || "").trim();
  return word?.status !== "new" && Boolean(spelling) && !/[\s/]/.test(spelling);
}

function fallbackTokens(value) {
  let spelling = String(value || "").toLocaleLowerCase("en-US").replace(/[^a-z]/g, "");
  if (!spelling) return [];
  const patterns = [
    [/tion/g, " SH AH N "], [/sion/g, " ZH AH N "], [/tch/g, " CH "], [/dge/g, " JH "],
    [/ph/g, " F "], [/kn/g, " N "], [/wr/g, " R "], [/wh/g, " W "], [/th/g, " TH "],
    [/sh/g, " SH "], [/ch/g, " CH "], [/qu/g, " K W "], [/ck/g, " K "], [/ng/g, " NG "],
    [/ee|ea/g, " IY "], [/oo/g, " UW "], [/ai|ay/g, " EY "], [/oa/g, " OW "], [/ou|ow/g, " AW "]
  ];
  for (const [pattern, replacement] of patterns) spelling = spelling.replace(pattern, replacement);
  const letters = {
    a: "AE", b: "B", c: "K", d: "D", e: "EH", f: "F", g: "G", h: "HH", i: "IH",
    j: "JH", k: "K", l: "L", m: "M", n: "N", o: "AO", p: "P", q: "K", r: "R",
    s: "S", t: "T", u: "AH", v: "V", w: "W", x: "K S", y: "IY", z: "Z"
  };
  return spelling.split(/\s+/).flatMap(part => {
    if (!part) return [];
    if (/^[A-Z]+$/.test(part)) return [part];
    return [...part].flatMap(letter => (letters[letter] || "").split(" ").filter(Boolean));
  }).filter((token, index, tokens) => token && token !== tokens[index - 1]);
}

function pronunciationsFor(spelling) {
  const dictionary = loadDictionary();
  const key = String(spelling || "").toLocaleLowerCase("en-US");
  const pronunciations = [];
  if (dictionary[key]) pronunciations.push(dictionary[key]);
  for (let index = 2; dictionary[`${key}(${index})`]; index += 1) pronunciations.push(dictionary[`${key}(${index})`]);
  if (!pronunciations.length) return [fallbackTokens(key).join(" ")];
  return pronunciations;
}

function splitPronunciation(value) {
  const raw = String(value || "").split(/\s+/).filter(Boolean);
  return {
    phonemes: raw.map(token => token.replace(/\d/g, "")),
    stresses: raw.filter(token => VOWELS.has(token.replace(/\d/g, ""))).map(token => token.match(/\d/)?.[0] || "0")
  };
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function pronunciationDistance(left, right) {
  let best = 1;
  for (const leftValue of pronunciationsFor(left)) {
    for (const rightValue of pronunciationsFor(right)) {
      const a = splitPronunciation(leftValue);
      const b = splitPronunciation(rightValue);
      const phoneme = editDistance(a.phonemes, b.phonemes) / Math.max(1, a.phonemes.length, b.phonemes.length);
      const syllables = Math.min(1, Math.abs(a.stresses.length - b.stresses.length) / Math.max(1, a.stresses.length, b.stresses.length));
      const stress = editDistance(a.stresses, b.stresses) / Math.max(1, a.stresses.length, b.stresses.length);
      best = Math.min(best, phoneme * 0.75 + syllables * 0.15 + stress * 0.1);
    }
  }
  return best;
}

function stableTie(targetId, candidateId) {
  const text = `${targetId}:${candidateId}`;
  let value = 2166136261;
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

function buildListeningChoices(target, learnedWords, count = 4) {
  if (!isListeningWord(target)) throw new Error("听力认词只支持已经学习过的单词");
  const targetMeaning = target.meaning.trim();
  const candidates = learnedWords.filter(candidate => isListeningWord(candidate) && candidate.id !== target.id)
    .filter(candidate => {
      const meaning = String(candidate.meaning || "").trim();
      return meaning && meaning !== targetMeaning;
    })
    .map(candidate => ({
      word: candidate,
      distance: pronunciationDistance(target.spelling, candidate.spelling),
      samePartOfSpeech: Boolean(target.partOfSpeech && target.partOfSpeech === candidate.partOfSpeech),
      tie: stableTie(target.id, candidate.id)
    }));

  const byDistance = [...candidates].sort((a, b) => a.distance - b.distance || a.tie - b.tie);
  const seenMeanings = new Set([targetMeaning]);
  const uniqueCandidates = byDistance.filter(item => {
    const meaning = String(item.word.meaning || "").trim();
    if (seenMeanings.has(meaning)) return false;
    seenMeanings.add(meaning);
    return true;
  });
  if (uniqueCandidates.length < count - 1) throw new Error("至少需要 4 个中文释义不同的已学单词才能开始听力认词");
  const selected = [];
  const take = list => {
    for (const item of list) {
      if (selected.includes(item) || selected.length >= count - 1) continue;
      selected.push(item);
    }
  };
  take(uniqueCandidates.filter(item => item.distance <= 0.62));
  take(uniqueCandidates.filter(item => item.samePartOfSpeech));
  take(uniqueCandidates);
  return [target.id, ...selected.slice(0, count - 1).map(item => item.word.id)];
}

function orderedChoiceIds(choiceIds, seed) {
  return [...choiceIds].sort((left, right) => stableTie(seed, left) - stableTie(seed, right));
}

module.exports = {
  isListeningWord,
  pronunciationsFor,
  pronunciationDistance,
  buildListeningChoices,
  orderedChoiceIds
};
