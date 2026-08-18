"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const faceService = read("cloudfunctions/faceRecognition/index.js");
const photoWrapper = read("cloudfunctions/verificationPhoto/index.js");
const photoDeployWrapper = read("cloudfunctions/verificationPhoto/deploy-index.js");
const photoPackage = JSON.parse(read("cloudfunctions/verificationPhoto/package.json"));
const migration039 = read("database/migrations/039_direct_verification_photo_upload.sql");

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
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

function mainSource(source) {
  const start = source.indexOf("exports.main = async (event = {}, context = {}) => {");
  assert.ok(start >= 0, "cloud function main dispatcher must exist");
  return source.slice(start);
}

// The source and deployment wrappers must select photo-only mode before the
// shared implementation is loaded. The deployment package deliberately omits
// the Tencent IAI SDK, so a photo request cannot pay its install/load cost.
for (const [label, wrapper, requiredService] of [
  ["source", photoWrapper, "../faceRecognition/index.js"],
  ["deployment", photoDeployWrapper, "./service.js"]
]) {
  const flagIndex = wrapper.indexOf('process.env.VERIFICATION_PHOTO_ONLY_FUNCTION = "1"');
  const requireIndex = wrapper.indexOf(`require("${requiredService}")`);
  assert.ok(flagIndex >= 0, `${label} wrapper must enable photo-only mode`);
  assert.ok(requireIndex > flagIndex, `${label} wrapper must enable photo-only mode before loading the service`);
}
assert.equal(photoPackage.main, "index.js", "deployment entry remains the ZIP-root index.js");
assert.deepEqual(
  Object.keys(photoPackage.dependencies || {}).sort(),
  ["@cloudbase/manager-node", "@cloudbase/node-sdk"],
  "photo-only deployment has only CloudBase database/storage dependencies"
);
assert.ok(!("tencentcloud-sdk-nodejs" in (photoPackage.dependencies || {})), "photo-only deployment excludes the face SDK");
includes(faceService, 'require("tencentcloud-sdk-nodejs").iai.v20200303.Client', "face service still lazily loads IAI for face actions");
assert.ok(
  faceService.indexOf('require("tencentcloud-sdk-nodejs")') > faceService.indexOf("function faceClient()"),
  "the shared service does not load the face SDK at module initialization"
);

// The split reuses migration 039 and the existing atomic intent functions; it
// does not create a second write protocol or require a new schema migration.
const schemaGuard = functionSource(faceService, "requireVerificationPhotoUploadSchema");
for (const contract of [
  "public.verification_photo_upload_requests",
  "public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)",
  "public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)",
  "public.cancel_verification_photo_upload(character varying,bigint,bigint)"
]) includes(schemaGuard, contract, `migration 039 schema guard ${contract}`);
for (const sqlFunction of [
  "begin_verification_photo_upload",
  "commit_verification_photo_upload",
  "cancel_verification_photo_upload"
]) includes(migration039, `CREATE OR REPLACE FUNCTION public.${sqlFunction}`, `migration 039 ${sqlFunction}`);
assert.ok(!/executeSql|CREATE\s+(?:TABLE|FUNCTION)|ALTER\s+TABLE/i.test(photoWrapper), "source wrapper contains no duplicate persistence logic");
assert.ok(!/executeSql|CREATE\s+(?:TABLE|FUNCTION)|ALTER\s+TABLE/i.test(photoDeployWrapper), "deployment wrapper contains no duplicate persistence logic");

// The dedicated dispatcher exposes exactly the photo surface. In particular,
// customer search, face matching/enrollment, recharge, and verification-order
// creation remain in faceRecognition and cannot be reached through this ZIP.
const dispatcher = mainSource(faceService);
const normalActionStart = dispatcher.indexOf('if (action === "validateCapture")');
assert.ok(normalActionStart > 0, "normal face dispatcher must follow photo-only dispatcher");
const photoBranchStart = dispatcher.lastIndexOf("if (PHOTO_ONLY_FUNCTION)", normalActionStart);
assert.ok(photoBranchStart >= 0, "photo-only dispatcher must exist");
const photoBranch = dispatcher.slice(photoBranchStart, normalActionStart);
const dispatchedActions = [...photoBranch.matchAll(/action === "([^"]+)"/g)].map((match) => match[1]);
const allowedActions = [
  "getVerificationPhotos",
  "getVerificationPhotoOriginalUrl",
  "getVerificationPhotoExportData",
  "beginVerificationPhotoUpload",
  "getVerificationPhotoUploadStatus",
  "cancelVerificationPhotoUpload",
  "commitVerificationPhotoUpload",
  "cleanupVerificationPhotoUploads"
];
assert.deepEqual(dispatchedActions, allowedActions, "photo-only action allowlist is exact and ordered");
for (const forbidden of [
  "validateCapture", "registerCustomer", "verifyCustomerFace", "listActiveStoreCustomers",
  "createVerificationApplication", "createRechargeApplication", "getTeacherWorkspace",
  "uploadVerificationExtraPhoto", "cleanupVerificationPhotoDrafts"
]) assert.ok(!photoBranch.includes(`action === "${forbidden}"`), `photo-only dispatcher rejects ${forbidden}`);
includes(photoBranch, 'fail("Unsupported verification photo action.", "ACTION_NOT_FOUND")', "photo-only reject path has a stable error code");

