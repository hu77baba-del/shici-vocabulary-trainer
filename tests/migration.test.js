"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyMigration, invariantSnapshot, migrateStore } = require("../scripts/migrate-part-of-speech.js");

function sampleStore() {
  return {
    version: 1,
    words: [
      { id: "heart", spelling: "heart", meaning: "心脏；内心", status: "new", failureCount: 0 },
      { id: "test", spelling: "test", meaning: "测试", status: "review", failureCount: 2 },
      { id: "phrase", spelling: "to be honest", meaning: "说实话", status: "new", failureCount: 0 },
      { id: "unknown", spelling: "codexword", meaning: "未知", status: "new", failureCount: 0 }
    ],
    reviews: [{ id: "review", wordId: "test", correct: false }],
    settings: { dailyNewPlan: { wordIds: ["heart", "phrase"] } }
  };
}

const textbookRows = [{ spelling: "heart", partOfSpeech: "n.", meaning: "心脏；内心" }];
const lookupPartOfSpeech = async spelling => spelling === "test" ? "n./v." : "";

test("迁移只增加词性字段并按教材、词典、词组分别处理", async () => {
  const original = sampleStore();
  const result = await migrateStore(original, { textbookRows, lookupPartOfSpeech });
  assert.equal(invariantSnapshot(result.store), invariantSnapshot(original));
  assert.deepEqual(result.statistics, { total: 4, phrases: 1, preserved: 0, textbook: 1, dictionary: 1, unresolved: 1 });
  assert.deepEqual(
    result.store.words.map(word => [word.id, word.partOfSpeech, word.partOfSpeechNeedsReview]),
    [["heart", "n.", false], ["test", "n./v.", true], ["phrase", "", false], ["unknown", "", true]]
  );
});

test("迁移默认预览，应用时先备份再原子写入", async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocabulary-pos-migration-"));
  try {
    const dataFile = path.join(testDir, "app-data.json");
    const original = sampleStore();
    fs.writeFileSync(dataFile, `${JSON.stringify(original, null, 2)}\n`, "utf8");
    const preview = await applyMigration({ dataFile, apply: false, textbookRows, lookupPartOfSpeech });
    assert.equal(preview.applied, false);
    assert.equal(preview.backupPath, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, "utf8")), original);

    const applied = await applyMigration({ dataFile, apply: true, textbookRows, lookupPartOfSpeech });
    assert.equal(applied.applied, true);
    assert.ok(fs.existsSync(applied.backupPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(applied.backupPath, "utf8")), original);
    assert.equal(JSON.parse(fs.readFileSync(dataFile, "utf8")).words[0].partOfSpeech, "n.");
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
