"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const migrations = path.join(root, "database", "migrations");
const output = path.join(root, "database", "cloudbase-console");

function bodyOf(filename) {
  const source = fs.readFileSync(path.join(migrations, filename), "utf8").replace(/\r\n/g, "\n");
  const begin = source.indexOf("BEGIN;");
  const commit = source.lastIndexOf("\nCOMMIT;");
  if (begin < 0 || commit < 0 || commit <= begin) throw new Error(`${filename} transaction wrapper was not found`);
  return source.slice(begin + "BEGIN;".length, commit).trim();
}

function splitAt(source, markers) {
  const offsets = markers.map((marker) => {
    const offset = source.indexOf(marker);
    if (offset < 0) throw new Error(`split marker was not found: ${marker}`);
    return offset;
  });
  return offsets.map((offset, index) => source.slice(offset, offsets[index + 1] ?? source.length).trim());
}

function writePart(filename, migration, part, description, body) {
  const header = [
    `-- CloudBase SQL editor migration ${migration}, part ${part}.`,
    `-- ${description}`,
    "-- Run this file by itself. Continue only after COMMIT succeeds.",
    "-- After pasting, press Ctrl+A in the editor so the entire short file is selected.",
    "-- If the editor is already in an aborted transaction, run ROLLBACK;",
    "-- separately before running this file. Do not prepend ROLLBACK here.",
    "BEGIN;",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(output, filename), `${header}${body}\n\nCOMMIT;\n`, "utf8");
}

// The CloudBase console size ceiling applies to a complete pasted request.
// Migration 046 contains one deliberately large but editor-safe atomic
// function, so its headers stay compact and leave room for that statement.
function writeCompactPart(filename, migration, part, body) {
  const header = `-- CloudBase migration ${migration}, part ${part}. Run this file by itself.\nBEGIN;\n`;
  fs.writeFileSync(path.join(output, filename), `${header}${body}\n\nCOMMIT;\n`, "utf8");
}

fs.mkdirSync(output, { recursive: true });

const migration037 = bodyOf("037_verification_photo_evidence.sql");
const parts037 = splitAt(migration037, [
  "-- Verification photo evidence is stored",
  "CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo(",
  "CREATE OR REPLACE FUNCTION public.upsert_verification_extra_photo("
]);
writePart("037-01-photo-schema-and-guard.sql", "037", "1 / 3", "Create private photo tables, indexes, permissions and the write guard.", parts037[0]);
writePart("037-02-create-verification-function.sql", "037", "2 / 3", "Create the atomic verification-and-face-photo function.", parts037[1]);
writePart("037-03-extra-photo-function.sql", "037", "3 / 3", "Create the supplemental-photo function, revoke public access and add comments.", parts037[2]);

const migration038 = bodyOf("038_verification_profile_photo_snapshot.sql");
const parts038 = splitAt(migration038, [
  "-- Run after migration 037.",
  "CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo(",
  "CREATE OR REPLACE FUNCTION public.upsert_verification_extra_photo("
]);
writePart("038-01-five-slot-schema-upgrade.sql", "038", "1 / 3", "Upgrade to five slots, snapshot retained photos, rebuild constraints and the write guard.", parts038[0]);
writePart("038-02-create-verification-function.sql", "038", "2 / 3", "Replace the atomic function with retained-profile and face-photo binding.", parts038[1]);
writePart("038-03-extra-photo-function.sql", "038", "3 / 3", "Replace the supplemental-photo function, revoke public access and add comments.", parts038[2]);

const migration046 = bodyOf("046_teacher_face_and_experience_quotas.sql");
const parts046 = splitAt(migration046, [
  "DO $$\nBEGIN\n  IF TO_REGCLASS('public.staff_accounts')",
  "-- Ensure every teacher login account owns one actual teacher master row",
  "CREATE TABLE IF NOT EXISTS public.teacher_product_experience_quotas",
  "CREATE OR REPLACE FUNCTION public.teacher_experience_quota_month",
  "CREATE OR REPLACE FUNCTION public.recharge_teacher_product_experience_quota",
  "-- Final order-state authority.",
  "CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo",
  "REVOKE ALL ON FUNCTION public.teacher_experience_quota_month"
]);
const part046Names = [
  "046-01-teacher-face-schema.sql",
  "046-02-teacher-profile-bridge.sql",
  "046-03-experience-quota-tables.sql",
  "046-04-experience-reset-and-config.sql",
  "046-05-experience-recharge.sql",
  "046-06-order-guards-and-helpers.sql",
  "046-07-experience-verification-function.sql",
  "046-08-permissions-and-comments.sql"
];
parts046.forEach((part, index) => writeCompactPart(part046Names[index], "046", `${index + 1} / ${parts046.length}`, part));

