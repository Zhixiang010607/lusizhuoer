"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const auth = read("auth-ui.js");
const client = read("operational-metrics.js");
const css = read("operational-metrics.css");
const context = read("PROJECT_CONTEXT.md");

test("HQ Web operations menu exposes all five tablet-equivalent routes", () => {
  const routes = [
    ["inactive-customers.html", "活跃预警"],
    ["low-balance-customers.html", "余次预警"],
    ["rating-analysis.html", "评价分析"],
    ["daily-report-tracking.html", "日报追踪"],
    ["attendance-tracking.html", "打卡追踪"]
  ];
  const hqAccess = auth.slice(auth.indexOf("hq: new Set"), auth.indexOf("store: new Set"));
  for (const [route, label] of routes) {
    assert.match(hqAccess, new RegExp(route.replace(".", "\\.")));
    assert.match(auth, new RegExp(`\\[\\"${route.replace(".", "\\.")}\\", \\"${label}\\"\\]`));
  }
  assert.match(context, /总部“运营”固定完整显示活跃预警、余次预警、评价分析、日报追踪、打卡追踪五个入口/);
});

test("three Web operational pages use the shared responsive implementation", () => {
  for (const [file, scope] of [["inactive-customers.html", "inactive"], ["low-balance-customers.html", "balance"], ["rating-analysis.html", "rating"]]) {
    const html = read(file);
    assert.match(html, new RegExp(`data-operation-metric="${scope}"`));
    assert.match(html, /operational-metrics\.css\?v=1\.0\.2/);
    assert.match(html, /operational-metrics\.js\?v=1\.0\.1/);
    assert.match(html, /auth-ui\.js\?v=0\.21\.3/);
    assert.match(html, /id="operationsPrint"/);
    assert.match(html, /id="operationsExport"/);
    assert.match(html, /打印 \/ PDF/);
  }
  assert.match(css, /.operations-filter-grid[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /body\[data-operation-metric="inactive"\] \.operations-filter-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) minmax\(250px, 1fr\); \}/);
  assert.match(css, /body\[data-operation-metric="balance"\] \.operations-filter-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\) minmax\(250px, 1fr\); \}/);
  assert.match(css, /body\[data-operation-metric="inactive"\] \.operations-filter-grid input,[\s\S]*height: 44px;[\s\S]*margin-top: 0;[\s\S]*font-size: 14px;/);
  assert.match(css, /\.operations-filter-grid > \* \{ min-width: 0; \}/);
  assert.match(css, /\.operations-filter-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 12px;/);
  assert.match(css, /\.operations-empty \{ min-height: 72px;[\s\S]{0,100}padding: 14px;/);
  assert.match(css, /.operations-table-scroll[\s\S]*overflow: auto/);
  assert.match(css, /@media \(max-width: 620px\)/);
});

test("Web rating analysis uses the iPad time-range choices and never opens a locale-dependent native date picker", () => {
  const html = read("rating-analysis.html");
  for (const label of ["今天", "全部时间", "近 7 天", "近 1 个月", "本季度", "本年度", "自定义日期"]) {
    assert.match(client, new RegExp(label.replace(" ", "\\s*")));
  }
  assert.match(client, /时间范围<select id="operationsPeriod"/);
  assert.match(client, /data-rating-custom-date hidden/);
  assert.match(client, /aria-label="\$\{label\}年份"/);
  assert.match(client, /chineseDateMarkup\("operationsStart", "开始日期", today\)/);
  assert.match(client, /chineseDateMarkup\("operationsEnd", "结束日期", today\)/);
  assert.doesNotMatch(client, /type="date"/);
  assert.doesNotMatch(html, /type="date"/);
  assert.match(client, /period === "ALL"[\s\S]*startDate: "", endDate: ""/);
  assert.match(client, /自定义时间范围不能超过 366 天/);
  assert.match(css, /body\[data-operation-metric="rating"\] \.operations-filter-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
});

test("Web operations preserve server categories, cursors, scores, paging, export and detail links", () => {
  for (const action of ["queryInactiveVerificationCustomers", "queryLowBalanceCustomers", "getRatingAnalysisOptions", "queryRatingAnalysis"]) assert.match(client, new RegExp(action));
  for (const token of ["balanceCategory: \"BOTH\"", "cursorBaselineAt", "cursorCustomerId", "cursorRemainingCount", "cursorProductId", "scores:", "exportAll: true", "EXPORT_LIMIT = 1000"]) assert.match(client, new RegExp(token));
  assert.match(client, /customer-detail\.html\?customerId=/);
  assert.match(client, /verification-detail\.html\?recordId=/);
  assert.match(client, /text\/csv;charset=utf-8/);
});

test("daily tracker stacks complete tables and production CSS has a new cache key", () => {
  const html = read("daily-report-tracking.html");
  const trackerCss = read("daily-report-tracking.css");
  assert.match(html, /daily-report-tracking\.css\?v=0\.2\.1/);
  assert.match(trackerCss, /\.daily-tracking-columns\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(trackerCss, /grid-template-columns:\s*minmax\(120px, 1fr\) minmax\(150px, 1fr\) minmax\(120px, 0\.9fr\) 92px/);
});

test("receipt preview is bounded and recharge review uses a compact no-wrap table", () => {
  const projectHtml = read("project-detail.html");
  const projectClient = read("project-detail.js");
  const rechargeHtml = read("recharge-review.html");
  const reviewClient = read("review.js");
  const styles = read("styles.css");
  assert.match(projectHtml, /project-detail\.js\?v=0\.2\.8/);
  assert.match(projectHtml, />重新生成</);
  assert.match(projectClient, /PREVIEW_TIMEOUT_MS = 15000/);
  assert.match(projectClient, /预览生成超过 15 秒/);
  assert.doesNotMatch(rechargeHtml, /<th>类型<\/th>/);
  for (const heading of ["项目", "次数", "提交时间", "审核结果", "审核时间"]) assert.match(rechargeHtml, new RegExp(`<th>${heading}<\\/th>`));
  assert.match(reviewClient, /pageType === "recharge" \? 9 : 10/);
  assert.match(styles, /body\[data-review="recharge"\] \.review-table th,[\s\S]*white-space:\s*nowrap/);
});
