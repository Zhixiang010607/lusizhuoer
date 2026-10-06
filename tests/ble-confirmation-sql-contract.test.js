const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions/faceRecognition/index.js"), "utf8");

test("BLE work confirmation avoids PostgreSQL reserved table aliases", () => {
  const start = cloud.indexOf("async function confirmVerificationBleWorkStarted(event)");
  const end = cloud.indexOf("async function finalizeVerificationApplicationInternal(event)", start);
  assert.ok(start >= 0 && end > start, "BLE confirmation function must remain present");

  const source = cloud.slice(start, end);
  assert.doesNotMatch(
    source,
    /FROM\s+public\.verification_ble_authorizations\s+AS\s+authorization\b/i,
    "authorization is a PostgreSQL reserved keyword and cannot be used as this table alias"
  );
  assert.match(source, /SELECT\s+ble_authorization\.\*/i);
  assert.match(source, /AS\s+ble_authorization\b/i);
  assert.match(source, /ble_authorization\.authorization_token/i);
});
