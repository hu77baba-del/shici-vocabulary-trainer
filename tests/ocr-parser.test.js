"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const expected = require("./fixtures/expected-ocr.json");
const expectedMultiColumn = require("./fixtures/expected-ocr-e7bd80.json");
const expectedStarred = require("./fixtures/expected-ocr-ad34e2.json");
const expectedPerspective = require("./fixtures/expected-ocr-7ece03.json");
const expectedWordsWithPartOfSpeech = require("./fixtures/expected-ocr-5de9cb.json");
const expectedPhrasesWithoutPartOfSpeech = require("./fixtures/expected-ocr-0bab9e.json");
const parser = require("../public/ocr-parser.js");

const image = { width: 1600, height: 1200 };

function box(x, y, width, height = 34) {
  return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
}

function rotatePoint([x, y], rotation) {
  if (rotation === 90) return [image.height - y, x];
  if (rotation === 180) return [image.width - x, image.height - y];
  if (rotation === 270) return [y, image.width - x];
  return [x, y];
}

function rotatedImage(rotation) {
  const items = [];
  expected.forEach((row, index) => {
    const y = 160 + index * 72;
    items.push({ text: row.spelling, score: 0.98, poly: box(230, y, 260) });
    items.push({ text: row.meaning, score: 0.97, poly: box(850, y + 2, 260) });
    items.push({ text: String(index + 1), score: 0.99, poly: box(110, y, 35) });
  });
  items.push({ text: "词组板块", score: 0.99, poly: box(220, 70, 150) });
  items.push({ text: "三.根据中文提示，写出对应的词组。", score: 0.98, poly: box(120, 1040, 520) });
  return items.map(item => ({ ...item, poly: item.poly.map(point => rotatePoint(point, rotation)) }));
}

for (const rotation of [0, 90, 180, 270]) {
  test(`坐标旋转 ${rotation}° 后仍能得到相同的 11 组词条`, () => {
    const result = parser.parse(rotatedImage(rotation), image, 3);
    assert.equal(result.needsRetry, false);
    assert.equal(result.matchedCount, 11);
    assert.deepEqual(result.candidates.map(({ spelling, meaning }) => ({ spelling, meaning })), expected);
    assert.ok(result.candidates.every(item => item.sourceImageIndex === 3));
  });
}

test("高置信度英文缺少中文时保留并标记缺少释义", () => {
  const items = rotatedImage(0).filter(item => item.text !== expected[5].meaning);
  const result = parser.parse(items, image, 0);
  const missing = result.candidates.find(item => item.spelling === expected[5].spelling);
  assert.deepEqual({ meaning: missing.meaning, warning: missing.warning }, { meaning: "", warning: "missing" });
});

test("无表格内容会要求旋转或重新识别", () => {
  const result = parser.parse([{ text: "CAREER", score: 0.99, poly: box(100, 100, 120) }], image, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.needsRetry, true);
});

test("斜杠连接的两行短语可以完整配对且不会误提示旋转", () => {
  const rows = [
    { spelling: "meet with/face many difficulties", meaning: "遇到／面临许多困难" },
    { spelling: "do something wrong", meaning: "做错事" }
  ];
  const items = [];
  rows.forEach((row, index) => {
    const y = 180 + index * 76;
    items.push({ text: index === 0 ? "meet with / face many difficulties" : row.spelling, score: 0.99, poly: box(280, y, 500) });
    items.push({ text: row.meaning, score: 0.99, poly: box(980, y + 2, 360) });
  });
  const result = parser.parse(items, image, 0);
  assert.equal(result.needsRetry, false);
  assert.equal(result.needsReview, false);
  assert.equal(result.matchedCount, 2);
  assert.deepEqual(result.candidates.map(({ spelling, meaning }) => ({ spelling, meaning })), rows);
  assert.equal(parser.isEnglishPhrase({ text: "/meet difficulties", score: 0.99 }), false);
  assert.equal(parser.isEnglishPhrase({ text: "meet//face difficulties", score: 0.99 }), false);
});