// Migration 048 changes teacher face enrollment to optional and adds the
// archive/reconfigure lifecycle for experience entitlements.  Keep each
// CloudBase paste well below the console request ceiling while preserving the
// canonical migration body exactly in numbered deployment order.
const migration048 = bodyOf("048_optional_teacher_face_and_experience_quota_lifecycle.sql");
const parts048 = splitAt(migration048, [
  "DO $$\nBEGIN\n  IF TO_REGCLASS('public.staff_accounts')",
  "-- A face is an optional identity profile attribute.",
  "-- Every configuration is an immediate replacement",
  "CREATE OR REPLACE FUNCTION public.recharge_teacher_product_experience_quota",
  "-- These order-level predicates",
  "-- create_verification_with_face_photo locks",
  "REVOKE ALL ON FUNCTION public.sync_teacher_profile"
]);
const part048Names = [
  "048-01-quota-lifecycle-schema.sql",
  "048-02-optional-teacher-face-and-resets.sql",
  "048-03-configure-and-remove-entitlements.sql",
  "048-04-recharge-active-entitlements.sql",
  "048-05-active-order-master-data.sql",
  "048-06-experience-usage-guard-and-permissions.sql",
  "048-07-comments.sql"
];
parts048.forEach((part, index) => writeCompactPart(part048Names[index], "048", `${index + 1} / ${parts048.length}`, part));

// Migration 049 must use the stricter field-observed console ceiling. Keep
// every complete transaction (including CRLF expansion) below 3.5 KB and never
// split a dollar-quoted function body across files.
const migration049 = bodyOf("049_teacher_experience_face_subject_and_quota_fixes.sql");
const parts049 = splitAt(migration049, [
  "DO $$\nBEGIN\n  IF TO_REGCLASS('public.teacher_product_experience_quotas')",
  "DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_constraint",
  "CREATE OR REPLACE FUNCTION public.enforce_verification_face_subject",
  "CREATE OR REPLACE FUNCTION public.assert_experience_verification_complete",
  "CREATE OR REPLACE FUNCTION public.upsert_teacher_product_experience_quota",
  "CREATE OR REPLACE FUNCTION public.delete_teacher_product_experience_quota",
  "CREATE OR REPLACE FUNCTION public.lock_active_teacher_experience_subjects",
  "CREATE OR REPLACE FUNCTION public.consume_teacher_experience_quota",
  "CREATE OR REPLACE FUNCTION public.bind_teacher_experience_face_photos",
  "CREATE OR REPLACE FUNCTION public.find_teacher_experience_verification_replay",
  "CREATE OR REPLACE FUNCTION public.insert_teacher_experience_verification",
  "CREATE OR REPLACE FUNCTION public.create_experience_verification_with_teacher_face_photo",
  "REVOKE ALL ON FUNCTION public.enforce_verification_face_subject"
]);
const part049Names = [
  "049-01-face-subject-schema.sql",
  "049-02-face-subject-constraints.sql",
  "049-03-face-subject-triggers.sql",
  "049-04-experience-completeness-guard.sql",
  "049-05-fix-quota-upsert.sql",
  "049-06-fix-quota-delete.sql",
  "049-07-lock-teacher-face.sql",
  "049-08-consume-teacher-quota.sql",
  "049-09-bind-teacher-photos.sql",
  "049-10-idempotent-replay.sql",
  "049-11-insert-experience.sql",
  "049-12-create-experience.sql",
  "049-13-permissions-and-comments.sql"
];
parts049.forEach((part, index) => {
  const filename = part049Names[index];
  writeCompactPart(filename, "049", `${index + 1} / ${parts049.length}`, part);
  const windowsBytes = Buffer.byteLength(fs.readFileSync(path.join(output, filename), "utf8").replace(/\n/g, "\r\n"), "utf8");
  if (windowsBytes > 3500) throw new Error(`${filename} exceeds the 3500-byte CRLF-safe console limit: ${windowsBytes}`);
});

