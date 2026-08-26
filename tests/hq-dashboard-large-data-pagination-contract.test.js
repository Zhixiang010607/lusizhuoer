"use strict";

// The global HQ dashboard must never put every store/product or
// teacher/product aggregate into one synchronous CloudBase response. This is
// a source-level contract because the managed PostgreSQL service is not part
// of the local Node test environment.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  let depth = 0;
  for (let index = signatureEnd + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

const cloud = read("cloudfunctions/staffAccount/index.js");
const wrapper = read("cloudbase-phone-auth.js");
const app = read("app.js");
const page = read("index.html");
const styles = read("styles.css");
const overview = functionSource(cloud, "getHqDashboardOverview");
const ranking = functionSource(cloud, "getHqDashboardRanking");
const rankingSql = functionSource(cloud, "hqDashboardRankingSql");
const rankingRequest = functionSource(cloud, "dashboardRankingRequest");
const businessEvents = functionSource(cloud, "hqBusinessEventsCte");
const productSummarySql = functionSource(cloud, "hqDashboardProductSummarySql");
const productSummary = functionSource(cloud, "getHqDashboardProductSummary");
const dispatcher = functionSource(cloud, "getHqDashboard");
const rankingProjection = functionSource(cloud, "hqDashboardRankingProjection");

assert.match(cloud, /const FUNCTION_VERSION = "v74"/, "large-data dashboard deployment must identify as v74");
assert.match(cloud, /const HQ_DASHBOARD_CHART_LIMIT = 10/, "overview charts must be strictly bounded");
assert.match(cloud, /const HQ_DASHBOARD_MAX_PAGE_SIZE = 500/, "ranking page size must have a server maximum");
assert.doesNotMatch(cloud, /getHqDashboardLegacyFullPayload/, "the unsafe full-payload dashboard query must not remain callable or retained");
assert.match(dispatcher, /mode === "ranking"[\s\S]*getHqDashboardRanking[\s\S]*getHqDashboardOverview/,
  "dashboard dispatcher must split overview and ranking responses");
for (const chartName of ["store_chart", "project_chart", "teacher_chart"]) {
  assert.match(
    overview,
    new RegExp(`${chartName} AS \\([\\s\\S]*?ORDER BY[\\s\\S]*?LIMIT \\$\\{HQ_DASHBOARD_CHART_LIMIT\\}`),
    `${chartName} must use a direct Top-N limit instead of a full window ranking`
  );
}
assert.doesNotMatch(overview, /ROW_NUMBER\(\) OVER/, "overview Top-N charts must not sort all groups through a window function");
assert.doesNotMatch(overview, /teacherRows|store_product_rows|teacher_product_rows/,
  "overview must not return the former all-row aggregate payload");
assert.match(rankingSql, /COUNT\(\*\) OVER \(\)/, "each ranking page must carry its total count without returning all rows");
assert.match(rankingSql, /LIMIT \$\{pageSize\} OFFSET \$\{pageOffset\}/,
  "ranking SQL must use bounded deterministic pagination");
assert.match(rankingRequest, /\["store", "teacher"\]/,
  "ranking objects are exactly store or teacher; project is a filter, not a ranking object");
assert.match(rankingRequest, /\["recharge", "verification", "experience", "refund"\]/,
  "ranking must validate the selected business metric");
assert.match(rankingRequest, /productIdText \? numericId\(productIdText, "排名项目"\) : null/,
  "ranking must validate an optional concrete project id");
assert.match(businessEvents, /r\.product_id = \$\{productIdSql\}/);
assert.match(businessEvents, /v\.product_id = \$\{productIdSql\}/);
assert.match(rankingSql, /ORDER BY \$\{rankingColumn\} DESC/,
  "database ordering must use the selected metric instead of a client-side page sort");
assert.match(rankingSql, /AS ranking_total/,
  "selected-metric share must use the full filtered metric total");
assert.match(rankingProjection, /FROM public\.stores s[\s\S]*WHERE s\.store_status = 'ACTIVE'[\s\S]*OR event\.store_id IS NOT NULL/,
  "all active stores and only archived stores with in-range facts must participate");
assert.match(rankingProjection, /FROM public\.teachers teacher[\s\S]*WHERE teacher\.teacher_status = 'ACTIVE'[\s\S]*OR event\.teacher_id IS NOT NULL/,
  "all active teachers and only archived teachers with in-range attributed facts must participate");
assert.match(ranking, /pageNumber = Math\.min\(request\.pageNumber, totalPages\)/,
  "a stale high page request must be clamped safely");
assert.match(productSummarySql, /FROM public\.products product[\s\S]*LEFT JOIN business_events event ON event\.product_id = product\.id/,
  "project summary must include every configured project, including zero-business projects");
assert.match(productSummarySql, /COUNT\(\*\) OVER \(\)::bigint AS total_rows/,
  "project summary must count every project before pagination");
assert.match(productSummarySql, /ROW_NUMBER\(\) OVER[\s\S]*ORDER BY entity_name ASC/,
  "project summary pages must have stable project-name ordering");
assert.match(productSummary, /pageSize:\s*request\.pageSize[\s\S]*totalPages:[\s\S]*rows:/,
  "project summary must expose bounded pagination metadata and rows");
assert.match(dispatcher, /mode === "product-summary"[\s\S]*getHqDashboardProductSummary/,
  "project summary must have a dedicated read mode instead of reusing Top 10 ranking rows");

assert.match(wrapper, /mode = "overview", dimension, rankingMetric, productId, pageNumber, pageSize/,
  "browser wrapper must forward the bounded dashboard request contract");
assert.match(app, /mode: "overview"/, "dashboard initial load must request the small overview mode");
assert.match(app, /mode: "ranking"/, "dashboard initial load and export must request paged rankings");
assert.match(app, /rankingMetric,[\s\S]*productId,/,
  "browser ranking requests must forward both business type and project scope");
assert.match(app, /\["store", "teacher"\]\.map/,
  "browser ranking objects must be limited to store or teacher");
assert.match(app, /id="dashboardRankingProduct"/,
  "browser ranking must offer all projects or one concrete project");
assert.match(page, /option value="today" selected>今天<\/option>/,
  "browser HQ first entry must default to today");
assert.match(page, /id="dashboardRankingControls" class="dashboard-ranking-controls"/,
  "time and ranking controls must live in the same filter panel");
assert.match(page, /id="productSummaryBody"/);
assert.match(page, /id="productSummaryPrevious"[\s\S]*id="productSummaryNext"/,
  "browser project summary must page through all configured projects");
assert.match(app, /mode:\s*"product-summary"[\s\S]*pageSize:\s*PRODUCT_SUMMARY_PAGE_SIZE/,
  "browser must read the complete project summary through the dedicated paged service");
assert.match(app, /\$\("period"\)\.value = "today"[\s\S]*\$\("rankingDimension"\)\.value = "store"[\s\S]*state\.rankingMetric = "recharge"[\s\S]*state\.rankingProductId = ""/,
  "browser reset must restore today, store, all products, and recharge");
assert.match(app, /Promise\.allSettled/, "a ranking failure must not discard a successful overview");
assert.match(app, /try \{[\s\S]*?state\.ranking = normalizeRanking\(rankingResult\.value, dimension\)[\s\S]*?catch \(rankingError\)/,
  "a malformed fulfilled ranking response must not discard a successful overview");
assert.match(app, /function fetchRankingPage\(/, "frontend must fetch ranking pages independently");
assert.match(app, /function jumpToRankingPage\(/, "frontend must expose direct ranking page jumps");
assert.match(app, /PDF_EXPORT_PAGE_SIZE = 500/, "PDF export must stream bounded summary and ranking pages");
assert.match(app, /PDF_EXPORT_MAX_ROWS = 10000/, "PDF export must have a browser-safe hard cap");
assert.match(app, /RANKING_MAX_PAGE_NUMBER = 10000/, "the browser page jump must match the server page cap");
assert.match(app, /page\.total > PDF_EXPORT_MAX_ROWS/, "PDF export must re-check the limit from the server response");
assert.match(app, /while \(productPageNumber <= productTotalPages\)/, "PDF export must collect every project summary page");
assert.match(app, /while \(pageNumber <= totalPages\)/, "PDF export must collect all allowed ranking pages");
assert.match(app, /HqDashboardReport\.downloadReport\(\{[\s\S]*productRows,[\s\S]*rankingRows,/,
  "PDF export must draw the full project summary and complete ranking together");
assert.match(page, /id="rankingPreviousPage"/, "ranking pager needs previous-page control");
assert.match(page, /id="rankingPageInput"/, "ranking pager needs direct page input");
assert.match(page, /id="rankingRetry"/, "a failed ranking request needs a focused retry action");
assert.match(page, /id="rankingNextPage"/, "ranking pager needs next-page control");
assert.ok(page.indexOf('id="rankingPreviousPage"') < page.indexOf('id="rankingPageLabel"')
  && page.indexOf('id="rankingPageLabel"') < page.indexOf('id="rankingNextPage"')
  && page.indexOf('id="rankingNextPage"') < page.indexOf('id="rankingPageInput"'),
"mobile ranking pager must keep previous, page summary, and next together before the jump row");
assert.match(styles, /\.dashboard-ranking-pagination\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(68px,\s*auto\) minmax\(0,\s*1fr\) minmax\(68px,\s*auto\)/s,
  "mobile web ranking pager must keep previous/page/next in one centered row");

console.log("HQ dashboard large-data pagination contract: PASS");
