"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const pageRoot = path.join(root, "miniprogram-app", "miniprogram", "pages", "company-intro");
const read = (extension) => fs.readFileSync(path.join(pageRoot, `index.${extension}`), "utf8");

function loadCompanyPage() {
  let definition;
  const navigations = [];
  const phoneCalls = [];
  vm.runInNewContext(read("js"), {
    Page(value) { definition = value; },
    wx: {
      navigateTo(options) { navigations.push(options.url); options.complete?.(); },
      makePhoneCall(options) { phoneCalls.push(options.phoneNumber); options.complete?.(); },
      showToast() {}
    },
    Object
  }, { filename: "pages/company-intro/index.js" });
  return { definition, navigations, phoneCalls };
}

test("company introduction is a static public page focused on brand positioning", () => {
  const js = read("js");
  const wxml = read("wxml");
  const wxss = read("wxss");
  const json = JSON.parse(read("json"));
  const app = JSON.parse(fs.readFileSync(path.join(root, "miniprogram-app", "miniprogram", "app.json"), "utf8"));

  assert.equal(json.navigationBarTitleText, "露思卓儿");
  assert.equal(json.navigationStyle, "custom");
  assert.equal(app.pages[0], "pages/company-intro/index", "opening the mini-program must show the full-screen company home first");
  assert.doesNotMatch(js, /services\/(?:api|session)|requireSession|wx\.request|wx\.login/,
    "public company content must not read business data or depend on a staff session");
  for (const phrase of [
    "广州露思卓儿", "科技有限公司", "生活美容领域", "我们是谁", "品牌理念",
    "我们在做的事", "与谁同行", "品牌愿景", "把每一次体验做好",
    "100+", "10000+", "服务门店", "累计服务顾客", "加盟合作"
  ]) assert.match(wxml, new RegExp(phrase));
  for (const project of ["海洋之蕴", "魔法柔肤", "露思康辰"]) assert.match(wxml, new RegExp(project));
  for (const phone of ["181 7942 2788", "181 6078 9986"]) assert.match(wxml, new RegExp(phone));
  assert.match(wxml, /<image class="hero-background" src="\/images\/login\/lusizhuoer-login-bg-v4\.jpg" mode="aspectFill"/,
    "the first company page must reuse the confirmed Lusizhuoer logo artwork");
  for (const systemCopy of ["内部系统", "数据填报", "数据协同", "在线购买", "支付或交易", "小程序服务边界"]) {
    assert.ok(!wxml.includes(systemCopy), `company promotion must not foreground ${systemCopy}`);
  }
  for (const forbidden of ["抗衰", "逆龄", "治愈", "疗效", "治疗疼痛", "医学级", "医美赛道", "全国领先", "第一", "唯一"]) {
    assert.ok(!wxml.includes(forbidden), `public company copy must not contain ${forbidden}`);
  }
  assert.match(wxml, /class="company-topbar[^"]*"[\s\S]*class="topbar-login"[^>]*bindtap="openLogin"[\s\S]*>登录<\/button>/,
    "the separate staff login must be available from the upper-right company navigation");
  assert.match(wxml, /class="hero-lead[^"]*"[\s\S]*class="hero-login[^"]*"[^>]*bindtap="openLogin"/,
    "the opening page login must sit directly beneath the company introduction");
  assert.match(wxml, /wx:if="\{\{currentSlide > 0\}\}" class="topbar-login"/,
    "the top-right login must remain available after the opening page without crowding its logo composition");
  assert.match(wxml, /<swiper class="company-swiper" vertical="true"[\s\S]*bindchange="onSlideChange">/,
    "the company home must use reliable native vertical full-screen paging");
  assert.equal((wxml.match(/<swiper-item>/g) || []).length, 6,
    "each company chapter must occupy one of the six complete vertical pages");
  assert.match(wxml, /about-slide \{\{currentSlide === 1[\s\S]*belief-slide \{\{currentSlide === 2[\s\S]*focus-slide \{\{currentSlide === 3[\s\S]*partners-slide \{\{currentSlide === 4[\s\S]*projects-slide \{\{currentSlide === 5/,
    "brand belief must establish the company voice before actions, service reach, and project extensions");
  assert.doesNotMatch(wxml, /class="company-slide contact-slide|>加盟咨询<\/text>/,
    "the duplicated standalone contact page must stay retired after joining moves to the service-reach chapter");
  assert.match(wxml, /\{\{slideNumbers\[currentSlide\]\}\} \/ 06/);
  assert.match(wxml, /class="value-flow"[\s\S]*class="value-row[^"]*"/,
    "brand values must read as one vertical narrative rather than a grid of cards");
  assert.doesNotMatch(wxml, /value-grid|value-card|approach-grid|focus-list|belief-card|vision-card/,
    "the company home must not fall back to a modular card grid");
  assert.match(wxss, /\.company-swiper\s*\{[^}]*height:\s*100vh;/s);
  assert.match(wxss, /\.company-slide\s*\{[^}]*height:\s*100%;[^}]*align-items:\s*center;[^}]*overflow:\s*hidden;/s,
    "resting pages must never expose part of the next or previous chapter");
  assert.match(js, /onSlideChange\(event\)[\s\S]*currentSlide[\s\S]*reading:[\s\S]*scrolled:/,
    "vertical page changes must update the active chapter and progress indicators");
  assert.doesNotMatch(js, /onPageScroll|createIntersectionObserver/,
    "full-screen paging must not retain the retired free-scroll observer path");
  assert.match(js, /getMenuButtonBoundingClientRect[\s\S]*topbarStyle/,
    "the custom company navigation must keep its brand and login clear of the native status and menu controls");
  assert.match(wxss, /\.topbar-login\s*\{[^}]*position:\s*absolute;[^}]*right:\s*104px;[^}]*width:\s*100rpx !important;[^}]*height:\s*32px;/s,
    "the login control must be visible beside the native capsule without becoming a large primary action");
  assert.match(wxss, /\.hero-copy\s*\{[^}]*text-align:\s*center;/s,
    "the opening company statement must sit in the visual center instead of collecting at the bottom");
  assert.match(wxss, /\.hero-login\s*\{[^}]*margin:\s*30rpx auto 0;[^}]*border-radius:\s*29rpx;/s,
    "the opening login must remain a small centered action rather than a large primary panel");
  assert.match(wxml, /wx:if="\{\{currentSlide > 0\}\}" class="topbar-brand"/,
    "the first page must not repeat the brand name above the full company title");
  assert.match(wxml, /class="hero-title[^\"]*">广州露思卓儿科技有限公司<\/text>/);
  assert.match(wxml, /class="hero-statement[^\"]*">让专业有温度，让美好被认真对待<\/text>/);
  assert.doesNotMatch(wxml, />公司主页<\/text>/,
    "the retired company-home eyebrow must not return to the first page");
  assert.match(wxss, /\.hero-title\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(wxss, /\.hero-statement\s*\{[^}]*white-space:\s*nowrap;/s,
    "the company name and primary statement must each remain a deliberate single line");
  assert.match(wxml, /class="slide-footer"[\s\S]*class="slide-number"[\s\S]*class="swipe-guide"/);
  assert.doesNotMatch(wxml, /slide-dots|slide-dot/,
    "page status must stay in the quiet footer instead of interrupting the right edge of the composition");
  assert.match(wxml, /class="section-body balanced-copy[^"]*"[\s\S]*class="vision-copy balanced-copy[^"]*"[\s\S]*class="service-lead balanced-copy[^"]*"/,
    "long mobile copy must use deliberate semantic line groups rather than leaving orphaned final characters");
  assert.match(wxss, /\.title-lines text, \.balanced-copy text, \.belief-copy text \{ display: block; \}[\s\S]*@media \(min-width: 700px\)[\s\S]*\.balanced-copy text \{ display: inline; \}/,
    "deliberate phone line breaks must return to natural flow on tablet widths");
  assert.match(wxss, /\.slide-animate\s*\{[^}]*opacity:\s*0;[^}]*translateY\(30rpx\);/s);
  assert.match(wxss, /\.is-active \.delay-1[\s\S]*\.is-active \.delay-5[\s\S]*@keyframes text-rise/,
    "each settled page must animate headings, copy, and detail rows in a deliberate sequence");
  assert.match(wxss, /@media \(min-width: 700px\) \{/,
    "company introduction must cap typography and layout on tablets");
  assert.match(wxml, /class="service-reach[^"]*"[\s\S]*100\+[\s\S]*10000\+[\s\S]*class="partnership-block[^"]*"[\s\S]*181 7942 2788[\s\S]*181 6078 9986/,
    "confirmed service reach and both partnership contacts must form one continuous company chapter");
  assert.doesNotMatch(js, /showActionSheet|openPartnership|joinOpen/,
    "partnership contacts must be part of the page instead of a simulated popup or expandable overlay");
});

test("vertical chapter paging produces bounded active state and exact progress", () => {
  const { definition } = loadCompanyPage();
  const instance = {
    data: { ...definition.data },
    setData(update) { Object.assign(this.data, update); }
  };
  definition.onSlideChange.call(instance, { detail: { current: 3 } });
  assert.deepEqual({ currentSlide: instance.data.currentSlide, reading: instance.data.reading, scrolled: instance.data.scrolled },
    { currentSlide: 3, reading: 60, scrolled: true });
  definition.onSlideChange.call(instance, { detail: { current: 99 } });
  assert.deepEqual({ currentSlide: instance.data.currentSlide, reading: instance.data.reading },
    { currentSlide: 5, reading: 100 });
});

test("company home opens the separate login and only allow-listed project introductions", () => {
  const page = loadCompanyPage();
  page.definition.openLogin.call({});
  assert.deepEqual(page.navigations, ["/pages/login/index"]);
  for (const project of ["ocean", "skin", "warmth"]) {
    page.definition.openProjectIntro.call({}, { currentTarget: { dataset: { project } } });
  }
  assert.deepEqual(page.navigations, [
    "/pages/login/index",
    ...["ocean", "skin", "warmth"].map(project => `/pages/project-intro/index?project=${project}`)
  ]);

  for (const project of ["../home/index", "skin&role=hq", "constructor"]) {
    page.definition.openProjectIntro.call({}, { currentTarget: { dataset: { project } } });
  }
  assert.equal(page.navigations.length, 4);

  assert.deepEqual(page.phoneCalls, []);
});

test("inline partnership contacts only call the two approved numbers", () => {
  const page = loadCompanyPage();
  for (const phone of ["18179422788", "18160789986"]) {
    page.definition.callPhone.call({}, { currentTarget: { dataset: { phone } } });
  }
  page.definition.callPhone.call({}, { currentTarget: { dataset: { phone: "10086" } } });
  assert.deepEqual(page.phoneCalls, ["18179422788", "18160789986"]);
});