// Migration 050 repairs legacy teacher-master gaps and replaces the two quota
// functions that remained vulnerable to stale/ambiguous writes.  Its numbered
// CloudBase pastes are generated from the canonical transaction body exactly;
// there is intentionally no separately maintained compact implementation.
const migration050 = bodyOf("050_teacher_profile_repair_and_quota_ambiguity.sql");
const parts050 = splitAt(migration050, [
  "DO $$\nBEGIN\n  IF TO_REGCLASS('public.staff_accounts')",
  "-- Face state never participates in account/profile activation.",
  "CREATE OR REPLACE FUNCTION public.sync_teacher_account_status()",
  "-- One idempotent statement repairs both a missing row",
  "-- Removing a live configuration is a current business action",
  "CREATE OR REPLACE FUNCTION public.recharge_teacher_product_experience_quota(",
  "REVOKE ALL ON FUNCTION public.sync_teacher_profile()"
]);
const part050Names = [
  "050-01-prerequisites.sql",
  "050-02-sync-teacher-profile.sql",
  "050-03-sync-teacher-account-status.sql",
  "050-04-backfill-teacher-profiles.sql",
  "050-05-delete-active-quota.sql",
  "050-06-recharge-qualified.sql",
  "050-07-permissions-comments.sql"
];
parts050.forEach((part, index) => {
  const filename = part050Names[index];
  writeCompactPart(filename, "050", `${index + 1} / ${parts050.length}`, part);
  const windowsBytes = Buffer.byteLength(fs.readFileSync(path.join(output, filename), "utf8").replace(/\n/g, "\r\n"), "utf8");
  if (windowsBytes > 3500) throw new Error(`${filename} exceeds the 3500-byte CRLF-safe console limit: ${windowsBytes}`);
});

// Migration 051 is the durable cancellation/ownership fence for teacher-face
// sagas. Keep the canonical functions intact, but place each statement in its
// own CRLF-safe transaction for the CloudBase editor's observed paste limit.
const migration051 = bodyOf("051_teacher_face_operation_lease.sql");
const parts051 = splitAt(migration051, [
  "DO $$\nBEGIN\n  IF TO_REGCLASS('public.staff_accounts')",
  "CREATE TABLE IF NOT EXISTS public.teacher_face_operations",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_phone",
  "CREATE OR REPLACE FUNCTION public.assert_teacher_face_operation_input(",
  "CREATE OR REPLACE FUNCTION public.acquire_teacher_face_operation(",
  "CREATE OR REPLACE FUNCTION public.bind_teacher_face_operation(",
  "CREATE OR REPLACE FUNCTION public.transition_teacher_face_operation(",
  "CREATE OR REPLACE FUNCTION public.bind_teacher_face_operation_face_id(",
  "CREATE OR REPLACE FUNCTION public.takeover_teacher_face_operation_cleanup(",
  "REVOKE ALL ON TABLE public.teacher_face_operations"
]);
const part051Names = [
  "051-01-prerequisites.sql",
  "051-02-operation-table.sql",
  "051-03-operation-indexes.sql",
  "051-04-input-guard.sql",
  "051-05-acquire-operation.sql",
  "051-06-bind-operation.sql",
  "051-07-transition-operation.sql",
  "051-08-bind-face-id.sql",
  "051-09-takeover-cleanup.sql",
  "051-10-permissions-comments.sql"
];
parts051.forEach((part, index) => {
  const filename = part051Names[index];
  writeCompactPart(filename, "051", `${index + 1} / ${parts051.length}`, part);
  const windowsBytes = Buffer.byteLength(
    fs.readFileSync(path.join(output, filename), "utf8").replace(/\n/g, "\r\n"), "utf8"
  );
  if (windowsBytes > 3500) {
    throw new Error(`${filename} exceeds the 3500-byte CRLF-safe console limit: ${windowsBytes}`);
  }
});

// Migration 053 is the final retirement boundary for the former teacher-face
// Saga. Keep 051/052 files available as immutable historical migrations, but
// current deployments must finish with this single transaction, which removes
// only the obsolete operation table and its six private helper functions.
const migration053 = bodyOf("053_retire_legacy_teacher_face_saga.sql");
writeCompactPart(
  "053-01-retire-legacy-teacher-face-saga.sql",
  "053",
  "1 / 1",
  migration053
);

console.log("CloudBase console migrations generated:", [
  ...parts037, ...parts038, ...parts046, ...parts048, ...parts049, ...parts050, ...parts051,
  migration053
].map((part) => Buffer.byteLength(part, "utf8")));
