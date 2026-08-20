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
const dashboard = functionSource(staffAccount, "getHqDashboard");

assert.match(dashboard, /business_events\s+AS\s*\(/i,
  "dashboard must aggregate a common event stream before presentation joins");
assert.match(dashboard, /r\.recharge_type\s+IN\s*\('NEW',\s*'REFUND'\)/i,
  "approved NEW and REFUND records must be represented independently");
assert.match(dashboard, /CASE\s+WHEN\s+r\.recharge_type\s*=\s*'NEW'[\s\S]{0,160}recharge_count/i,
  "NEW records must populate recharge only");
assert.match(dashboard, /CASE\s+WHEN\s+r\.recharge_type\s*=\s*'REFUND'[\s\S]{0,160}refund_count/i,
  "REFUND records must populate refund only");
assert.match(dashboard, /v\.verification_type\s+IN\s*\('NORMAL',\s*'SUPPLEMENT',\s*'EXPERIENCE'\)/i,
  "approved verification records must retain historical normal, supplement, and experience events");
assert.match(dashboard, /v\.verification_type\s+IN\s*\('NORMAL',\s*'SUPPLEMENT'\)[\s\S]{0,160}verification_count/i,
  "normal/supplement verification must not absorb experience");
assert.match(dashboard, /v\.verification_type\s*=\s*'EXPERIENCE'[\s\S]{0,160}experience_count/i,
  "experience verification must have its own metric");
assert.match(dashboard, /experience:\s*Number\(totalRow\.experience_count/i,
  "dashboard totals must return experience to clients");
assert.match(dashboard, /refund:\s*Number\(totalRow\.refund_count/i,
  "dashboard totals must return refund to clients");
assert.match(dashboard, /teacher_row\.experience_count/i,
  "teacher historical rows must retain experience detail");
assert.match(dashboard, /teacher_row\.refund_count/i,
  "teacher historical rows must retain refund detail");

// Archive changes prevent new selections but do not erase past approved
// events.  Joining master data after event aggregation preserves archived
// records in date-range reporting.
assert.doesNotMatch(dashboard, /(?:store_status|teacher_status|product_status|customer_status)\s*=\s*'ACTIVE'/i,
  "HQ historical analytics must not filter approved events by current archive state");

for (const metric of ["experience", "refund"]) {
  assert.match(app, new RegExp(`${metric}:\\s*finiteCount\\(pick\\(row`, "i"),
    `${metric} must be normalized from the service response`);
  assert.match(app, new RegExp(`${metric}:\\s*finiteCount\\(pick\\(totals`, "i"),
    `${metric} must be normalized in dashboard totals`);
  assert.match(page, new RegExp(`data-drill=\\"${metric}\\"`),
    `${metric} must be drillable from the overview`);
  assert.match(page, new RegExp(`id=\\"${metric}Total\\"`),
    `${metric} must have a visible metric card`);
}
assert.match(app, /\["recharge",\s*"verification",\s*"experience",\s*"refund"\]/,
  "charts must show all four business metrics together");
assert.match(app, /有效体验次数/, "CSV export must retain experience");
assert.match(app, /有效退费次数/, "CSV export must retain refunds");
assert.match(page, /业务总计占比/, "ranking must base its share on all reported business counts");

console.log("HQ four-metric statistics contract: PASS");
