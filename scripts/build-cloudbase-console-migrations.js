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

console.log("CloudBase console migrations generated:", [...parts037, ...parts038, ...parts046].map((part) => Buffer.byteLength(part, "utf8")));
