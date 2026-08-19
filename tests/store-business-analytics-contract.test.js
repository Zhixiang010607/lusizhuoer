"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const html = read("store-detail.html");
const analysisHtml = read("store-analysis.html");
const detail = read("store-detail.js");
const analysis = read("store-analysis.js");
const analyticsData = read("store-analytics-data.js");
const exporter = read("store-dashboard-export.js");
const orderExporter = read("order-export.js");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const auth = read("auth-ui.js");
const css = read("styles.css");

const includes = (source, expected, label) => assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);

includes(html, '<option value="today" selected>今日</option>', "overview defaults to today");
includes(html, 'id="storeAnalyticsHead"', "overview has dynamic project columns");
includes(html, 'id="storeAnalyticsBody"', "overview has four business rows");
includes(detail, '{ key: "recharge", label: "充值" }', "recharge row");
includes(detail, '{ key: "verification", label: "核销" }', "verification row");
includes(detail, '{ key: "experience", label: "体验" }', "experience row");
includes(detail, '{ key: "refund", label: "退费" }', "refund row");
includes(detail, 'store-analysis.html?${analyticsQuery(metric.key)}', "rows open dedicated metric pages");
includes(detail, '<th>汇总</th>', "summary final column");

includes(analysisHtml, 'id="storeAnalysisChart"', "store chart");
includes(analysisHtml, 'id="teacherAnalysisChart"', "teacher chart");
includes(analysisHtml, 'id="productAnalysisChart"', "product chart");
includes(analysis, 'Number(b.value || 0) - Number(a.value || 0)', "charts sort descending");
includes(analysis, '["today", "last7", "month"].find', "metric page preserves matching time presets");
includes(css, ".store-chart-scroll", "chart scrolling class");
includes(css, "overflow-x: auto", "horizontal scrolling");
includes(analyticsData, 'action: "getStoreBusinessAnalytics"', "frontend database action");

includes(cloud, "r.record_status = 'APPROVED'", "approved recharge/refund only");
includes(cloud, "v.record_status = 'APPROVED'", "approved verification/experience only");
includes(cloud, "r.recharge_type IN ('NEW', 'REFUND')", "recharge and refund metric split");
includes(cloud, "v.verification_type IN ('NORMAL', 'EXPERIENCE')", "normal and experience split");
includes(cloud, "WHERE p.product_status = 'ACTIVE'", "active products included with zero");
includes(cloud, "SELECT event.product_id", "historical products with period events included");
includes(cloud, "WHERE t.teacher_status = 'ACTIVE'", "active teachers included with zero");
includes(cloud, "AND account.account_status = 'ACTIVE'", "active teacher accounts required for zero inclusion");
includes(cloud, "SELECT event.teacher_id", "historical teachers with period events included");
assert.doesNotMatch(cloud.slice(cloud.indexOf("business_events AS"), cloud.indexOf("function storeAnalyticsCounts")), /product_status|teacher_status|store_status/, "event membership is independent of entity status");

includes(html, 'id="exportStoreAnalyticsPdf"', "overview PDF export");
includes(analysisHtml, 'id="exportAnalysisPdf"', "metric PDF export");
includes(exporter, "for (let index = 0; index < Math.max(products.length, 1); index += 4)", "summary table limits projects per page");
includes(exporter, "const pageSize = 24", "long tables paginate vertically");
includes(exporter, 'const includePhone = dimension !== "products"', "stores and teachers print phone but projects do not");
includes(exporter, 'Object.keys(dimensions).forEach', "each metric exports all classifications");
includes(exporter, "pages.push(...dimensionPages", "each classification starts a table page");
includes(exporter, "renderReportPages", "PDF table pages can be rendered for visual verification");
assert.doesNotMatch(exporter, /store-chart|bar-chart|drawBar/i, "PDF export uses tables, not charts");
includes(orderExporter, "exportCanvasPagesPdf", "PDF encoder accepts generated table pages");

includes(auth, '"store-analysis.html"', "store analysis route is authorized");
includes(analysisHtml, 'auth-ui.js?v=0.18.10', "analysis route loads current auth isolation");
includes(cloud, 'if (action === "getStoreBusinessAnalytics")', "cloud action dispatched");

console.log("store business analytics contract: ok");
