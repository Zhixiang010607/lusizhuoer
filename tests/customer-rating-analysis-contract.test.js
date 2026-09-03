"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const cloud = read("cloudfunctions/customerRating/index.js");
const appJson = read("miniprogram-app/miniprogram/app.json");
const homeJs = read("miniprogram-app/miniprogram/pages/home/index.js");
const homeWxml = read("miniprogram-app/miniprogram/pages/home/index.wxml");
const pageJs = read("miniprogram-app/miniprogram/pages/rating-analysis/index.js");
const pageWxml = read("miniprogram-app/miniprogram/pages/rating-analysis/index.wxml");
const pageWxss = read("miniprogram-app/miniprogram/pages/rating-analysis/index.wxss");

test("rating analysis classifies each eligible order by its lowest score and reserves zero for unrated", () => {
  assert.match(cloud, /const FUNCTION_VERSION = "v6"/);
  assert.match(cloud, /WHEN r\.rating_status = 'SUBMITTED' AND r\.submitted_at IS NOT NULL[\s\S]*THEN LEAST\(r\.store_environment_score, r\.overall_experience_score,[\s\S]*COALESCE\(r\.teacher_service_score, 5\)\)[\s\S]*ELSE 0/);
  assert.match(cloud, /vr\.record_status = 'APPROVED'/);
  assert.match(cloud, /vr\.verification_type IN \('NORMAL', 'EXPERIENCE'\)/);
  assert.match(cloud, /COUNT\(\*\) FILTER \(WHERE effective_score = 0\)/);
  for (const score of [1, 2, 3, 4, 5]) {
    assert.match(cloud, new RegExp(`COUNT\\(\\*\\) FILTER \\(WHERE effective_score = ${score}\\)`));
  }
  assert.match(cloud, /COUNT\(\*\) FILTER \(WHERE effective_score IN \(\$\{scoreList\}\)\)::BIGINT AS selected_count/,
    "selected scores filter the list count while the six distribution counts retain the full dimension scope");
  assert.match(cloud, /LEFT JOIN public\.verification_customer_ratings r ON r\.verification_id = vr\.id/,
    "orders without a rating row must remain in the zero-score population");
});