test("多列表格会忽略音标词性表头页脚并保留单字释义", () => {
  const items = [
    { text: "序号", score: 0.99, poly: box(100, 60, 80) },
    { text: "英文", score: 0.99, poly: box(320, 60, 80) },
    { text: "音标", score: 0.99, poly: box(720, 60, 80) },
    { text: "词性", score: 0.99, poly: box(1080, 60, 80) },
    { text: "中文释义", score: 0.99, poly: box(1300, 60, 150) }
  ];
  expectedMultiColumn.forEach(({ spelling, meaning }, index) => {
    const y = 150 + index * 72;
    items.push({ text: spelling, score: 0.98, poly: box(320, y, 220) });
    items.push({ text: `/${spelling}/`, score: 0.9, poly: box(720, y, 220) });
    items.push({ text: index % 3 === 0 ? "adj." : "n.", score: 0.97, poly: box(1080, y, 90) });
    items.push({ text: meaning, score: 0.98, poly: box(1300, y + 2, 220) });
  });
  items.push({ text: "粗体词为课标三级词汇表中收录的初中阶段基本词汇", score: 0.99, poly: box(180, 930, 900) });

  const result = parser.parse(items, image, 0);
  assert.equal(result.rotation, 0);
  assert.equal(result.matchedCount, 10);
  assert.equal(result.quality.missingCount, 0);
  assert.equal(result.quality.unmatchedChineseCount, 0);
  assert.deepEqual(result.candidates.map(({ spelling, meaning }) => ({ spelling, meaning })), expectedMultiColumn.map(({ spelling, meaning }) => ({ spelling, meaning })));
  assert.deepEqual(result.candidates.map(item => item.partOfSpeech), expectedMultiColumn.map((_, index) => index % 3 === 0 ? "adj." : "n."));
  assert.ok(result.candidates.every(item => item.partOfSpeechNeedsReview === false));
});

test("单词表会逐行保留教材词性", () => {
  const items = [
    { text: "单词", score: 0.99, poly: box(300, 60, 80) },
    { text: "音标", score: 0.99, poly: box(680, 60, 80) },
    { text: "词性", score: 0.99, poly: box(1030, 60, 80) },
    { text: "中文释义", score: 0.99, poly: box(1220, 60, 150) }
  ];
  expectedWordsWithPartOfSpeech.forEach((row, index) => {
    const y = 150 + index * 76;
    items.push({ text: row.spelling, score: 0.99, poly: box(300, y, 220) });
    items.push({ text: `/${row.spelling}/`, score: 0.96, poly: box(680, y, 220) });
    items.push({ text: row.partOfSpeech, score: 0.98, poly: box(1030, y, 90) });
    items.push({ text: row.meaning, score: 0.99, poly: box(1220, y + 2, 300) });
  });
  const result = parser.parse(items, image, 0);
  assert.equal(result.needsRetry, false);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.candidates.map(({ spelling, partOfSpeech, meaning }) => ({ spelling, partOfSpeech, meaning })), expectedWordsWithPartOfSpeech);
});

test("词组表忽略邻近词性噪声并保持词性为空", () => {
  const items = [];
  expectedPhrasesWithoutPartOfSpeech.forEach((row, index) => {
    const y = 110 + index * 48;
    items.push({ text: row.spelling, score: 0.99, poly: box(260, y, 560) });
    items.push({ text: index % 2 ? "n." : "adj.", score: 0.98, poly: box(900, y, 80) });
    items.push({ text: row.meaning, score: 0.99, poly: box(1080, y + 2, 380) });
  });
  const result = parser.parse(items, image, 0);
  assert.equal(result.matchedCount, expectedPhrasesWithoutPartOfSpeech.length);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.candidates.map(({ spelling, partOfSpeech, meaning }) => ({ spelling, partOfSpeech, meaning })), expectedPhrasesWithoutPartOfSpeech);
});

test("多词性会规范化，低置信度和陌生缩写会提示校对", () => {
  const items = [
    { text: "light", score: 0.99, poly: box(300, 180, 200) },
    { text: "n. / adj.", score: 0.99, poly: box(820, 180, 140) },
    { text: "光；轻的", score: 0.99, poly: box(1120, 182, 220) },
    { text: "popular", score: 0.99, poly: box(300, 260, 200) },
    { text: "adj.", score: 0.8, poly: box(820, 260, 100) },
    { text: "流行的", score: 0.99, poly: box(1120, 262, 220) },
    { text: "honest", score: 0.99, poly: box(300, 340, 200) },
    { text: "phr. v.", score: 0.99, poly: box(820, 340, 110) },
    { text: "诚实的", score: 0.99, poly: box(1120, 342, 220) }
  ];
  const result = parser.parse(items, image, 0);
  assert.equal(result.candidates[0].partOfSpeech, "n./adj.");
  assert.equal(result.candidates[0].partOfSpeechNeedsReview, false);
  assert.equal(result.candidates[1].partOfSpeech, "adj.");
  assert.equal(result.candidates[1].partOfSpeechNeedsReview, true);
  assert.equal(result.candidates[2].partOfSpeech, "phr. v.");
  assert.equal(result.candidates[2].partOfSpeechNeedsReview, true);
  assert.equal(result.candidates[2].warning, "check");
  assert.equal(parser.isPartOfSpeech({ text: "n. / v.", score: 0.99 }), true);
  assert.equal(parser.isPartOfSpeech({ text: "phr. v.", score: 0.99 }), true);
  assert.equal(parser.isPartOfSpeech({ text: "phrasal verb", score: 0.99 }), false);
});

