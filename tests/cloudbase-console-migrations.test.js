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
  "038-03-extra-photo-function.sql",
  "039-01-direct-upload-schema.sql",
  "039-02-begin-upload-function.sql",
  "039-03-commit-upload-function.sql",
  "039-04-cancel-upload-function.sql",
  "039-05-verify-direct-upload.sql"
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
  const canonicalName = ({
    "037": "037_verification_photo_evidence.sql",
    "038": "038_verification_profile_photo_snapshot.sql",
  })[migration];
  const canonical = transactionBody(fs.readFileSync(path.join(root, "database", "migrations", canonicalName), "utf8"));
  const reconstructed = parts
    .filter((filename) => filename.startsWith(`${migration}-`) && !filename.includes("-verify-"))
    .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
    .join("\n\n");
  assert.equal(reconstructed, canonical, `CloudBase parts must reconstruct migration ${migration} exactly`);
}

const directParts = Object.fromEntries(
  parts.filter((filename) => filename.startsWith("039-")).map((filename) => [
    filename,
    fs.readFileSync(path.join(consoleDir, filename), "utf8")
  ])
);
function normalizedExecutableSql(source) {
  return transactionBody(source)
    .replace(/^\s*--.*$/gm, "")
    // Console parts revoke each function immediately after creating it,
    // whereas the canonical migration groups the same revokes at the end.
    .replace(/REVOKE ALL ON FUNCTION public\.[\s\S]*?FROM PUBLIC;/g, "")
    .replace(/\s+/g, "");
}
const canonical039 = normalizedExecutableSql(
  fs.readFileSync(path.join(root, "database", "migrations", "039_direct_verification_photo_upload.sql"), "utf8")
);
const reconstructed039 = [
  "039-01-direct-upload-schema.sql",
  "039-02-begin-upload-function.sql",
  "039-03-commit-upload-function.sql",
  "039-04-cancel-upload-function.sql"
].map((filename) => normalizedExecutableSql(directParts[filename])).join("");
assert.equal(reconstructed039, canonical039, "039-01 through 039-04 preserve the canonical executable SQL in deployment order");

for (const [filename, expected] of [
  ["039-01-direct-upload-schema.sql", [
    "verification_photo_upload_requests", "uq_verification_photo_upload_one_active_order",
    "ENABLE ROW LEVEL SECURITY", "verification_photos_metadata_v39_check"
  ]],
  ["039-02-begin-upload-function.sql", [
    "begin_verification_photo_upload", "only the verification submitter may upload photo evidence",
    "INTERVAL '24 hours'", "request_matches", "PHOTO_UPLOAD_RATE_LIMITED", "/direct-%.jpg"
  ]],
  ["039-03-commit-upload-function.sql", [
    "commit_verification_photo_upload", "status = 'COMMITTED'", "('CANCELLED', 'EXPIRED')",
    "expected_original_bytes", "INSERT INTO public.verification_photos", "INTERVAL '24 hours'"
  ]],
  ["039-04-cancel-upload-function.sql", [
    "cancel_verification_photo_upload", "only the verification submitter may cancel photo uploads",
    "status = 'UPLOADING'", "status = 'CANCELLED'", "FOR UPDATE"
  ]]
]) {
  for (const contract of expected) {
    assert.ok(directParts[filename].includes(contract), `${filename} must preserve migration 039 contract ${contract}`);
  }
}

for (const filename of [
  "037-02-create-verification-function.sql",
  "038-02-create-verification-function.sql"
]) {
  const source = fs.readFileSync(path.join(consoleDir, filename), "utf8");
  assert.ok(
    source.includes("normalized_status <> (CASE WHEN normalized_type = 'NORMAL' THEN 'APPROVED' ELSE 'PENDING' END) THEN"),
    `${filename} must parenthesize the CASE expression before PL/pgSQL THEN`
  );
}

const verification = fs.readFileSync(path.join(consoleDir, "038-04-verify-photo-migrations.sql"), "utf8");
assert.ok(verification.includes("create_function_ready"));
assert.ok(verification.includes("verification_photos_slot_v38_check"));
assert.ok(verification.includes("trg_enforce_verification_photo_write"));

const directVerification = fs.readFileSync(path.join(consoleDir, "039-05-verify-direct-upload.sql"), "utf8");
assert.ok(directVerification.includes("verification_photo_upload_requests"));
assert.ok(directVerification.includes("begin_verification_photo_upload"));
assert.ok(directVerification.includes("commit_verification_photo_upload"));
assert.ok(directVerification.includes("cancel_verification_photo_upload"));
assert.ok(directVerification.includes("uq_verification_photo_upload_one_active_order"));
assert.ok(directVerification.includes("verification_photos_metadata_v39_check"));

console.log("cloudbase console migrations: PASS");