test("rating analysis locks stores by role and supports project, teacher, Shanghai date, score, and paging filters", () => {
  assert.match(cloud, /staff\.role_code === "store"[\s\S]*vr\.store_id = \$\{sqlId\(staff\.store_id, "门店"\)\}/);
  assert.match(cloud, /event\.productId[\s\S]*vr\.product_id = \$\{sqlId\(event\.productId, "项目"\)\}/);
  assert.match(cloud, /teacher\.toUpperCase\(\) === "NONE"[\s\S]*vr\.teacher_id IS NULL/);
  assert.match(cloud, /vr\.teacher_id = \$\{sqlId\(teacher, "老师"\)\}/);
  assert.match(cloud, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.match(cloud, /自定义时间范围不能超过 366 天/);
  assert.match(cloud, /评分必须从 0 至 5 分中至少选择一项/);
  assert.match(cloud, /ORDER BY submitted_at DESC, id DESC[\s\S]*LIMIT \$\{limit\}[\s\S]*OFFSET \$\{\(requestedPage - 1\) \* limit\}/);
  assert.match(cloud, /仅总部或门店可以查询评价分析/);
  assert.match(cloud, /case "getRatingAnalysisOptions"/);
  assert.match(cloud, /case "queryRatingAnalysis"/);
});

test("HQ runtime returns full-scope pies while a score combination filters only result orders", async () => {
  const sqlCalls = [];
  const sqlResult = (row) => row
    ? { Columns: Object.keys(row), Rows: [Object.values(row)] }
    : { Columns: [], Rows: [] };
  const executePGSql = async ({ Sql }) => {
    sqlCalls.push(Sql);
    if (Sql.includes("information_schema.columns")) {
      return sqlResult({ has_store_account_id: true, has_staff_store_assignments: false });
    }
    if (Sql.includes("FROM public.staff_accounts a")) {
      return sqlResult({ id: "7", role_code: "hq", account_status: "ACTIVE", store_id: null, store_status: null, teacher_id: null, teacher_status: null });
    }
    if (Sql.includes("COUNT(*)::BIGINT AS total_count")) {
      return sqlResult({ total_count: "20", rated_count: "15", score_0_count: "5", score_1_count: "1", score_2_count: "2", score_3_count: "3", score_4_count: "4", score_5_count: "5", selected_count: "9" });
    }
    if (Sql.includes("ORDER BY submitted_at DESC, id DESC")) {
      return sqlResult({
        id: "42", record_code: "VXST202609030042", verification_type: "NORMAL",
        customer_code: "CST000042", customer_name: "测试客户", store_id: "3", store_name: "测试门店",
        product_id: "8", product_name: "测试项目", teacher_id: "5", teacher_name: "测试老师",
        service_time: "2026-09-03 10:30", effective_score: 4,
        store_environment_score: 5, teacher_service_score: 5, overall_experience_score: 4
      });
    }
    throw new Error(`unexpected SQL: ${Sql}`);
  };
  const module = { exports: {} };
  const sandbox = {
    Buffer, URL, console: { error() {} }, exports: module.exports, module,
    process: { env: { CLOUDBASE_ENV_ID: "test-env" } }, setTimeout,
    require(name) {
      if (name === "node:crypto") return require("node:crypto");
      if (name === "@cloudbase/node-sdk") return { init: () => ({ auth: () => ({ getUserInfo: () => ({ uid: "hq-auth-uid" }) }) }) };
      if (name === "@cloudbase/manager-node") return { init: () => ({ database: { executePGSql } }) };
      if (name === "qrcode") return { toDataURL: async () => "" };
      throw new Error(`unexpected dependency: ${name}`);
    }
  };
  vm.runInNewContext(cloud, sandbox, { filename: "cloudfunctions/customerRating/index.js" });
  const result = await module.exports.main({
    action: "queryRatingAnalysis", storeId: "3", productId: "8", teacherId: "5",
    startDate: "2026-09-01", endDate: "2026-09-03", scores: [0, 4], pageNumber: 1, pageSize: 20
  });
  assert.equal(result.success, true);
  assert.equal(result.version, "v6");
  assert.deepEqual(Array.from(result.data.selectedScores), [0, 4]);
  assert.deepEqual(Array.from(result.data.summary.scoreCounts), [5, 1, 2, 3, 4, 5]);
  assert.equal(result.data.summary.total, 20);
  assert.equal(result.data.summary.rated, 15);
  assert.equal(result.data.summary.unrated, 5);
  assert.equal(result.data.total, 9);
  assert.equal(result.data.orders[0].effectiveScore, 4);
  const combinedSql = sqlCalls.join("\n");
  assert.match(combinedSql, /vr\.store_id = 3/);
  assert.match(combinedSql, /vr\.product_id = 8/);
  assert.match(combinedSql, /vr\.teacher_id = 5/);
  assert.match(combinedSql, /effective_score IN \(0, 4\)/);
});

test("mini-program exposes a two-pie rating analysis with arbitrary 0-5 multi-select", () => {
  assert.match(appJson, /"root": "pages\/rating-analysis"/);
  assert.match(homeWxml, /data-type="rating-analysis"[^>]*>评价分析</);
  assert.match(homeJs, /type === "rating-analysis"[\s\S]*pages\/rating-analysis\/index/);
  assert.match(pageJs, /requireSession\(\["hq", "store"\]\)/);
  assert.match(pageJs, /callRating\("getRatingAnalysisOptions"\)/);
  assert.match(pageJs, /callRating\("queryRatingAnalysis", this\.payload\(targetPage\)\)/);
  assert.match(pageJs, /selectedScores: \[0, 1, 2, 3, 4, 5\]/);
  assert.match(pageJs, /toggleScore\(event\)[\s\S]*selected\.delete\(score\)[\s\S]*selected\.add\(score\)/);
  for (const label of ["门店", "项目", "老师", "时间范围", "最低评分（可任意多选）", "0–5 分分布", "评价覆盖率"]) {
    assert.ok(pageWxml.includes(label), `rating analysis page missing ${label}`);
  }
  assert.match(pageWxml, /0 表示未评价/);
  assert.match(pageWxml, /例如 5、5、4 归为 4 分/);
  assert.match(pageWxml, /id="scoreDistributionChart" type="2d"/);
  assert.match(pageWxml, /id="ratingCoverageChart" type="2d"/);
  assert.match(pageWxml, /分数多选不会改变图表分母/);
  assert.match(pageJs, /context\.arc\(centerX, centerY, radius, start, end\)/);
  assert.match(pageWxss, /\.chart-grid \{ display: grid; grid-template-columns: 1fr;/);
  assert.match(pageWxss, /@media \(min-width: 700px\)[\s\S]*\.chart-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(pageWxss, /\.rating-table \{ width: auto; min-width: 100%; display: inline-table; table-layout: auto;/);
});
