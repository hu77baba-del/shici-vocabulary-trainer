"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const navigationUrl = pathToFileURL(path.join(root, "public", "navigation.mjs")).href;

test("七个模块都有固定地址标记", async () => {
  const navigation = await import(navigationUrl);
  assert.deepEqual(navigation.ROUTE_VIEWS, ["home", "growth", "import", "library", "review", "settings", "study"]);
  for (const view of navigation.ROUTE_VIEWS) {
    assert.equal(navigation.routeFromHash(`#${view}`), view);
    assert.equal(navigation.routeUrl(view), `#${view}`);
  }
});

test("每个固定地址都有名称一致的导航按钮和页面", async () => {
  const navigation = await import(navigationUrl);
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  for (const view of navigation.ROUTE_VIEWS.filter(view => view !== "study")) {
    assert.match(html, new RegExp(`data-view="${view}"`), `${view} 缺少导航按钮`);
  }
  for (const view of navigation.ROUTE_VIEWS) {
    assert.match(html, new RegExp(`id="view-${view}"`), `${view} 缺少对应页面`);
  }
});

test("非法或不存在的地址标记安全回到首页", async () => {
  const navigation = await import(navigationUrl);
  assert.equal(navigation.routeFromHash(""), "home");
  assert.equal(navigation.routeFromHash("#missing"), "home");
  assert.equal(navigation.routeUrl("missing"), "#home");
});

test("历史状态能区分普通页面与首页安全节点", async () => {
  const navigation = await import(navigationUrl);
  const ordinary = navigation.makeHistoryState("growth");
  const guard = navigation.makeHistoryState("home", true);
  assert.equal(navigation.isAppHistoryState(ordinary), true);
  assert.equal(ordinary.view, "growth");
  assert.equal(ordinary.guard, false);
  assert.equal(guard.view, "home");
  assert.equal(guard.guard, true);
  assert.equal(navigation.isAppHistoryState({ view: "home" }), false);
});

test("重复点击当前模块不会写入重复历史", () => {
  const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(source, /const alreadyCurrent = isAppHistoryState\(history\.state\)/);
  assert.match(source, /if \(!alreadyCurrent\) history\.pushState/);
});

test("刷新会从地址恢复模块且学习页有安全回退", () => {
  const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(source, /const requestedView = routeFromHash\(location\.hash\)/);
  assert.match(source, /if \(requestedView === "study"\)/);
  assert.match(source, /if \(app\.state\.activeSession\) resumeActiveSession/);
  assert.match(source, /else go\("home", \{ historyMode: "replace" \}\)/);
});

test("返回键保护首页、学习、报告与迁移欢迎卡", () => {
  const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(source, /window\.addEventListener\("popstate", handleHistoryNavigation\)/);
  assert.match(source, /event\.state\.guard/);
  assert.match(source, /history\.pushState\(makeHistoryState\("home"\)/);
  assert.match(source, /app\.currentReportHistorical/);
  assert.match(source, /await acknowledgeCurrentReport\("home"/);
  assert.match(source, /await confirmAction\("暂时退出学习？"/);
  assert.match(source, /migration-modal/);
});
