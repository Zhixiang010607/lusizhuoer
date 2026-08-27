"use strict";

// Headquarters must report business facts by event type, rather than folding
// experience into normal verification or refund into recharge.  This remains a
// source-level contract because the CloudBase PostgreSQL service is not part of
// the local Node test environment.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  let depth = 0;
  for (let index = signatureEnd + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

const staffAccount = read("cloudfunctions/staffAccount/index.js");
const app = read("app.js");
const page = read("index.html");
const eventCte = functionSource(staffAccount, "hqBusinessEventsCte");
const rankingProjection = functionSource(staffAccount, "hqDashboardRankingProjection");
const overview = functionSource(staffAccount, "getHqDashboardOverview");
const dashboard = functionSource(staffAccount, "getHqDashboard");

assert.match(eventCte, /business_events\s+AS\s*\(/i,
  "dashboard must aggregate a common event stream before presentation joins");
assert.match(eventCte, /WHEN submitter\.role_code = 'store'[\s\S]{0,100}r\.recharge_type IN \('NEW', 'REFUND'\) THEN r\.teacher_id/,
  "store recharge and refund may retain their selected business teacher");
assert.match(eventCte, /WHEN submitter\.role_code = 'store'[\s\S]{0,100}v\.verification_type = 'NORMAL' THEN v\.teacher_id/,
  "store verification attribution must be limited to NORMAL");
assert.match(eventCte, /WHEN submitter\.role_code = 'teacher'[\s\S]{0,140}submitting_teacher\.id = r\.teacher_id[\s\S]{0,100}r\.recharge_type IN \('NEW', 'REFUND'\) THEN r\.teacher_id/,
  "teacher recharge and refund attribution must match the submitting teacher profile");
assert.match(eventCte, /WHEN submitter\.role_code = 'teacher'[\s\S]{0,140}submitting_teacher\.id = v\.teacher_id[\s\S]{0,100}v\.verification_type IN \('NORMAL', 'EXPERIENCE'\) THEN v\.teacher_id/,
  "teacher NORMAL and EXPERIENCE attribution must match the submitting teacher profile");
assert.equal((eventCte.match(/ELSE NULL::bigint[\s\S]{0,40}END AS teacher_id/g) || []).length, 2,
  "HQ, retired-role, missing-submittee, and mismatched historical facts must stay in totals without teacher attribution");
assert.equal((eventCte.match(/submitter\.id = [rv]\.submitted_by_account_id/g) || []).length, 2,
  "the source role must come from the immutable submitting account on each fact");
assert.doesNotMatch(eventCte, /WHERE\s+submitter\.role_code/i,
  "invalid teacher attribution must be nulled rather than deleting the event from store, product, or total metrics");
assert.doesNotMatch(eventCte, /role_code = 'store'[\s\S]{0,100}v\.verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "historical store EXPERIENCE must remain in totals without teacher attribution");
assert.doesNotMatch(eventCte, /role_code = 'teacher'[\s\S]{0,180}v\.verification_type IN \('NORMAL', 'SUPPLEMENT', 'EXPERIENCE'\)/,
  "retired SUPPLEMENT events must remain in totals without teacher attribution");
assert.match(eventCte, /r\.recharge_type\s+IN\s*\('NEW',\s*'REFUND'\)/i,
  "approved NEW and REFUND records must be represented independently");
assert.match(eventCte, /CASE\s+WHEN\s+r\.recharge_type\s*=\s*'NEW'[\s\S]{0,160}recharge_count/i,
  "NEW records must populate recharge only");
assert.match(eventCte, /CASE\s+WHEN\s+r\.recharge_type\s*=\s*'REFUND'[\s\S]{0,160}refund_count/i,
  "REFUND records must populate refund only");
assert.match(eventCte, /v\.verification_type\s+IN\s*\('NORMAL',\s*'SUPPLEMENT',\s*'EXPERIENCE'\)/i,
  "approved verification records must retain historical normal, supplement, and experience events");
assert.match(eventCte, /v\.verification_type\s+IN\s*\('NORMAL',\s*'SUPPLEMENT'\)[\s\S]{0,160}verification_count/i,
  "normal/supplement verification must not absorb experience");
assert.match(eventCte, /v\.verification_type\s*=\s*'EXPERIENCE'[\s\S]{0,160}experience_count/i,
  "experience verification must have its own metric");
assert.match(overview, /experience:\s*Number\(totalRow\.experience_count/i,
  "dashboard totals must return experience to clients");
assert.match(overview, /refund:\s*Number\(totalRow\.refund_count/i,
  "dashboard totals must return refund to clients");
assert.match(rankingProjection, /dimension === "teacher"[\s\S]*?experience_count/i,
  "teacher historical rankings must retain experience detail");
assert.match(rankingProjection, /dimension === "teacher"[\s\S]*?refund_count/i,
  "teacher historical rankings must retain refund detail");
assert.match(rankingProjection, /'UNASSIGNED'::text AS entity_code[\s\S]*?'未指定老师'::text AS entity_name/i,
  "teacher ranking must expose an explicit non-teacher bucket for effective unassigned business");
assert.match(rankingProjection, /FROM business_events event[\s\S]*?WHERE event\.teacher_id IS NULL[\s\S]*?HAVING COALESCE\(SUM/i,
  "the unassigned bucket must include only effective facts that have no trusted teacher attribution");
assert.match(dashboard, /mode === "ranking"[\s\S]*getHqDashboardRanking/i,
  "dashboard dispatcher must expose a separate bounded ranking mode");

// Archive changes never erase approved historical events. Ranking population
// additionally includes every current active master (including zero rows),
// while an archived master participates only when the selected range contains
// an effective event for it.
assert.doesNotMatch(eventCte, /(?:store_status|teacher_status|product_status|customer_status)\s*=\s*'ACTIVE'/i,
  "the fact stream itself must never delete history by current archive state");
assert.match(rankingProjection, /store_status = 'ACTIVE'[\s\S]*OR event\.store_id IS NOT NULL/i);
assert.match(rankingProjection, /teacher_status = 'ACTIVE'[\s\S]*OR event\.teacher_id IS NOT NULL/i);

for (const metric of ["experience", "refund"]) {
  assert.match(app, new RegExp(`${metric}:\\s*finiteCount\\(pick\\(row`, "i"),
    `${metric} must be normalized from the service response`);
  assert.match(app, new RegExp(`${metric}:\\s*finiteCount\\(pick\\(totals`, "i"),
    `${metric} must be normalized in dashboard totals`);
  const summaryId = metric[0].toUpperCase() + metric.slice(1);
  assert.match(page, new RegExp(`id=\\"productSummary${summaryId}\\"`),
    `${metric} must remain visible in the all-product summary total`);
}
assert.doesNotMatch(page, /class="metric-grid"|data-drill=/,
  "the retired standalone HQ metric cards must not return");
for (const label of ["有效充值", "有效核销", "有效体验", "有效退费"]) {
  assert.match(page, new RegExp(`<th>${label}</th>`),
    `the complete ranking must retain ${label}`);
}
assert.match(app, /HqDashboardReport\.downloadReport\(\{[\s\S]*productRows,[\s\S]*rankingRows,/,
  "vector PDF export must retain project summary and complete ranking data");
assert.match(page, /业务总计占比/, "ranking must base its share on all reported business counts");

console.log("HQ four-metric statistics contract: PASS");
