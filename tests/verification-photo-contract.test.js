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

includes(cloud, 'const FUNCTION_VERSION = "v50"', "cloud version");
includes(cloud, "const MAX_VERIFICATION_IMAGE_BYTES = 3 * 1024 * 1024", "original upload limit");
includes(cloud, "const MAX_THUMBNAIL_BYTES = 384 * 1024", "thumbnail upload limit");
includes(cloud, "if (action === \"getVerificationPhotos\")", "thumbnail list action");
includes(cloud, "if (action === \"getVerificationPhotoOriginalUrl\")", "on-demand original action");
includes(cloud, "if (action === \"getVerificationPhotoExportData\")", "CORS-safe export action");
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
includes(functionSource(cloud, "verificationPhotoUrlTtlSeconds"), 'numberSetting("VERIFICATION_PHOTO_URL_TTL_SECONDS", 900, 60, 900)', "private photo URLs default to the bounded 15-minute speed window");
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
  functionSource(cloud, "storageUploadResponseMismatch"),
  functionSource(cloud, "uploadVerificationPhotoObject"),
  functionSource(cloud, "verificationPhotoStorageForEvidence"),
  "module.exports = { verificationPhotoStorageCandidates, storageBucketMissing, storageUploadResponseMismatch, uploadVerificationPhotoObject, verificationPhotoStorageForEvidence };"
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

  uploadFailure = new Error("上传成功但响应格式异常：缺少 Id 或 Key");
  storageCalls.length = 0;
  const recoveredUpload = await storageApi.uploadVerificationPhotoObject("records/9/slot-2/file.jpg", Buffer.from("jpeg"));
  assert.deepEqual(storageCalls, ["verification-photos"], "successful upload response mismatch must not retry into another bucket");
  assert.equal(recoveredUpload.reference, "pg://verification-photos/records/9/slot-2/file.jpg");

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
  functionSource(cloud, "cachedVerificationPhoto"),
  functionSource(cloud, "signedPhotoUrl"),
  functionSource(cloud, "thumbnailTransformUrl"),
  verificationSignSource,
  "module.exports = { signVerificationPhoto };"
].join("\n"), signingHarness, { filename: "verification-storage-signing.js" });
const verificationSignTestPromise = (async () => {
  const signedPhoto = await signingHarness.module.exports.signVerificationPhoto(
    "pg://customer-photos/records/9/slot-1/thumbnail.jpg",
    300
  );
  assert.equal(signedPhoto.url, "https://example.invalid/private-thumbnail.jpg");
  assert.ok(signedPhoto.expiresIn > 0 && signedPhoto.expiresIn <= 300, "signed photo returns its real remaining lifetime");
  const cachedPhoto = await signingHarness.module.exports.signVerificationPhoto(
    "pg://customer-photos/records/9/slot-1/thumbnail.jpg",
    300
  );
  assert.equal(cachedPhoto.url, signedPhoto.url);
  assert.ok(cachedPhoto.expiresIn <= signedPhoto.expiresIn, "cached signing never overstates its remaining lifetime");
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
includes(cloud, "originalUrl,", "authorized list returns short-lived original URL");
includes(cloud, "storageUploadResponseMismatch", "successful CloudBase upload response compatibility");
includes(functionSource(cloud, "uploadVerificationPhotoObject"), "storageUploadResponseMismatch(error)", "verification upload success-shape recovery");
includes(functionSource(cloud, "uploadCustomerPhoto"), "storageUploadResponseMismatch(error)", "customer upload success-shape recovery");
includes(functionSource(cloud, "uploadVerificationExtraPhoto"), "thumbnailError,", "saved upload survives immediate thumbnail-signing failure");
assert.ok(
  functionSource(cloud, "getVerificationPhotoExportData").indexOf("getVerificationPhotoOriginalUrl(event)")
    < functionSource(cloud, "getVerificationPhotoExportData").indexOf("downloadVerificationPhotoBytes("),
  "PDF fallback must authorize and audit the exact photo before server-side download"
);
includes(functionSource(cloud, "downloadVerificationPhotoBytes"), "MAX_IMAGE_BYTES", "PDF fallback response is size bounded");
assert.ok(
  functionSource(cloud, "getVerificationPhotos").indexOf("verificationPhotoContext(event)")
    < functionSource(cloud, "getVerificationPhotos").indexOf("signVerificationPhoto("),
  "original URLs must be signed only after the verification-order permission check"
);
includes(detailUi, 'const VERSION = "0.15.26"', "detail UI cache version");
includes(detailUi, 'return "客户原始留存照"', "retained profile label");
includes(detailUi, 'return "本次核销人脸照"', "current face label");
includes(detailUi, "Array.from({ length: 5 }", "five-card gallery");
includes(detailUi, "slot >= 2", "immutable profile and face UI positions");
includes(detailUi, "data-capture-verification-photo", "separate camera action");
includes(detailUi, "data-upload-verification-photo", "separate file upload action");
includes(detailUi, 'photo ? "从相册替换" : "从相册上传"', "mobile photo-library action label");
includes(detailUi, "navigator.mediaDevices.getUserMedia", "real camera preview API");
includes(detailUi, 'startVerificationPhotoCamera("environment")', "rear camera preference");
includes(detailUi, "nextVerificationCameraFacingMode", "front/rear camera toggle");
includes(detailUi, "releaseVerificationPhotoCameraStream", "camera switch releases old stream");
includes(detailUi, "verificationCameraSwitchBusy", "camera switch concurrency guard");
const cameraStartSource = functionSource(detailUi, "startVerificationPhotoCamera");
const cameraSwitchSource = functionSource(detailUi, "switchVerificationPhotoCamera");
includes(cameraStartSource, "!dialog.open || !verificationCameraTarget", "closed camera dialogs cannot reopen a camera stream");
assert.ok(
  cameraStartSource.indexOf("releaseVerificationPhotoCameraStream()")
    < cameraStartSource.indexOf("navigator.mediaDevices.getUserMedia"),
  "old camera tracks must be released before requesting the other camera"
);
assert.ok(
  cameraStartSource.indexOf("request !== verificationCameraRequest")
    < cameraStartSource.indexOf("verificationCameraStream = stream"),
  "late camera streams must be rejected before becoming active"
);
includes(cameraSwitchSource, "startVerificationPhotoCamera(previousFacingMode)", "failed switch restores previous camera");
includes(cameraSwitchSource, "startVerificationPhotoCamera(nextFacingMode)", "camera switch has an ideal-mode compatibility retry");
const cameraSwitchAliveGuard = "!dialog?.open || verificationCameraTarget !== target";
const firstNextCameraStart = cameraSwitchSource.indexOf("startVerificationPhotoCamera(nextFacingMode, true)");
const secondNextCameraStart = cameraSwitchSource.indexOf("startVerificationPhotoCamera(nextFacingMode)");
assert.ok(
  cameraSwitchSource.indexOf(cameraSwitchAliveGuard) >= 0
    && firstNextCameraStart < cameraSwitchSource.indexOf(cameraSwitchAliveGuard)
    && cameraSwitchSource.indexOf(cameraSwitchAliveGuard) < secondNextCameraStart,
  "closing or retargeting during an exact camera switch must prevent the ideal compatibility retry"
);
assert.ok(
  cameraSwitchSource.lastIndexOf(cameraSwitchAliveGuard) < cameraSwitchSource.indexOf("startVerificationPhotoCamera(previousFacingMode)"),
  "closing or retargeting during a camera switch must prevent reopening the previous camera"
);
includes(cameraSwitchSource, "if (verificationCameraTarget === target) verificationCameraSwitchBusy = false", "an old camera switch cannot clear the busy state of a newly opened photo slot");
includes(cameraStartSource, "cameraCount === 1 && !usesMobilePhotoLibrary()", "mobile and iPad keep the camera switch available when device enumeration is incomplete");
includes(functionSource(detailUi, "captureVerificationPhotoCamera"), "verificationCameraSwitchBusy", "capture is blocked while switching cameras");
includes(detailUi, '$("switchVerificationPhotoCamera")?.addEventListener("click", switchVerificationPhotoCamera)', "camera switch button wiring");
includes(detailUi, "preloadVerificationPhotoOriginal", "small original background preload");
includes(detailUi, "connection?.saveData === true", "data-saver preload guard");
includes(detailUi, "originalUrlExpiresAt", "short-lived original URL expiry guard");
includes(detailUi, 'image.fetchPriority = "high"', "clicked original receives high network priority");
includes(detailUi, 'action: "getVerificationPhotoExportData"', "PDF/image export authorized binary fallback");
includes(detailUi, 'cache: "force-cache"', "export reuses cached signed original when available");
includes(detailUi, "Math.min(3, queue.length)", "at most three private originals export concurrently");
includes(detailUi, "verificationExportBlobCache", "consecutive PDF/JPG exports reuse downloaded originals");
includes(detailUi, "photo?.originalUrlExpiresIn ?? payload?.expiresIn", "client honors each cached URL's real remaining lifetime");
includes(detailUi, "while (verificationPhotoPreloads.size > 2)", "decoded original preload cache is bounded to two images");
const originalViewerSource = functionSource(detailUi, "openVerificationPhoto");
assert.ok(
  originalViewerSource.indexOf("showVerificationPhotoOriginal(cachedOriginalUrl")
    < originalViewerSource.indexOf('callFaceRecognition({ action: "getVerificationPhotoOriginalUrl"'),
  "cached private originals begin decoding before the background audit request"
);
includes(detailUi, "if (failures.length)", "existing photo failures block incomplete exports");
const exportPhotosSource = functionSource(detailUi, "verificationExportPhotos");
assert.ok(
  exportPhotosSource.indexOf("fetchVerificationPhotoManifest(recordId)")
    < exportPhotosSource.indexOf("const available = new Map"),
  "database photo manifest must be refreshed before deciding which slots are empty"
);
includes(exportPhotosSource, "verificationPhotoManifestSignature(confirmedManifest) !== manifestSignature", "editable photo manifest is rechecked after downloads");
includes(functionSource(detailUi, "fetchVerificationPhotoManifest"), "payload?.ok !== true || !Array.isArray(payload?.photos)", "null/loading manifest cannot be treated as five empty slots");
includes(functionSource(detailUi, "uploadVerificationPhoto"), "verificationPhotoLoadPromise = loadVerificationPhotos", "upload refresh is part of the authoritative photo-load promise");
assert.ok(!functionSource(detailUi, "chooseVerificationPhoto").includes("capture"), "gallery/file picker must not force camera capture");
includes(detailHtml, 'id="verificationPhotoGrid"', "five-slot gallery mount");
includes(detailHtml, 'id="verificationPhotoViewer"', "original image dialog");
includes(detailHtml, 'aria-labelledby="verificationPhotoViewerTitle"', "viewer accessible title");
includes(detailHtml, 'id="verificationPhotoOriginalFrame"', "zoomable photo viewport");
includes(detailHtml, 'id="zoomOutVerificationPhoto"', "zoom-out control");
includes(detailHtml, 'id="zoomInVerificationPhoto"', "zoom-in control");
includes(detailHtml, 'id="resetVerificationPhotoZoom"', "fit-to-window control");
includes(detailHtml, 'id="verificationPhotoZoomValue" aria-live="polite"', "announced zoom percentage");
includes(detailHtml, 'id="verificationPhotoCameraDialog"', "camera preview dialog");
includes(detailHtml, 'id="verificationPhotoCameraVideo" autoplay playsinline muted', "mobile inline camera preview");
includes(detailHtml, 'id="switchVerificationPhotoCamera"', "front/rear camera switch action");
includes(detailHtml, 'aria-label="切换前后摄像头"', "camera switch accessible name");
includes(detailHtml, 'order-export.js?v=0.1.1', "export renderer cache bust");
includes(detailHtml, 'business-detail.js?v=0.15.26', "detail script cache bust");
includes(detailHtml, 'styles.css?v=0.15.21', "detail styles cache bust");
includes(styles, "grid-template-columns: repeat(3, minmax(0, 1fr))", "roomy three-column desktop gallery");
includes(styles, ".verification-photo-actions", "separate camera and upload action layout");
includes(styles, ".verification-photo-camera-stage", "camera preview stage styles");
includes(styles, ".verification-photo-camera-stage video.is-user-facing", "front camera mirrored preview");
includes(styles, "grid-template-columns: minmax(0, 1fr) auto auto", "three camera dialog actions");
includes(styles, "touch-action: none", "viewer owns mobile pinch and drag gestures");
includes(styles, "overscroll-behavior: contain", "viewer gestures do not scroll the page behind the dialog");
includes(styles, "will-change: transform", "viewer zoom is compositor accelerated");
includes(styles, "@media (max-height: 680px)", "low-height mobile landscape keeps the viewer inside the dialog");
includes(styles, "min-height: 120px", "very short viewports retain a usable but scroll-safe photo stage");

const viewerHarness = { module: { exports: {} } };
vm.createContext(viewerHarness);
vm.runInContext([
  functionSource(detailUi, "clampVerificationPhotoViewerScale"),
  functionSource(detailUi, "verificationPhotoViewerPointerGeometry"),
  functionSource(detailUi, "verificationPhotoViewerKeyboardAction"),
  "module.exports = { clampVerificationPhotoViewerScale, verificationPhotoViewerPointerGeometry, verificationPhotoViewerKeyboardAction };"
].join("\n"), viewerHarness, { filename: "verification-photo-viewer-contract.js" });
assert.equal(viewerHarness.module.exports.clampVerificationPhotoViewerScale(0.5), 1);
assert.equal(viewerHarness.module.exports.clampVerificationPhotoViewerScale(2.5), 2.5);
assert.equal(viewerHarness.module.exports.clampVerificationPhotoViewerScale(99), 5);
assert.deepEqual(
  JSON.parse(JSON.stringify(viewerHarness.module.exports.verificationPhotoViewerPointerGeometry([{ x: 0, y: 0 }, { x: 3, y: 4 }]))),
  { distance: 5, centerX: 1.5, centerY: 2 },
  "two-pointer zoom geometry"
);
assert.equal(viewerHarness.module.exports.verificationPhotoViewerKeyboardAction("+"), "ZOOM_IN");
assert.equal(viewerHarness.module.exports.verificationPhotoViewerKeyboardAction("-"), "ZOOM_OUT");
assert.equal(viewerHarness.module.exports.verificationPhotoViewerKeyboardAction("0"), "RESET");
assert.equal(viewerHarness.module.exports.verificationPhotoViewerKeyboardAction("ArrowRight"), "PAN_RIGHT");
includes(detailUi, 'addEventListener("pointercancel", handleVerificationPhotoViewerPointerEnd)', "cancelled touch gestures release viewer state");
includes(detailUi, 'addEventListener("lostpointercapture", handleVerificationPhotoViewerPointerEnd)', "system-cancelled pointer capture cannot poison the next gesture");
includes(detailUi, 'addEventListener("wheel", handleVerificationPhotoViewerWheel, { passive: false })', "desktop wheel zoom can prevent page scrolling");
includes(functionSource(detailUi, "resetVerificationPhotoViewerTransform"), "verificationPhotoViewerPointers.clear()", "viewer reset clears all active pointers");
includes(functionSource(detailUi, "resetVerificationPhotoViewerTransform"), "releasePointerCapture(pointerId)", "viewer close/reset releases captured pointers");

const cameraHarness = { module: { exports: {} } };
vm.createContext(cameraHarness);
vm.runInContext([
  functionSource(detailUi, "nextVerificationCameraFacingMode"),
  functionSource(detailUi, "verificationCameraConstraint"),
  "module.exports = { nextVerificationCameraFacingMode, verificationCameraConstraint };"
].join("\n"), cameraHarness, { filename: "verification-camera-contract.js" });
assert.equal(cameraHarness.module.exports.nextVerificationCameraFacingMode("environment"), "user");
assert.equal(cameraHarness.module.exports.nextVerificationCameraFacingMode("user"), "environment");
assert.deepEqual(
  JSON.parse(JSON.stringify(cameraHarness.module.exports.verificationCameraConstraint("user"))),
  { video: { facingMode: { ideal: "user" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
  "front camera constraint"
);
assert.deepEqual(
  JSON.parse(JSON.stringify(cameraHarness.module.exports.verificationCameraConstraint("environment", true))),
  { video: { facingMode: { exact: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
  "exact rear camera switch constraint"
);

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
