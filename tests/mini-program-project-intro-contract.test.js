"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const directory = path.join(__dirname, "../miniprogram-app/miniprogram/pages/project-intro");
const { getProject } = require(path.join(directory, "content.js"));

function harness(height = 753, stack = [{ route: "pages/company-intro/index" }, { route: "pages/project-intro/index" }]) {
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

test("public introductions state distinct life-beauty positioning without medical promises", () => {
  const expected = {
    ocean: { headline: "轮廓与肤龄观感", keywords: ["轮廓", "肤龄观感"] },
    skin: { headline: "肤质与肤色观感", keywords: ["肤质", "肤色"] },
    warmth: { headline: "温度与身体舒适感", keywords: ["温度", "舒适体验"] }
  };
  for (const [key, focus] of Object.entries(expected)) {
    const project = getProject(key);
    assert.match(project.category, /^生活美容/);
    assert.match(project.headline, new RegExp(focus.headline));
    assert.equal(project.detailLabel, "02 / 核心优势");
    for (const keyword of focus.keywords) assert.match(project.keywords, new RegExp(keyword));
    const promotionalCopy = [
      project.category, project.headline, project.keywords, project.introLabel,
      project.introTitle, project.introduction, project.storyLabel,
      ...project.steps.flatMap(item => [item.title, item.text]),
      project.detailLabel, project.detailTitle, project.detailText,
      ...project.details.flatMap(item => [item.title, item.text])
    ].join(" ");
    assert.doesNotMatch(promotionalCopy, /解决|治愈|止痛|痛症|抗衰|逆龄|提高免疫|疏通经络|永久|保证|无副作用|疗程/);
  }
  for (const key of Object.keys(expected)) assert.equal("beforeText" in getProject(key), false,
    "the retired experience notice copy must not remain in public project data");
  for (const key of Object.keys(expected)) assert.equal("nextDevice" in getProject(key), false,
    "the compact footer must keep only the destination project name");
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

test("project switching replaces its page and return preserves the company home route", () => {
  const { page, navigation } = harness();
  page.onLoad({ project: "ocean" });
  page.openNext();
  assert.equal(navigation[0].method, "redirectTo");
  assert.equal(navigation[0].url, "/pages/project-intro/index?project=skin");
  page.returnToCompany();
  assert.equal(navigation[1].method, "navigateBack");
  assert.equal(navigation[1].delta, 1);
  const direct = harness(753, [{ route: "pages/project-intro/index" }]);
  direct.page.onLoad({ project: "ocean" }); direct.page.returnToCompany();
  assert.equal(direct.navigation[0].method, "reLaunch");
  assert.equal(direct.navigation[0].url, "/pages/company-intro/index");
});

test("unknown routes and failed local images retain usable return and reading controls", () => {
  const invalid = harness(); invalid.page.onLoad({ project: "constructor" }); invalid.page.onReady();
  assert.equal(invalid.page.data.unavailable, true);
  assert.equal(invalid.pending.length, 0);
  invalid.page.openNext(); assert.equal(invalid.navigation.length, 0);
  invalid.page.returnToCompany(); assert.equal(invalid.navigation[0].method, "navigateBack");
  const valid = harness(); valid.page.onLoad({ project: "ocean" }); valid.page.heroError();
  assert.equal(valid.page.data.heroFailed, true);
  assert.equal(valid.page.data.project.steps.length, 3);
});

test("project footer keeps both destinations in one compact row without an experience notice", () => {
  const wxml = fs.readFileSync(path.join(directory, "index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(directory, "index.wxss"), "utf8");
  const js = fs.readFileSync(path.join(directory, "index.js"), "utf8");
  assert.match(wxml, /class="footer-actions"[\s\S]*class="next-project"[\s\S]*class="footer-back"/);
  assert.match(wxss, /\.footer-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:/s);
  assert.match(wxss, /\.intro-footer \.next-project\s*\{[^}]*min-height:\s*76px;/s);
  assert.match(wxss, /\.intro-footer \.footer-back\s*\{[^}]*min-height:\s*76px;/s);
  assert.match(wxss, /\.intro-footer\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*30;/s,
    "the real footer actions must sit above the sticky story layer for physical pointer input");
  assert.match(wxml, /class="next-project"[^>]*hover-class="footer-action-hover"[^>]*bindtap="openNext"/);
  assert.match(wxml, /class="footer-back"[^>]*hover-class="footer-action-hover"[^>]*bindtap="returnToCompany"/);
  assert.doesNotMatch(wxml, /继续探索露思卓儿/,
    "the footer must not add a third visual layer above the two real destinations");
  assert.doesNotMatch(wxml, /体验须知|intro-notice|notice-toggle/);
  assert.doesNotMatch(wxss, /intro-notice|notice-toggle|notice-copy/);
  assert.doesNotMatch(js, /noticeOpen|toggleNotice/);
});
