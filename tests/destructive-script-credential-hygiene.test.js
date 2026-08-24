"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const script = fs.readFileSync(path.join(
  __dirname,
  "..",
  "scripts",
  "clear-database-keep-products-and-three-accounts.sql"
), "utf8");

test("public cleanup stub contains no production identity or destructive allowlist", () => {
  assert.doesNotMatch(script, /\b\d{11,}\b/,
    "phone numbers and CloudBase identity numbers must not be committed");
  assert.doesNotMatch(script, /\b(?:auth_uid|staff_name|teacher_name)\s*=/i,
    "the public file must not carry an exact production-account allowlist");
  assert.doesNotMatch(script, /\b(?:TRUNCATE|DELETE\s+FROM|DROP\s+TABLE)\b/i,
    "the checked-in tripwire must contain no destructive statement");
  assert.match(script, /SAFE PUBLIC-REPOSITORY STUB/);
  assert.match(script, /RAISE EXCEPTION[\s\S]*explicit user confirmation[\s\S]*read-only preview/,
    "running the public stub must fail closed with the required private workflow");
});
