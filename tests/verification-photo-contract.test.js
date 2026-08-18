"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const migration037 = read("database/migrations/037_verification_photo_evidence.sql");
const migration038 = read("database/migrations/038_verification_profile_photo_snapshot.sql");
const createUi = read("store-business.js");
const detailUi = read("business-detail.js");
const detailHtml = read("verification-detail.html");
const styles = read("styles.css");

function includes(text, expected, label) {
  assert.ok(text.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", start);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

includes(cloud, 'const FUNCTION_VERSION = "v46"', "cloud version");
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
includes(cloud, "verificationPhotoStorageCandidates", "dedicated and existing private bucket candidates");
includes(cloud, "storageBucketMissing", "missing dedicated bucket detection");
includes(cloud, 'detail.includes("STORAGE_BUCKET_NOT_FOUND")', "exact missing bucket fallback condition");
includes(cloud, '/^(?:face-evidence|records)\\//', "fallback bucket evidence prefix restriction");
includes(cloud, "verificationPhotoFallbackBucketId", "health reports safe fallback bucket");
includes(cloud, "crypto.timingSafeEqual", "cleanup token comparison");
includes(cloud, "thumbnailTransformUrl", "retained profile thumbnail transform");
const verificationSignSource = functionSource(cloud, "signVerificationPhoto");
includes(verificationSignSource, 'typeof manager().storage.signObjects === "function"', "batch signing compatibility fallback");
includes(verificationSignSource, "Verification photo signing returned no HTTPS URL", "safe verification signing diagnostics");
includes(cloud, "allowCustomerProfile: retainedProfile", "profile bucket is allowed only for profile evidence");
includes(cloud, "maxPhotos: 5", "five-photo response contract");
includes(cloud, "slot < 2 || slot > 4", "only three supplemental cloud slots are writable");

const worstCaseEventBytes = Math.ceil((3 * 1024 * 1024 + 384 * 1024) * 4 / 3) + 32 * 1024;
assert.ok(worstCaseEventBytes < 6 * 1024 * 1024, "Base64 upload event must stay under the 6 MB SCF limit");

const storageCalls = [];
let uploadFailure = null;
const storageHarness = {
  module: { exports: {} },
  console: { warn() {} },
  verificationPhotoStorageSettings: () => ({ bucketId: "verification-photos", accessToken: "token", envId: "env" }),
  photoStorageSettings: () => ({ bucketId: "customer-photos", accessToken: "token", envId: "env" }),
  manager: () => ({
    storage: {
      uploadObject: async ({ bucketId }) => {
        storageCalls.push(bucketId);
        if (bucketId === "verification-photos" && uploadFailure) throw uploadFailure;
      }
    }
  })
};
vm.createContext(storageHarness);
vm.runInContext([
  functionSource(cloud, "verificationPhotoStorageCandidates"),
  functionSource(cloud, "storageBucketMissing"),
  functionSource(cloud, "uploadVerificationPhotoObject"),
  functionSource(cloud, "verificationPhotoStorageForEvidence"),
  "module.exports = { verificationPhotoStorageCandidates, storageBucketMissing, uploadVerificationPhotoObject, verificationPhotoStorageForEvidence };"
].join("\n"), storageHarness, { filename: "verification-storage-fallback.js" });
const storageApi = storageHarness.module.exports;

assert.deepEqual(
  Array.from(storageApi.verificationPhotoStorageCandidates(), (item) => item.bucketId),
  ["verification-photos", "customer-photos"],
  "dedicated storage is attempted before the existing private customer bucket"
);
assert.equal(storageApi.storageBucketMissing({ code: "STORAGE_BUCKET_NOT_FOUND" }), true);
assert.equal(storageApi.storageBucketMissing({ code: "STORAGE_OBJECT_NOT_FOUND" }), false);

const storageFallbackTestPromise = (async () => {
  uploadFailure = Object.assign(new Error("Bucket not found"), { code: "STORAGE_BUCKET_NOT_FOUND" });
  storageCalls.length = 0;
  const fallbackUpload = await storageApi.uploadVerificationPhotoObject("face-evidence/7/8/token/original.jpg", Buffer.from("jpeg"));
  assert.deepEqual(storageCalls, ["verification-photos", "customer-photos"], "missing dedicated bucket falls back exactly once");
  assert.equal(fallbackUpload.reference, "pg://customer-photos/face-evidence/7/8/token/original.jpg");

  uploadFailure = Object.assign(new Error("Access denied"), { code: "STORAGE_ACCESS_DENIED" });
  storageCalls.length = 0;
  await assert.rejects(
    storageApi.uploadVerificationPhotoObject("records/9/slot-2/file.jpg", Buffer.from("jpeg")),
    /Access denied/,
    "authorization failures must never fall back"
  );
  assert.deepEqual(storageCalls, ["verification-photos"], "non-missing-bucket errors stop immediately");

  assert.equal(
    storageApi.verificationPhotoStorageForEvidence({ bucketId: "customer-photos", objectName: "records/9/slot-2/file.jpg" }).bucketId,
    "customer-photos"
  );
  assert.equal(
    storageApi.verificationPhotoStorageForEvidence({ bucketId: "customer-photos", objectName: "7/customer-profile.jpg" }),
    null,
    "fallback signing and deletion reject non-evidence customer-photo paths"
  );
})();

const signingCalls = [];
const signingHarness = {
  module: { exports: {} },
  console: { warn() {}, error() {} },
  signedVerificationPhotoCache: new Map(),
  verificationPhotoReference: () => ({ bucketId: "customer-photos", objectName: "records/9/slot-1/thumbnail.jpg" }),
  photoStorageSettings: () => ({ bucketId: "customer-photos", accessToken: "token", envId: "env" }),
  verificationPhotoStorageForEvidence: () => ({ bucketId: "customer-photos", accessToken: "token", envId: "env" }),
  photoObjectCandidates: (_bucket, objectName) => [objectName],
  cachedVerificationPhoto: () => null,
  responseErrorText: () => "",
  storageObjectMissing: () => false,
  safeResponseShape: () => ({}),
  fail: (message, code) => { const error = new Error(message); error.code = code; throw error; },
  manager: () => ({
    storage: {
      signObject: async () => { signingCalls.push("single"); return { data: {} }; },
      signObjects: async () => {
        signingCalls.push("batch");
        return { data: [{ signedURL: "https://example.invalid/private-thumbnail.jpg" }] };
      }
    }
  })
};
vm.createContext(signingHarness);
vm.runInContext([
  functionSource(cloud, "signedPhotoUrl"),
  functionSource(cloud, "thumbnailTransformUrl"),
  verificationSignSource,
  "module.exports = { signVerificationPhoto };"
].join("\n"), signingHarness, { filename: "verification-storage-signing.js" });
const verificationSignTestPromise = (async () => {
  const signedUrl = await signingHarness.module.exports.signVerificationPhoto(
    "pg://customer-photos/records/9/slot-1/thumbnail.jpg",
    300
  );
  assert.equal(signedUrl, "https://example.invalid/private-thumbnail.jpg");
  assert.deepEqual(signingCalls, ["single", "batch"], "empty single response falls back to batch signing once");
})();

includes(migration037, "photo_slot BETWEEN 0 AND 3", "initial four-slot migration");
includes(migration037, "the face-verification photo is immutable", "initial immutable face evidence");
includes(migration037, "REVOKE ALL ON TABLE public.verification_photos FROM PUBLIC", "photo table is not public");
includes(migration038, "photo_slot BETWEEN 0 AND 4", "five database photo slots");
includes(migration038, "photo_slot = 0 AND photo_kind = 'PROFILE'", "retained profile slot");
includes(migration038, "photo_slot = 1 AND photo_kind = 'FACE'", "current face slot");
includes(migration038, "photo_slot BETWEEN 2 AND 4 AND photo_kind = 'EXTRA'", "three supplemental slots");
includes(migration038, "retained profile and face-verification photos are immutable", "two immutable evidence positions");
includes(migration038, "only the verification submitter may upload photo evidence", "database submitter guard");
includes(migration038, "order_submitted_at + INTERVAL '24 hours'", "database 24-hour guard");
includes(migration038, "CREATE OR REPLACE FUNCTION public.create_verification_with_face_photo", "atomic create function");
includes(migration038, "CREATE OR REPLACE FUNCTION public.upsert_verification_extra_photo", "locked upsert function");
includes(migration038, "consumed_by_verification_id = created_record.id", "one-time evidence consumption");
includes(migration038, "c.profile_photo_file_id", "profile reference snapshot");
includes(migration038, "'PROFILE_BOUND'", "profile binding audit event");
includes(migration038, "VIEW_ORIGINAL", "original-view audit remains allowed");
for (const [from, to] of [[3, 4], [2, 3], [1, 2], [0, 1]]) {
  includes(migration038, `SET photo_slot = ${to} WHERE photo_slot = ${from}`, `safe historical slot shift ${from}->${to}`);
}
assert.ok(
  migration038.indexOf("DROP TRIGGER IF EXISTS trg_enforce_verification_photo_write")
    < migration038.indexOf("UPDATE public.verification_photos SET photo_slot = 4"),
  "historical slot migration must disable the immutable-photo trigger first"
);
assert.ok(
  migration038.indexOf("CREATE TRIGGER trg_enforce_verification_photo_write")
    > migration038.indexOf("CREATE OR REPLACE FUNCTION public.enforce_verification_photo_write"),
  "database write guard must be restored after the slot migration"
);

includes(createUi, "verificationFaceEvidenceToken", "face evidence token state");
includes(createUi, 'thumbnailBase64: verificationThumbnailDataUrl', "face thumbnail upload");
includes(createUi, 'faceEvidenceToken: verificationFaceEvidenceToken', "atomic order binding payload");
includes(createUi, 'const VERSION = "0.14.45"', "create UI cache version");

includes(detailUi, 'action: "getVerificationPhotos"', "detail thumbnail request");
includes(detailUi, 'action: "getVerificationPhotoOriginalUrl"', "detail original request");
includes(detailUi, 'action: "uploadVerificationExtraPhoto"', "detail upload request");
includes(detailUi, 'loading="lazy"', "lazy thumbnail loading");
includes(detailUi, 'const VERSION = "0.15.19"', "detail UI cache version");
includes(detailUi, 'return "客户原始留存照"', "retained profile label");
includes(detailUi, 'return "本次核销人脸照"', "current face label");
includes(detailUi, "Array.from({ length: 5 }", "five-card gallery");
includes(detailUi, "slot >= 2", "immutable profile and face UI positions");
includes(detailUi, "data-capture-verification-photo", "separate camera action");
includes(detailUi, "data-upload-verification-photo", "separate file upload action");
includes(detailUi, 'if (source === "camera") input.setAttribute("capture", "environment")', "camera-only capture hint");
includes(detailHtml, 'id="verificationPhotoGrid"', "five-slot gallery mount");
includes(detailHtml, 'id="verificationPhotoViewer"', "original image dialog");
includes(detailHtml, 'business-detail.js?v=0.15.19', "detail script cache bust");
includes(detailHtml, 'styles.css?v=0.15.17', "detail styles cache bust");
includes(styles, "grid-template-columns: repeat(3, minmax(0, 1fr))", "roomy three-column desktop gallery");
includes(styles, ".verification-photo-actions", "separate camera and upload action layout");

for (const page of [
  "customer-create.html", "recharge-create.html", "verification-create.html",
  "verification-supplemental.html", "teacher-recharge-create.html",
  "teacher-verification-create.html", "teacher-verification-supplemental.html"
]) {
  includes(read(page), "store-business.js?v=0.14.45", `${page} create script cache bust`);
}

Promise.all([storageFallbackTestPromise, verificationSignTestPromise])
  .then(() => console.log("verification photo contract: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
