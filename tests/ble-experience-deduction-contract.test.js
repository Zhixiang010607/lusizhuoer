"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const reservation = read("database/migrations/072_ble_authorization_unit_reservation.sql");
const debit = read("database/migrations/064_variable_verification_unit_count.sql");

test("BLE experience verification reserves and finally debits the teacher quota", () => {
  assert.match(reservation, /qualification\.verification_type = 'EXPERIENCE'/);
  assert.match(reservation, /teacher_product_experience_quotas[\s\S]{0,500}FOR UPDATE/);
  assert.match(reservation, /current_available - other_reserved < qualification\.unit_count/);
  assert.match(reservation, /insufficient teacher experience quota for BLE authorization/);
  assert.match(cloud, /await reserveVerificationBleUnits\(qualification\.id\)/);
  assert.match(cloud, /Number\(result\.status\) !== 2/);
  assert.match(cloud, /verificationType: authorization\.verification_type/);
  assert.match(cloud, /finalizeVerificationApplicationInternal/);
  assert.match(cloud, /create_experience_verification_with_customer_face_photo/);
  assert.match(debit, /available_count = quota_row\.available_count - p_unit_count/);
  assert.match(debit, /used_count = quota_row\.used_count \+ p_unit_count/);
  assert.match(debit, /INSERT INTO public\.teacher_experience_quota_usages/);
});
