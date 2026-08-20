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
  "039-05-verify-direct-upload.sql",
  "040-01-fix-verification-photo-commit-ambiguity.sql",
  "041-01-experience-device-port.sql",
  "041-02-experience-create-function.sql",
  "042-01-customer-messages.sql",
  "043-01-disable-recharge-void.sql",
  "044-01-refund-schema-and-balance.sql",
  "044-02-refund-review-and-guards.sql",
  "045-01-product-receipt-templates.sql"
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

const canonical041 = transactionBody(fs.readFileSync(
  path.join(root, "database", "migrations", "041_experience_verification_device_signal.sql"),
  "utf8"
));
const reconstructed041 = parts
  .filter((filename) => filename.startsWith("041-"))
  .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
  .join("\n\n");
assert.equal(reconstructed041, canonical041, "CloudBase parts must reconstruct migration 041 exactly");

const canonical042 = transactionBody(fs.readFileSync(
  path.join(root, "database", "migrations", "042_customer_messages.sql"),
  "utf8"
));
const reconstructed042 = parts
  .filter((filename) => filename.startsWith("042-"))
  .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
  .join("\n\n");
assert.equal(reconstructed042, canonical042, "CloudBase migration 042 must match the canonical customer-message migration");

const canonical043 = transactionBody(fs.readFileSync(
  path.join(root, "database", "migrations", "043_disable_recharge_void_workflow.sql"),
  "utf8"
));
const reconstructed043 = parts
  .filter((filename) => filename.startsWith("043-"))
  .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
  .join("\n\n");
assert.equal(reconstructed043, canonical043, "CloudBase migration 043 must match the canonical recharge-void retirement migration");

const canonical044 = transactionBody(fs.readFileSync(
  path.join(root, "database", "migrations", "044_refund_application_workflow.sql"),
  "utf8"
));
const reconstructed044 = parts
  .filter((filename) => filename.startsWith("044-"))
  .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
  .join("\n\n");
assert.equal(reconstructed044, canonical044, "CloudBase migration 044 must match the canonical refund workflow migration");

const canonical045 = transactionBody(fs.readFileSync(
  path.join(root, "database", "migrations", "045_product_receipt_templates.sql"),
  "utf8"
));
const reconstructed045 = parts
  .filter((filename) => filename.startsWith("045-"))
  .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
  .join("\n\n");
assert.equal(reconstructed045, canonical045, "CloudBase migration 045 must match the canonical product-template migration");

// 046 is deliberately large because it includes the face-bound teacher
// profile bridge, quota ledgers, atomic EXPERIENCE debit, and archive guards.
// It therefore deploys as numbered SQL-editor-safe transactions; their bodies
// must still reproduce the canonical migration exactly and in order.
const canonical046 = transactionBody(fs.readFileSync(
  path.join(root, "database", "migrations", "046_teacher_face_and_experience_quotas.sql"),
  "utf8"
));
const parts046 = fs.readdirSync(consoleDir)
  .filter((filename) => /^046-\d{2}-.+\.sql$/.test(filename))
  .sort();
assert.ok(parts046.length >= 2, "046 must be split into numbered CloudBase SQL-editor transactions");
for (const filename of parts046) {
  const source = fs.readFileSync(path.join(consoleDir, filename), "utf8");
  assert.ok(Buffer.byteLength(source, "utf8") < 9000, `${filename} must stay below the SQL editor-safe size`);
  assert.match(source, /BEGIN;[\s\S]*COMMIT;\s*$/, `${filename} must be a complete transaction`);
  assert.equal((source.match(/\$\$/g) || []).length % 2, 0, `${filename} has an unclosed dollar-quoted block`);
}
const reconstructed046 = parts046
  .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
  .join("\n\n");
assert.equal(reconstructed046, canonical046, "CloudBase parts must reconstruct migration 046 exactly");

// 047 retires the legacy operation role without deleting its historical audit
// rows. It is split because the CloudBase SQL console has a per-paste size
// limit; preserve the exact canonical body and deployment order.
const canonical047 = transactionBody(fs.readFileSync(
  path.join(root, "database", "migrations", "047_retire_operation_accounts.sql"),
  "utf8"
));
const parts047 = fs.readdirSync(consoleDir)
  .filter((filename) => /^047-\d{2}-.+\.sql$/.test(filename))
  .sort();
assert.deepEqual(
  parts047,
  ["047-01-retire-operation-accounts.sql", "047-02-hq-reviewer-guard.sql"],
  "047 must have exactly two ordered CloudBase SQL-editor transactions"
);
for (const filename of parts047) {
  const source = fs.readFileSync(path.join(consoleDir, filename), "utf8");
  assert.ok(Buffer.byteLength(source, "utf8") < 9000, `${filename} must stay below the SQL editor-safe size`);
  assert.match(source, /BEGIN;[\s\S]*COMMIT;\s*$/, `${filename} must be a complete transaction`);
  assert.ok(!/^ROLLBACK;/m.test(source), `${filename} must not mix recovery with migration SQL`);
  assert.equal((source.match(/\$\$/g) || []).length % 2, 0, `${filename} has an unclosed dollar-quoted block`);
}
const reconstructed047 = parts047
  .map((filename) => transactionBody(fs.readFileSync(path.join(consoleDir, filename), "utf8")))
  .join("\n\n");
assert.equal(reconstructed047, canonical047, "CloudBase parts must reconstruct migration 047 exactly");

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

const commitAmbiguityFix = fs.readFileSync(
  path.join(consoleDir, "040-01-fix-verification-photo-commit-ambiguity.sql"),
  "utf8"
);
const canonicalCommitAmbiguityFix = fs.readFileSync(
  path.join(root, "database", "migrations", "040_fix_verification_photo_commit_ambiguity.sql"),
  "utf8"
);
for (const source of [commitAmbiguityFix, canonicalCommitAmbiguityFix]) {
  assert.ok(source.includes("CREATE OR REPLACE FUNCTION public.commit_verification_photo_upload"));
  assert.ok(source.includes("ON CONFLICT ON CONSTRAINT verification_photos_verification_id_photo_slot_key DO UPDATE"));
  assert.ok(!source.includes("ON CONFLICT (verification_id, photo_slot) DO UPDATE"));
  assert.ok(source.includes("Migration 040:"));
}
assert.equal(
  normalizedExecutableSql(commitAmbiguityFix),
  normalizedExecutableSql(canonicalCommitAmbiguityFix),
  "CloudBase 040 must match the canonical migration executable SQL"
);

console.log("cloudbase console migrations: PASS");