test("中间一行词性漏识别时不会把后续词性向上错挂", () => {
  const rows = [
    { spelling: "honest", partOfSpeech: "adj.", meaning: "诚实的" },
    { spelling: "alive", partOfSpeech: "", meaning: "活着的" },
    { spelling: "wrong", partOfSpeech: "adj.", meaning: "错误的" },
    { spelling: "style", partOfSpeech: "n.", meaning: "风格" }
  ];
  const items = [];
  rows.forEach((row, index) => {
    const y = 180 + index * 86;
    items.push({ text: row.spelling, score: 0.99, poly: box(300, y, 220, 58) });
    if (row.partOfSpeech) items.push({ text: row.partOfSpeech, score: 0.98, poly: box(1030, y + 4, 90, 54) });
    items.push({ text: row.meaning, score: 0.99, poly: box(1220, y + 2, 260, 58) });
  });
  const result = parser.parse(items, image, 0);
  assert.deepEqual(result.candidates.map(item => item.partOfSpeech), ["adj.", "", "adj.", "n."]);
  assert.equal(result.candidates[1].warning, "missing-pos");
  assert.equal(result.candidates[2].warning, "clear");
});

test("透视倾斜的多列表格不会把整列释义串到上一行", () => {
  const slope = -0.08;
  const headerY = x => 100 + slope * x;
  const items = [
    { text: "序号", score: 0.99, poly: box(100, headerY(100), 60) },
    { text: "单词", score: 0.99, poly: box(320, headerY(320), 80) },
    { text: "音标", score: 0.99, poly: box(720, headerY(720), 80) },
    { text: "词性", score: 0.99, poly: box(1080, headerY(1080), 80) },
    { text: "中文释义", score: 0.99, poly: box(1300, headerY(1300), 150) }
  ];
  expectedPerspective.forEach(({ spelling, meaning }, index) => {
    const rowY = 220 + index * 72;
    items.push({ text: spelling, score: 0.98, poly: box(320, rowY + slope * 320, 220) });
    const curvedPerspectiveOffset = slope * 1300 + index * 6;
    items.push({ text: meaning, score: 0.98, poly: box(1300, rowY + curvedPerspectiveOffset, 80 + meaning.length * 38) });
  });

  const result = parser.parse(items, image, 0);
  assert.equal(result.matchedCount, expectedPerspective.length);
  assert.ok(Math.abs(result.quality.rowSlope - slope) < 0.005);
  assert.deepEqual(result.candidates.map(({ spelling, meaning }) => ({ spelling, meaning })), expectedPerspective.map(({ spelling, meaning }) => ({ spelling, meaning })));
});

test("低置信度单字中文不会作为释义导入", () => {
  assert.equal(parser.isChineseMeaning({ text: "板", score: 0.99 }), true);
  assert.equal(parser.isChineseMeaning({ text: "商", score: 0.33 }), false);
  assert.equal(parser.isChineseMeaning({ text: "（诚实的）person always tells the truth.", score: 0.99 }), false);
  assert.equal(parser.isChineseMeaning({ text: "v.露营n.营地", score: 0.99 }), true);
});

test("教材词首星号会被清除但不会放宽其他英文符号", () => {
  for (const marker of ["*", "＊", "﹡", "✱", "✲", "✳"]) {
    assert.equal(parser.isEnglishPhrase({ text: `${marker} fully`, score: 0.99 }), true);
    assert.equal(parser.normalizeEnglishText(`${marker} fully`), "fully");
  }
  assert.equal(parser.isEnglishPhrase({ text: "fu*lly", score: 0.99 }), false);
  assert.equal(parser.isEnglishPhrase({ text: "fully*", score: 0.99 }), false);
});

test("带星号教材词表会输出清洗后的完整七组词条", () => {
  const items = [];
  expectedStarred.forEach(({ spelling, meaning }, index) => {
    const y = 150 + index * 72;
    const markedSpelling = index >= 5 ? `*${spelling}` : spelling;
    items.push({ text: markedSpelling, score: 0.98, poly: box(320, y, 240) });
    items.push({ text: meaning, score: 0.98, poly: box(1050, y + 2, 300) });
  });
  const result = parser.parse(items, image, 0);
  assert.equal(result.matchedCount, 7);
  assert.deepEqual(result.candidates.map(({ spelling, meaning }) => ({ spelling, meaning })), expectedStarred.map(({ spelling, meaning }) => ({ spelling, meaning })));
});
