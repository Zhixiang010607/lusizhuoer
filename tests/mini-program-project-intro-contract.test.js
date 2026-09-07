"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const directory = path.join(__dirname, "../miniprogram-app/miniprogram/pages/project-intro");
const { getProject } = require(path.join(directory, "content.js"));

function harness(height = 753, stack = [{ route: "pages/login/index" }, { route: "pages/project-intro/index" }]) {
  let definition;
  const pending = [], scrolls = [], navigation = [], patches = [];
  const windowInfo = { windowWidth: 390, windowHeight: height };
  const query = { select() { return this; }, selectViewport() { return this; }, boundingClientRect() { return this; }, scrollOffset() { return this; }, exec(callback) { pending.push(callback); } };
  vm.runInNewContext(fs.readFileSync(path.join(directory, "index.js"), "utf8"), {
    Page(value) { definition = value; },
    require(id) { assert.equal(id, "./content", "public content must not import session or business APIs"); return { getProject }; },
    getCurrentPages: () => stack,
    wx: {
      getWindowInfo: () => windowInfo,
      createSelectorQuery: () => ({ in() { return query; } }),
      pageScrollTo: options => scrolls.push(options),
      redirectTo(options) { navigation.push({ method: "redirectTo", ...options }); options.complete(); },
      navigateBack(options) { navigation.push({ method: "navigateBack", ...options }); options.complete(); },
      reLaunch(options) { navigation.push({ method: "reLaunch", ...options }); options.complete(); },
      showToast() {}
    }
  });
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch, complete) { patches.push(patch); Object.assign(this.data, patch); if (complete) complete(); } };
  function measure() {
    pending.shift()([{ top: 1052, height: page.data.storyHeight }, { height: 5000 }, { scrollTop: 0 }]);
  }
  return { page, pending, measure, scrolls, navigation, patches, windowInfo };
}

test("all three published project names have static sourced chapters and bounded local hero assets", () => {
  const names = { ocean: "海洋之蕴", skin: "魔法柔肤", warmth: "露思康辰" };
  for (const [key, name] of Object.entries(names)) {
    const project = getProject(key);
    assert.equal(project.name, name);
    assert.equal(project.steps.length, 3);
    assert.ok(getProject(project.nextKey), "next project must be another registered public project");
    assert.notEqual(project.nextKey, key);
    assert.ok(fs.statSync(path.join(directory, "assets", `${key}-hero.jpg`)).size < 200 * 1024);
    for (const step of project.steps) assert.ok(step.title && step.text && step.word);
    assert.doesNotMatch(JSON.stringify(project), /100%|20-30%|无副作用|FDA|CFDA|1～3次|7～8mm/);
  }
  for (const key of [undefined, "", "__proto__", "constructor", "skin&role=hq", "../home"]) assert.equal(getProject(key), null);
});

test("scroll transitions update chapters in both directions and motion off retains every chapter", () => {
  const { page, measure, scrolls } = harness();
  page.onLoad({ project: "skin" }); page.onReady(); measure();
  const top = page._storyTop, travel = page._storyTravel;
  for (const [progress, expected] of [[0, 0], [.5, 1], [.9, 2], [.2, 0]]) {
    page.onPageScroll({ scrollTop: top + travel * progress });
    assert.equal(page.data.chapter, expected);
  }
  page.toggleMotion();
  assert.equal(page.data.heroStyle, "");
  const staticLayer = page.data.layerOne;
  page.onPageScroll({ scrollTop: top + travel * .85 });
  assert.equal(page.data.chapter, 2);
  assert.equal(page.data.layerOne, staticLayer);
  page.selectChapter({ currentTarget: { dataset: { chapter: 1 } } });
  assert.equal(scrolls.at(-1).duration, 0);
  assert.ok(scrolls.at(-1).scrollTop > top && scrolls.at(-1).scrollTop < top + travel);
});

test("late measurement callbacks cannot mutate an unloaded introduction or override a resize", () => {
  const { page, pending, patches, windowInfo } = harness();
  page.onLoad({ project: "warmth" }); page.onReady();
  const oldMeasurement = pending.shift();
  windowInfo.windowHeight = 600; page.onResize();
  const count = patches.length;
  oldMeasurement([{ top: 1052, height: 2000 }, { height: 5000 }, { scrollTop: 0 }]);
  assert.equal(patches.length, count);
  assert.equal(page.data.compact, true, "short screens must use normal flow to avoid clipping pinned copy");
  page.onUnload();
  pending.shift()([{ top: 1052, height: 2000 }, { height: 5000 }, { scrollTop: 0 }]);
  page.onPageScroll({ scrollTop: 2500 });
  assert.equal(patches.length, count);
});

test("project switching replaces its page and return preserves the original login route", () => {
  const { page, navigation } = harness();
  page.onLoad({ project: "ocean" });
  page.openNext();
  assert.equal(navigation[0].method, "redirectTo");
  assert.equal(navigation[0].url, "/pages/project-intro/index?project=skin");
  page.returnToLogin();
  assert.equal(navigation[1].method, "navigateBack");
  assert.equal(navigation[1].delta, 1);
  const direct = harness(753, [{ route: "pages/project-intro/index" }]);
  direct.page.onLoad({ project: "ocean" }); direct.page.returnToLogin();
  assert.equal(direct.navigation[0].method, "reLaunch");
  assert.equal(direct.navigation[0].url, "/pages/login/index");
});

test("unknown routes and failed local images retain usable return and reading controls", () => {
  const invalid = harness(); invalid.page.onLoad({ project: "constructor" }); invalid.page.onReady();
  assert.equal(invalid.page.data.unavailable, true);
  assert.equal(invalid.pending.length, 0);
  invalid.page.openNext(); assert.equal(invalid.navigation.length, 0);
  invalid.page.returnToLogin(); assert.equal(invalid.navigation[0].method, "navigateBack");
  const valid = harness(); valid.page.onLoad({ project: "ocean" }); valid.page.heroError();
  assert.equal(valid.page.data.heroFailed, true);
  assert.equal(valid.page.data.project.steps.length, 3);
});

test("experience notes start collapsed and update document measurement when opened or closed", () => {
  const { page, pending, scrolls } = harness();
  page.onLoad({ project: "warmth" });
  assert.equal(page.data.noticeOpen, false);
  page.toggleNotice();
  assert.equal(page.data.noticeOpen, true);
  assert.equal(pending.length, 1);
  assert.equal(scrolls[0].selector, "#intro-notice");
  assert.match(page.data.project.beforeText, /孕妇、未成年人/);
  page.toggleNotice();
  assert.equal(page.data.noticeOpen, false);
  assert.equal(pending.length, 2, "closing must recalculate reading length too");
  assert.equal(scrolls.length, 1, "closing must not unexpectedly scroll to another section");
});

test("a delayed notice render cannot scroll the next page after leaving the introduction", () => {
  const { page, scrolls, pending } = harness();
  page.onLoad({ project: "skin" });
  let rendered;
  page.setData = (patch, complete) => { Object.assign(page.data, patch); rendered = complete; };
  page.toggleNotice();
  page.onUnload();
  rendered();
  assert.equal(scrolls.length, 0);
  assert.equal(pending.length, 0);
});
