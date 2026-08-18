"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const auth = read("auth-ui.js");
const ui = read("store-business.js");
const query = read("verification-query.html");
const queryUi = read("query.js");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const migration = read("database/migrations/041_experience_verification_device_signal.sql");

for (const page of ["verification-experience.html", "teacher-verification-experience.html"]) {
  const html = read(page);
  assert.ok(html.includes('data-store-business="verification-experience"'), `${page} must use experience workflow`);
  assert.ok(html.includes("体验核销"), `${page} must identify experience verification`);
  assert.ok(html.includes("开启设备"), `${page} must say that successful submission starts the device`);
  assert.ok(!html.includes("补录"), `${page} must not expose retired supplemental copy`);
}

assert.ok(!fs.existsSync(path.join(root, "verification-supplemental.html")), "store supplemental creation page must be retired");
assert.ok(!fs.existsSync(path.join(root, "teacher-verification-supplemental.html")), "teacher supplemental creation page must be retired");
assert.ok(auth.includes('["verification-experience.html", "体验核销"]'), "store and HQ navigation must expose experience verification");
assert.ok(auth.includes('["teacher-verification-experience.html", "体验核销"]'), "teacher navigation must expose experience verification");

assert.ok(ui.includes('verificationType: experience ? "EXPERIENCE" : "NORMAL"'), "experience page must submit EXPERIENCE type");
assert.ok(ui.includes('const expectedStatus = "APPROVED"'), "experience submission must complete immediately");
assert.ok(ui.includes("自动完成体验核销并发送设备开启信号"), "experience submission must request device start");
assert.ok(!query.includes('<option value="SUPPLEMENT">'), "query UI must remove supplemental filter");
assert.ok(query.includes('<option value="EXPERIENCE">体验核销</option>'), "query UI must retain experience filter");
assert.ok(!query.includes('id="recordStatusCategory"'), "verification query must not expose a redundant order-status filter");
assert.ok(query.includes('id="recordCategoryGrid"') && query.includes('aria-label="核销原单状态统计" hidden'), "verification status summary cards must stay hidden");
assert.ok(queryUi.includes('const statusCategoryValue = () => $("recordStatusCategory")?.value || "ALL"'), "shared query code must tolerate the intentionally absent verification status filter");

assert.ok(cloud.includes('if (!["NORMAL", "EXPERIENCE"].includes(verificationType))'), "API must reject new supplemental submissions");
assert.ok(cloud.includes('const initialStatus = "APPROVED"'), "API must auto-complete both allowed verification types");
assert.ok(cloud.includes("FROM public.device_signal_outbox"), "API must verify the virtual-port signal was queued");
assert.ok(cloud.includes('port: "VIRTUAL_DEVICE_START"'), "API must return the stable virtual device port");
assert.ok(cloud.includes("FROM public.products p\n                         WHERE p.product_status = 'ACTIVE'"), "query project options must include every active product even without existing records");
assert.ok(cloud.includes('FROM public.${table} product_record'), "query project options must retain archived products that have historical records in scope");
assert.ok(queryUi.includes('product.productStatus || ""'), "query dropdown must distinguish archived historical products");

for (const expected of [
  "CREATE TABLE IF NOT EXISTS public.device_signal_outbox",
  "verification_id BIGINT NOT NULL UNIQUE",
  "normalized_type NOT IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')",
  "CASE WHEN normalized_type = 'SUPPLEMENT' THEN 'PENDING' ELSE 'APPROVED' END",
  "created_record.verification_type IN ('NORMAL', 'EXPERIENCE')",
  "INSERT INTO public.device_signal_outbox"
]) assert.ok(migration.includes(expected), `migration 041 missing ${expected}`);

assert.ok(migration.includes("Historical SUPPLEMENT rows remain reviewable"), "migration must explicitly preserve historical supplemental records");

console.log("experience verification contract: PASS");