// Execute the real dispatcher body with test doubles. This proves health does
// not demand FACE_GROUP_ID/faceSettings, every allowlisted route is callable,
// and a face route is rejected before its implementation can run.
const routeCalls = [];
let forbiddenFaceCalls = 0;
const routeHarness = {
  exports: {},
  process: {
    env: {
      CUSTOMER_PHOTO_BUCKET_ID: "customer-photos",
      VERIFICATION_PHOTO_BUCKET_ID: "customer-photos",
      VERIFICATION_PHOTO_CLEANUP_TOKEN: "configured",
      CLOUDBASE_APIKEY: "configured"
    }
  },
  console: { error() {} },
  PHOTO_ONLY_FUNCTION: true,
  FUNCTION_VERSION: "v3",
  CLEANUP_TIMER_TRIGGER_NAME: "cleanup-verification-photo-uploads-hourly",
  handleTrustedCleanupTimer: async () => null,
  verificationPhotoCleanupTokenConfigured: () => true,
  cloudbaseServiceRoleKeyConfigured: () => true,
  verificationPhotoStorageHealth: async () => ({
    configuredBucketIds: ["customer-photos"],
    availableBucketIds: ["customer-photos"],
    readyBucketIds: ["customer-photos"],
    bucketMetadataReady: true,
    bucketCheckError: "",
    serviceRoleStorageReady: true,
    serviceRoleStorageError: "",
    serviceRoleStorageRequestId: "request-1"
  }),
  verificationPhotoUploadSchemaHealth: async () => ({ ready: true, error: "" }),
  verificationPhotoUrlTtlSeconds: () => 900,
  verificationPhotoUploadTtlSeconds: () => 600,
  required: () => { throw new Error("photo-only health must not require face configuration"); },
  faceSettings: () => { forbiddenFaceCalls += 1; throw new Error("photo-only health must not read face settings"); },
  validateCapture: async () => { forbiddenFaceCalls += 1; return { forbidden: true }; },
  fail: (message, code) => { const error = new Error(message); error.code = code; throw error; }
};
for (const action of allowedActions) {
  routeHarness[action] = async () => {
    routeCalls.push(action);
    return { ok: true, routed: action };
  };
}
vm.createContext(routeHarness);
vm.runInContext(mainSource(faceService), routeHarness, { filename: "verification-photo-dispatcher.js" });

let schemaHealthRows = [{ has_table: true, has_begin: true, has_commit: true, has_cancel: true }];
let schemaHealthFailure = null;
const schemaHealthHarness = {
  module: { exports: {} },
  executeSql: async () => {
    if (schemaHealthFailure) throw schemaHealthFailure;
    return schemaHealthRows;
  },
  databaseBoolean: (value) => [true, "true", "t", 1, "1"].includes(value)
};
vm.createContext(schemaHealthHarness);
vm.runInContext(
  `${functionSource(faceService, "verificationPhotoUploadSchemaHealth")}\nmodule.exports = verificationPhotoUploadSchemaHealth;`,
  schemaHealthHarness,
  { filename: "verification-photo-schema-health.js" }
);

