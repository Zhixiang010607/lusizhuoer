"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const migration = read("database/migrations/037_verification_photo_evidence.sql");
const createUi = read("store-business.js");
const detailUi = read("business-detail.js");
const detailHtml = read("verification-detail.html");

function includes(text, expected, label) {
  assert.ok(text.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

includes(cloud, 'const FUNCTION_VERSION = "v43"', "cloud version");
includes(cloud, "const MAX_VERIFICATION_IMAGE_BYTES = 3 * 1024 * 1024", "original upload limit");
includes(cloud, "const MAX_THUMBNAIL_BYTES = 384 * 1024", "thumbnail upload limit");
includes(cloud, "if (action === \"getVerificationPhotos\")", "thumbnail list action");
includes(cloud, "if (action === \"getVerificationPhotoOriginalUrl\")", "on-demand original action");
includes(cloud, "if (action === \"uploadVerificationExtraPhoto\")", "supplemental upload action");
includes(cloud, "if (action === \"cleanupVerificationPhotoDrafts\")", "draft cleanup action");
includes(cloud, "String(record.submitted_by_account_id) === String(caller.staffId)", "exact submitter check");
includes(cloud, "CLOCK_TIMESTAMP() < v.submitted_at + INTERVAL '24 hours'", "server edit window");
includes(cloud, "v.teacher_id = ${sqlText(caller.teacherId)}::bigint", "teacher view scope");
includes(cloud, "v.store_id = ${Number(caller.storeId)}::bigint", "store view scope");
includes(cloud, "v.verification_type = 'SUPPLEMENT' AND v.void_request_status = 'NONE'", "operation review scope");
includes(cloud, "Promise.allSettled", "parallel and partial-upload handling");
includes(cloud, "crypto.timingSafeEqual", "cleanup token comparison");

const worstCaseEventBytes = Math.ceil((3 * 1024 * 1024 + 384 * 1024) * 4 / 3) + 32 * 1024;
assert.ok(worstCaseEventBytes < 6 * 1024 * 1024, "Base64 upload event must stay under the 6 MB SCF limit");

includes(migration, "photo_slot BETWEEN 0 AND 3", "four database photo slots");
includes(migration, "the face-verification photo is immutable", "immutable face evidence");
includes(migration, "only the verification submitter may upload photo evidence", "database submitter guard");
includes(migration, "order_submitted_at + INTERVAL '24 hours'", "database 24-hour guard");
includes(migration, "CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo", "atomic create function");
includes(migration, "CREATE OR REPLACE FUNCTION public.upsert_verification_extra_photo", "locked upsert function");
includes(migration, "consumed_by_verification_id = created_record.id", "one-time evidence consumption");
includes(migration, "REVOKE ALL ON TABLE public.verification_photos FROM PUBLIC", "photo table is not public");
includes(migration, "VIEW_ORIGINAL", "original-view audit event");

includes(createUi, "verificationFaceEvidenceToken", "face evidence token state");
includes(createUi, 'thumbnailBase64: verificationThumbnailDataUrl', "face thumbnail upload");
includes(createUi, 'faceEvidenceToken: verificationFaceEvidenceToken', "atomic order binding payload");
includes(createUi, 'const VERSION = "0.14.45"', "create UI cache version");

includes(detailUi, 'action: "getVerificationPhotos"', "detail thumbnail request");
includes(detailUi, 'action: "getVerificationPhotoOriginalUrl"', "detail original request");
includes(detailUi, 'action: "uploadVerificationExtraPhoto"', "detail upload request");
includes(detailUi, 'loading="lazy"', "lazy thumbnail loading");
includes(detailUi, 'const VERSION = "0.15.15"', "detail UI cache version");
includes(detailHtml, 'id="verificationPhotoGrid"', "four-slot gallery mount");
includes(detailHtml, 'id="verificationPhotoViewer"', "original image dialog");
includes(detailHtml, 'business-detail.js?v=0.15.15', "detail script cache bust");

for (const page of [
  "customer-create.html", "recharge-create.html", "verification-create.html",
  "verification-supplemental.html", "teacher-recharge-create.html",
  "teacher-verification-create.html", "teacher-verification-supplemental.html"
]) {
  includes(read(page), "store-business.js?v=0.14.45", `${page} create script cache bust`);
}

console.log("verification photo contract: PASS");
