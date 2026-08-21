"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const customerUi = read("customer-profile.js");
const customerHtml = read("customer-detail.html");
const teacherHtml = read("teacher-work-orders.html");
const storeHtml = read("store-detail.html");
const storeUi = read("store-detail.js");
const css = read("styles.css");
const migration = read("database/migrations/056_experience_quota_column_ambiguity.sql");
const consoleMigration = read("database/cloudbase-console/056-01-experience-quota-column-ambiguity.sql");

assert.match(customerUi, /const canReadPhoto\s*=\s*\["hq",\s*"store",\s*"teacher"\]\.includes\(session\?\.role\)/,
  "a teacher linked by an approved verification may request the customer profile photo");
assert.match(customerHtml, /customer-profile\.js\?v=0\.15\.13/);

const photoSource = cloud.slice(cloud.indexOf("async function getCustomerPhotoUrl"), cloud.indexOf("async function getCustomerPhotoUploadIntent"));
assert.match(photoSource, /await activeCustomerProfileCaller\(\)/,
  "photo reads use the teacher-aware profile caller");
assert.match(photoSource, /customerProfileScope\(caller, "c"\)/,
  "teacher photo reads remain restricted to approved normal or experience relationships");

const noteSource = cloud.slice(cloud.indexOf("async function updateCustomerNotes"), cloud.indexOf("async function listCustomerMessages"));
assert.match(noteSource, /UPDATE public\.customers AS c/,
  "notes update declares the alias used by the teacher customer scope");
assert.match(noteSource, /customerProfileScope\(caller, "c"\)/,
  "note writes use the same linked-customer scope");
assert.match(noteSource, /COALESCE\(c\.notes, ''\)/,
  "the updated customer row is fully qualified");

for (const sql of [migration, consoleMigration]) {
  assert.match(sql, /WHERE quota_row\.teacher_id = p_teacher_id[\s\S]*quota_row\.product_id = p_product_id[\s\S]*quota_row\.quota_status = 'ACTIVE'/,
    "experience quota lookup qualifies every formerly ambiguous output-column name");
  assert.match(sql, /UPDATE public\.teacher_product_experience_quotas AS quota_row[\s\S]*quota_row\.available_count - 1[\s\S]*WHERE quota_row\.id = quota\.id/,
    "experience quota decrement is explicitly qualified and atomic");
  assert.doesNotMatch(sql, /\n\s*WHERE teacher_id = p_teacher_id/,
    "the repaired function contains no ambiguous teacher_id reference");
}

for (const html of [teacherHtml, storeHtml]) {
  assert.match(html, />时间范围与业务汇总</,
    "teacher and store use one summary title");
  assert.match(html, /<th scope="col">产品<\/th><th scope="col">核销<\/th><th scope="col">充值<\/th><th scope="col">体验<\/th><th scope="col">退费<\/th>/,
    "teacher and store use the same project-by-business matrix");
  assert.match(html, />活跃用户<\/h2>/);
  assert.match(html, />封存用户<\/h2>/);
  assert.match(html, /<th>姓名<\/th><th>门店<\/th><th>生日<\/th><th>充值次数<\/th><th>核销次数<\/th>/,
    "teacher and store customer lists use identical columns");
}
assert.ok(teacherHtml.indexOf('id="teacherBusinessDetails"') < teacherHtml.indexOf('id="teacherActiveCustomersTitle"'),
  "teacher detail page follows its summary and precedes customer lists");
assert.ok(storeHtml.indexOf('id="storeBusinessDetails"') < storeHtml.indexOf('id="storeActiveCustomersTitle"'),
  "store detail page follows its summary and precedes customer lists");
assert.doesNotMatch(storeHtml, /体验项目剩余次数|teacherQuota|storeProjects/,
  "store layout excludes the teacher-specific quota panel and the superseded project table");
assert.match(storeUi, /analyticsPreset: "MONTH"/);
assert.match(storeUi, /state\.analyticsPreset === "ALL"\) return \{\}/);
assert.match(css, /body\[data-store-dashboard\] \.teacher-overview-heading h2 \{[^}]*white-space: nowrap/,
  "store summary title follows the same one-line mobile rule as teacher");
assert.match(css, /\.teacher-summary-scroll \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;[^}]*clip-path: inset/,
  "mobile summary content is clipped inside its own horizontal scroller");
assert.match(css, /\.teacher-summary-matrix tbody th \{ position: static;[^}]*box-shadow: none;/,
  "the first matrix column scrolls away on phones instead of leaking over the left edge");

console.log("teacher customer access and experience repair contract: PASS");