(async () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(await schemaHealthHarness.module.exports())),
    { ready: true, error: "" },
    "schema health recognizes the complete migration 039 contract"
  );
  schemaHealthRows = [{ has_table: true, has_begin: true, has_commit: false, has_cancel: true }];
  assert.equal((await schemaHealthHarness.module.exports()).ready, false, "a partial migration is not reported ready");
  schemaHealthFailure = Object.assign(new Error("database unavailable"), { code: "DATABASE_UNAVAILABLE" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await schemaHealthHarness.module.exports())),
    { ready: false, error: "DATABASE_UNAVAILABLE" },
    "schema health preserves a stable database diagnostic"
  );

  const health = await routeHarness.exports.main({ action: "health" });
  assert.equal(health.ok, true);
  assert.equal(health.version, "v3");
  assert.equal(health.service, "verificationPhoto");
  assert.equal(health.uploadMode, "FUNCTION");
  assert.equal(health.ready, true);
  assert.equal(health.verificationPhotoBucketMetadataReady, true);
  assert.equal(health.verificationPhotoServiceRoleStorageReady, true);
  assert.equal(health.verificationPhotoUploadSchemaReady, true);
  assert.equal(Object.hasOwn(health, "groupId"), false, "photo-only health omits the face group");
  assert.equal(Object.hasOwn(health, "livenessEnabled"), false, "photo-only health omits face settings");

  routeHarness.verificationPhotoUploadSchemaHealth = async () => ({
    ready: false,
    error: "DATABASE_SCHEMA_MISSING"
  });
  const incompleteHealth = await routeHarness.exports.main({ action: "health" });
  assert.equal(incompleteHealth.ok, true, "a reachable function still returns a diagnostic response");
  assert.equal(incompleteHealth.ready, false, "health is not ready when migration 039 is missing");
  assert.equal(incompleteHealth.verificationPhotoUploadSchemaReady, false);
  assert.equal(incompleteHealth.verificationPhotoUploadSchemaError, "DATABASE_SCHEMA_MISSING");
  routeHarness.verificationPhotoUploadSchemaHealth = async () => ({ ready: true, error: "" });

  for (const action of allowedActions) {
    const response = await routeHarness.exports.main({ action });
    assert.equal(response.routed, action, `${action} routes through the dedicated service`);
  }
  assert.deepEqual(routeCalls, allowedActions, "all and only photo implementations were invoked");

  for (const action of ["validateCapture", "uploadVerificationExtraPhoto", "cleanupVerificationPhotoDrafts"]) {
    const forbidden = await routeHarness.exports.main({ action });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.code, "ACTION_NOT_FOUND", `${action} is unavailable from the photo-only function`);
  }
  assert.equal(forbiddenFaceCalls, 0, "rejected action never invokes face code or face configuration");

  // Exercise begin with PHOTO_ONLY_FUNCTION=true. The intent/owner protocol is
  // unchanged, but no signed browser PUT or fallback bucket probe is attempted.
  const ownerChecks = [];
  const sqlCalls = [];
  let signedPutCalls = 0;
  let fallbackProbeCalls = 0;
  const requestRow = {
    request_id: "vp_1234567890123456",
    request_status: "UPLOADING",
    photo_slot: 2,
    bucket_id: "customer-photos",
    original_object_ref: "pg://customer-photos/records/71/slot-2/direct-proof.jpg",
    expected_original_bytes: 12345,
    expires_at: "2026-08-18T10:10:00Z",
    request_matches: true
  };
  const beginHarness = {
    module: { exports: {} },
    console: { warn() {} },
    crypto,
    PHOTO_ONLY_FUNCTION: true,
    requireVerificationPhotoUploadSchema: async () => {},
    verificationPhotoContext: async () => ({
      verificationId: 71,
      caller: { role: "store", staffId: 9 },
      record: { submitted_by_account_id: 9, editable_until: "2026-08-19T10:00:00Z" },
      canEdit: true
    }),
    requireVerificationPhotoUploadOwner: (_context, options = {}) => ownerChecks.push(options.requireWindow === true),
    verificationPhotoUploadRequestId: () => requestRow.request_id,
    verificationPhotoUploadSlot: () => 2,
    verificationPhotoUploadBytes: () => 12345,
    executeSql: async (sql) => {
      sqlCalls.push(sql);
      return sql.includes("begin_verification_photo_upload") ? [requestRow] : [];
    },
    sqlText: (value) => `'${String(value)}'`,
    availableVerificationPhotoUploadStorage: async () => ({ bucketId: "customer-photos" }),
    verificationPhotoUploadTtlSeconds: () => 600,
    databaseBoolean: (value) => [true, "true", "t", 1, "1"].includes(value),
    verificationPhotoUploadState: (row) => ({
      requestId: row.request_id,
      status: row.request_status,
      slot: row.photo_slot,
      expectedBytes: row.expected_original_bytes,
      expiresAt: row.expires_at
    }),
    verificationPhotoUploadConflict: () => ({ ok: false, code: "PHOTO_UPLOAD_ALREADY_ACTIVE" }),
    signVerificationPhotoUploadReference: async () => { signedPutCalls += 1; throw new Error("must not sign"); },
    signedUploadFunctionFallbackAllowed: () => true,
    requireVerificationPhotoFunctionFallbackStorage: async () => { fallbackProbeCalls += 1; },
    verificationPhotoFunctionUploadProof: () => "a".repeat(64),
    fail: (message, code) => { const error = new Error(message); error.code = code; throw error; }
  };
  vm.createContext(beginHarness);
  vm.runInContext(`${functionSource(faceService, "beginVerificationPhotoUpload")}\nmodule.exports = beginVerificationPhotoUpload;`, beginHarness, {
    filename: "verification-photo-function-begin.js"
  });
  const begin = await beginHarness.module.exports({});
  assert.equal(begin.ok, true);
  assert.equal(begin.uploadMode, "FUNCTION");
  assert.equal(begin.functionUploadProof, "a".repeat(64));
  assert.equal(begin.originalUpload, null);
  assert.equal(begin.thumbnailUpload, null);
  assert.equal(signedPutCalls, 0, "photo-only begin skips signed browser PUT generation");
  assert.equal(fallbackProbeCalls, 0, "photo-only begin does not enter the signed-PUT failure fallback path");
  assert.deepEqual(ownerChecks, [false, true], "begin checks submitter first and the 24-hour window before creating an upload");
  assert.equal(sqlCalls.length, 2, "begin first checks existing work then atomically creates/reuses one intent");
  includes(sqlCalls[1], "public.begin_verification_photo_upload", "begin delegates to migration 039");
  includes(sqlCalls[1], "71::bigint", "begin intent is bound to the order");
  includes(sqlCalls[1], "9::bigint", "begin intent is bound to the submitting staff account");

  console.log("verification-photo-service-split tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Exercise the actual owner/window guard and HMAC capability. A proof is bound
// to request, order, submitter, slot, byte count, and the server-generated ref.
const ownerHarness = {
  module: { exports: {} },
  fail: (message, code) => { const error = new Error(message); error.code = code; throw error; }
};
vm.createContext(ownerHarness);
vm.runInContext(`${functionSource(faceService, "requireVerificationPhotoUploadOwner")}\nmodule.exports = requireVerificationPhotoUploadOwner;`, ownerHarness);
const ownerGuard = ownerHarness.module.exports;
assert.doesNotThrow(() => ownerGuard({ caller: { role: "store", staffId: 9 }, record: { submitted_by_account_id: 9 }, canEdit: true }, { requireWindow: true }));
assert.doesNotThrow(() => ownerGuard({ caller: { role: "teacher", staffId: 9 }, record: { submitted_by_account_id: 9 }, canEdit: true }, { requireWindow: true }));
assert.doesNotThrow(() => ownerGuard({ caller: { role: "hq", staffId: 9 }, record: { submitted_by_account_id: 9 }, canEdit: true }, { requireWindow: true }));
assert.throws(() => ownerGuard({ caller: { role: "operation", staffId: 9 }, record: { submitted_by_account_id: 9 }, canEdit: true }), (error) => error.code === "PHOTO_SUBMITTER_ONLY");
assert.throws(() => ownerGuard({ caller: { role: "hq", staffId: 10 }, record: { submitted_by_account_id: 9 }, canEdit: true }), (error) => error.code === "PHOTO_SUBMITTER_ONLY");
assert.throws(() => ownerGuard({ caller: { role: "store", staffId: 10 }, record: { submitted_by_account_id: 9 }, canEdit: true }), (error) => error.code === "PHOTO_SUBMITTER_ONLY");
assert.throws(() => ownerGuard({ caller: { role: "store", staffId: 9 }, record: { submitted_by_account_id: 9 }, canEdit: false }, { requireWindow: true }), (error) => error.code === "PHOTO_WINDOW_EXPIRED");

const proofHarness = {
  module: { exports: {} },
  crypto,
  Buffer,
  cloudbaseServiceRoleKey: () => "test-service-role-secret",
  fail: (message, code) => { const error = new Error(message); error.code = code; throw error; }
};
vm.createContext(proofHarness);
vm.runInContext([
  functionSource(faceService, "verificationPhotoFunctionUploadProof"),
  functionSource(faceService, "requireVerificationPhotoFunctionUploadProof"),
  "module.exports = { verificationPhotoFunctionUploadProof, requireVerificationPhotoFunctionUploadProof };"
].join("\n"), proofHarness, { filename: "verification-photo-proof.js" });
const proofContext = { verificationId: 71, caller: { staffId: 9 } };
const proofRequest = {
  request_id: "vp_1234567890123456",
  photo_slot: 2,
  expected_original_bytes: 12345,
  original_object_ref: "pg://customer-photos/records/71/slot-2/direct-proof.jpg"
};
const validProof = proofHarness.module.exports.verificationPhotoFunctionUploadProof(proofContext, proofRequest);
assert.match(validProof, /^[a-f0-9]{64}$/);
assert.doesNotThrow(() => proofHarness.module.exports.requireVerificationPhotoFunctionUploadProof(
  { functionUploadProof: validProof }, proofContext, proofRequest
));
for (const [label, context, request] of [
  ["order", { ...proofContext, verificationId: 72 }, proofRequest],
  ["submitter", { verificationId: 71, caller: { staffId: 10 } }, proofRequest],
  ["request", proofContext, { ...proofRequest, request_id: "vp_9999999999999999" }],
  ["slot", proofContext, { ...proofRequest, photo_slot: 3 }],
  ["bytes", proofContext, { ...proofRequest, expected_original_bytes: 12346 }],
  ["object", proofContext, { ...proofRequest, original_object_ref: `${proofRequest.original_object_ref}.forged` }]
]) {
  assert.notEqual(
    proofHarness.module.exports.verificationPhotoFunctionUploadProof(context, request),
    validProof,
    `function upload proof is bound to ${label}`
  );
}
assert.throws(
  () => proofHarness.module.exports.requireVerificationPhotoFunctionUploadProof(
    { functionUploadProof: "0".repeat(64) }, proofContext, proofRequest
  ),
  (error) => error.code === "PHOTO_FUNCTION_UPLOAD_NOT_AUTHORIZED"
);

const commitSource = functionSource(faceService, "commitVerificationPhotoUpload");
assert.ok(
  commitSource.indexOf("verificationPhotoContext(event)") < commitSource.indexOf("verificationPhotoUploadRequestId(event)"),
  "commit resolves the caller-scoped order before the upload request"
);
includes(commitSource, "requireVerificationPhotoUploadOwner(context)", "commit requires the exact submitter");
includes(commitSource, "requireVerificationPhotoUploadOwner(context, { requireWindow: true })", "commit rechecks the 24-hour window");
includes(commitSource, "actor_account_id = ${context.caller.staffId}::bigint", "commit query binds the intent to the caller account");
assert.ok(
  commitSource.indexOf("requireVerificationPhotoFunctionUploadProof(event, context, request)")
    < commitSource.indexOf("cleanVerificationJpeg("),
  "function-upload bytes are rejected before decode/storage unless the HMAC proof is valid"
);
includes(commitSource, "uploadVerificationPhotoReference(request.original_object_ref", "function upload writes only the server-recorded object reference");
includes(commitSource, "public.commit_verification_photo_upload", "commit remains atomic in migration 039");

const cleanupTokenSource = functionSource(faceService, "requireVerificationPhotoCleanupToken");
const cleanupSource = functionSource(faceService, "cleanupVerificationPhotoUploadRequests");
const photoOnlyCleanupRunSource = functionSource(faceService, "runVerificationPhotoUploadsCleanup");
const photoOnlyCleanupSource = functionSource(faceService, "cleanupVerificationPhotoUploads");
includes(cleanupTokenSource, "crypto.timingSafeEqual", "cleanup token is compared in constant time");
includes(photoOnlyCleanupSource, "requireVerificationPhotoCleanupToken(event)", "photo-only cleanup requires its private trigger token");
includes(photoOnlyCleanupSource, "runVerificationPhotoUploadsCleanup()", "manual photo cleanup enters the shared bounded runner");
includes(photoOnlyCleanupRunSource, "cleanupVerificationPhotoUploadRequests()", "photo-only cleanup runner is limited to upload intents");
includes(cleanupSource, "WHERE status IN ('CANCELLED', 'EXPIRED')", "only cancelled or expired upload objects enter cleanup");
includes(cleanupSource, "AND upload.cleanup_after <= CLOCK_TIMESTAMP()", "cleanup waits for the late-upload safety interval");
includes(cleanupSource, "AND upload.objects_cleaned_at IS NULL", "cleanup is idempotent");
includes(cleanupSource, "NOT EXISTS", "cleanup excludes any object reference already bound to photo evidence");
assert.ok(!cleanupSource.includes("DELETE FROM public.verification_photos"), "cleanup never deletes committed photo evidence");
includes(cleanupSource, "WHERE status = 'COMMITTED'", "only old committed intent audit rows are eventually pruned");
