"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const consoleDir = path.join(root, "database", "cloudbase-console");
const parts = [
  "037-01-photo-schema-and-guard.sql",
  "037-02-create-verification-function.sql",
  "037-03-extra-photo-function.sql",
  "038-01-five-slot-schema-upgrade.sql",
  "038-02-create-verification-function.sql",
  "038-03-extra-photo-function.sql"
];

function transactionBody(source) {
  const begin = source.indexOf("BEGIN;");
  const commit = source.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, "transaction wrapper is required");
  return source.slice(begin + "BEGIN;".length, commit).trim().replace(/\r\n/g, "\n");
}

for (const filename of parts) {
  const source = fs.readFileSync(path.join(consoleDir, filename), "utf8");
  const size = Buffer.byteLength(source, "utf8");
  assert.ok(size < 9000, `${filename} must stay below the SQL editor-safe size, got ${size}`);
  assert.match(source, /BEGIN;[\s\S]*COMMIT;\s*$/, `${filename} must be a complete transaction`);
  assert.ok(!/^ROLLBACK;/m.test(source), `${filename} must not mix recovery with migration SQL`);
  assert.equal((source.match(/\$\$/g) || []).length % 2, 0, `${filename} has an unclosed dollar-quoted block`);
}

for (const migration of ["037", "038"]) {
  const canonicalName = migration === "037"
    ? "037_verification_photo_evidence.sql"
    : "038_verification_profile_photo_snapshot.sql";
  const canonical = transactionBody(fs.readFileSync(path.join(root, "database", "migrations", canonicalName), "utf8"));
  const reconstructed = parts
    .filter((filename) => filename.startsWith(`${migration}-`))
    .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
    .join("\n\n");
  assert.equal(reconstructed, canonical, `CloudBase parts must reconstruct migration ${migration} exactly`);
}

const verification = fs.readFileSync(path.join(consoleDir, "038-04-verify-photo-migrations.sql"), "utf8");
assert.ok(verification.includes("create_function_ready"));
assert.ok(verification.includes("verification_photos_slot_v38_check"));
assert.ok(verification.includes("trg_enforce_verification_photo_write"));

console.log("cloudbase console migrations: PASS");
