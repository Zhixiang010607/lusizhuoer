"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions/faceRecognition/index.js"), "utf8");

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

function throwsCode(fn, code, label) {
  assert.throws(fn, (error) => error?.code === code, label);
}

includes(cloud, 'const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION ? "v4" : "v75"', "timer-compatible versions");
includes(cloud, '"cleanup-verification-photo-uploads-hourly"', "photo-only timer name");
includes(cloud, '"cleanup-verification-photo-drafts-hourly"', "face timer name");

const timerFunctions = [
  functionSource(cloud, "requireCleanupControlPlaneCaller"),
  functionSource(cloud, "trustedCleanupTimerKind"),
  functionSource(cloud, "handleTrustedCleanupTimer")
].join("\n");

function createTimerHarness(photoOnly) {
  const expectedFunctionName = photoOnly ? "verificationPhoto" : "faceRecognition";
  const triggerName = photoOnly
    ? "cleanup-verification-photo-uploads-hourly"
    : "cleanup-verification-photo-drafts-hourly";
  let uid = "";
  let uploadsRuns = 0;
  let draftsRuns = 0;
  const harness = {
    module: { exports: {} },
    process: {
      env: {
        TRIGGER_SRC: "timer",
        SCF_FUNCTIONNAME: expectedFunctionName
      }
    },
    PHOTO_ONLY_FUNCTION: photoOnly,
    CLEANUP_TIMER_TRIGGER_NAME: triggerName,
    EXPECTED_FUNCTION_NAME: expectedFunctionName,
    app: () => ({ auth: () => ({ getUserInfo: () => ({ uid }) }) }),
    fail(message, code) { throw Object.assign(new Error(message), { code }); },
    async runVerificationPhotoUploadsCleanup() {
      uploadsRuns += 1;
      return { ok: true, routed: "UPLOADS" };
    },
    async runVerificationPhotoDraftsCleanup() {
      draftsRuns += 1;
      return { ok: true, routed: "DRAFTS" };
    }
  };
  vm.createContext(harness);
  vm.runInContext(
    `${timerFunctions}\nmodule.exports = { trustedCleanupTimerKind, handleTrustedCleanupTimer };`,
    harness,
    { filename: photoOnly ? "verification-photo-v4-timer.js" : "face-recognition-v75-timer.js" }
  );
  return {
    classify: harness.module.exports.trustedCleanupTimerKind,
    handle: harness.module.exports.handleTrustedCleanupTimer,
    env: harness.process.env,
    triggerName,
    expectedFunctionName,
    setUid(value) { uid = value; },
    counts() { return { uploadsRuns, draftsRuns }; }
  };
}

function validTimerEvent(harness, overrides = {}) {
  return {
    Type: "Timer",
    TriggerName: harness.triggerName,
    Time: "2026-08-18T01:17:00Z",
    Message: "",
    ...overrides
  };
}

async function verifyTimerMode(photoOnly) {
  const harness = createTimerHarness(photoOnly);
  const expectedKind = photoOnly ? "UPLOADS" : "DRAFTS";
  const validEvent = validTimerEvent(harness, {
    // A timer route is fixed by deployed mode and trigger identity. Event data
    // cannot redirect the cleanup or smuggle a browser cleanup credential.
    action: photoOnly ? "cleanupVerificationPhotoDrafts" : "cleanupVerificationPhotoUploads",
    cleanupToken: "forged-event-value"
  });
  assert.equal(
    harness.classify(validEvent, { function_name: harness.expectedFunctionName }),
    expectedKind,
    `${harness.expectedFunctionName} accepts the complete trusted timer envelope`
  );
  assert.equal(
    harness.classify(validTimerEvent(harness), {}),
    expectedKind,
    "SCF_FUNCTIONNAME remains authoritative when context.function_name is absent"
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await harness.handle(validEvent, { function_name: harness.expectedFunctionName }))),
    { ok: true, routed: expectedKind },
    "the trusted timer routes to the mode-fixed cleanup implementation"
  );
  assert.deepEqual(
    harness.counts(),
    photoOnly ? { uploadsRuns: 1, draftsRuns: 0 } : { uploadsRuns: 0, draftsRuns: 1 },
    "a timer cannot switch between upload and face-draft cleanup"
  );

  const rejected = [
    ["missing TRIGGER_SRC", { env: { TRIGGER_SRC: "" } }],
    ["forged TRIGGER_SRC", { env: { TRIGGER_SRC: "client" } }],
    ["missing TriggerName", { event: { TriggerName: "" } }],
    ["forged TriggerName", { event: { TriggerName: `${harness.triggerName}-forged` } }],
    ["missing SCF_FUNCTIONNAME", { env: { SCF_FUNCTIONNAME: "" } }],
    ["forged SCF_FUNCTIONNAME", { env: { SCF_FUNCTIONNAME: `${harness.expectedFunctionName}-forged` } }],
    ["forged context function_name", { context: { function_name: `${harness.expectedFunctionName}-forged` } }],
    ["missing Time", { event: { Time: "" } }],
    ["invalid Time", { event: { Time: "not-a-time" } }]
  ];
  for (const [label, change] of rejected) {
    const originalEnv = { ...harness.env };
    Object.assign(harness.env, change.env || {});
    const event = validTimerEvent(harness, change.event || {});
    const context = change.context || { function_name: harness.expectedFunctionName };
    throwsCode(
      () => harness.classify(event, context),
      "UNTRUSTED_TIMER_EVENT",
      `${harness.expectedFunctionName} rejects ${label}`
    );
    Object.assign(harness.env, originalEnv);
  }

  harness.setUid("authenticated-browser-user");
  throwsCode(
    () => harness.classify(validTimerEvent(harness), { function_name: harness.expectedFunctionName }),
    "FORBIDDEN",
    "an authenticated browser cannot forge the otherwise-valid timer event"
  );
  harness.setUid("");

  // TRIGGER_SRC can remain set on a warm instance. Without the platform Timer
  // event type it must not intercept or reject a normal SDK action.
  harness.env.TRIGGER_SRC = "timer";
  assert.equal(
    harness.classify({ action: "health" }, { function_name: harness.expectedFunctionName }),
    "",
    "stale TRIGGER_SRC does not intercept an ordinary action"
  );
  assert.equal(
    harness.classify({ Type: "timer", action: "health" }, { function_name: harness.expectedFunctionName }),
    "",
    "only the exact platform Type=Timer opts into timer validation"
  );
  assert.equal(
    await harness.handle({ action: "health" }, { function_name: harness.expectedFunctionName }),
    null,
    "the main dispatcher can continue after a stale timer environment marker"
  );
}

function createManualCleanupHarness() {
  let uid = "";
  let authError = null;
  const token = "a".repeat(64);
  const harness = {
    module: { exports: {} },
    process: { env: { VERIFICATION_PHOTO_CLEANUP_TOKEN: token } },
    Buffer,
    crypto,
    app: () => ({
      auth: () => ({
        getUserInfo: () => {
          if (authError) throw authError;
          return { uid };
        }
      })
    }),
    required(name) {
      const value = String(harness.process.env[name] || "").trim();
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
    fail(message, code) { throw Object.assign(new Error(message), { code }); }
  };
  vm.createContext(harness);
  vm.runInContext(
    [
      functionSource(cloud, "requireCleanupControlPlaneCaller"),
      functionSource(cloud, "requireVerificationPhotoCleanupToken"),
      "module.exports = requireVerificationPhotoCleanupToken;"
    ].join("\n"),
    harness,
    { filename: "verification-photo-manual-cleanup-auth.js" }
  );
  return {
    authorize: harness.module.exports,
    env: harness.process.env,
    token,
    setUid(value) { uid = value; },
    setAuthError(value) { authError = value; }
  };
}

function verifyManualCleanupAuthorization() {
  const harness = createManualCleanupHarness();
  assert.doesNotThrow(
    () => harness.authorize({ cleanupToken: harness.token }),
    "a control-plane invocation with the exact 64-character token is accepted"
  );
  harness.setUid("authenticated-browser-user");
  throwsCode(
    () => harness.authorize({ cleanupToken: harness.token }),
    "FORBIDDEN",
    "the correct token never authorizes an authenticated browser"
  );
  harness.setUid("");
  throwsCode(
    () => harness.authorize({ cleanupToken: "b".repeat(64) }),
    "FORBIDDEN",
    "a control-plane invocation still needs the exact token"
  );
  harness.env.VERIFICATION_PHOTO_CLEANUP_TOKEN = "too-short";
  throwsCode(
    () => harness.authorize({ cleanupToken: "too-short" }),
    "CLEANUP_CONFIGURATION_INVALID",
    "a short configured token fails closed"
  );
  harness.env.VERIFICATION_PHOTO_CLEANUP_TOKEN = harness.token;
  harness.setAuthError(new Error("auth context unavailable"));
  throwsCode(
    () => harness.authorize({ cleanupToken: harness.token }),
    "CLEANUP_CALLER_UNVERIFIED",
    "missing CloudBase caller context fails closed"
  );
}

function verifyServiceRoleKeyCompatibility() {
  const harness = {
    module: { exports: {} },
    process: { env: {} }
  };
  vm.createContext(harness);
  vm.runInContext(
    [
      functionSource(cloud, "cloudbaseServiceRoleKey"),
      functionSource(cloud, "cloudbaseServiceRoleKeyConfigured"),
      "module.exports = { cloudbaseServiceRoleKey, cloudbaseServiceRoleKeyConfigured };"
    ].join("\n"),
    harness,
    { filename: "cloudbase-service-role-key-compatibility.js" }
  );
  const { cloudbaseServiceRoleKey: readKey, cloudbaseServiceRoleKeyConfigured: configured } = harness.module.exports;

  harness.process.env.CLOUDBASE_APIKEY = "new-api-key";
  harness.process.env.CLOUDBASE_SERVICE_ROLE_KEY = "legacy-service-role-key";
  assert.equal(readKey(), "new-api-key", "CLOUDBASE_APIKEY takes precedence");
  assert.equal(configured(), true);

  harness.process.env.CLOUDBASE_APIKEY = "";
  assert.equal(readKey(), "legacy-service-role-key", "the legacy service-role variable remains supported");
  assert.equal(configured(), true);

  harness.process.env.CLOUDBASE_APIKEY = "   ";
  assert.equal(readKey(), "legacy-service-role-key", "a blank new variable falls back to the legacy key");
  assert.equal(configured(), true);

  delete harness.process.env.CLOUDBASE_APIKEY;
  delete harness.process.env.CLOUDBASE_SERVICE_ROLE_KEY;
  assert.equal(configured(), false, "health reports no key when neither variable is configured");
  assert.throws(() => readKey(), /CLOUDBASE_APIKEY or CLOUDBASE_SERVICE_ROLE_KEY/);

  assert.ok(!cloud.includes('required("CLOUDBASE_SERVICE_ROLE_KEY")'), "all storage and HMAC paths use the compatibility helper");
  for (const requiredCall of [
    "accessToken: cloudbaseServiceRoleKey()",
    'createHmac("sha256", cloudbaseServiceRoleKey())',
    "const serviceRoleKeyConfigured = cloudbaseServiceRoleKeyConfigured()",
    "verificationPhotoServiceRoleKeyConfigured: cloudbaseServiceRoleKeyConfigured()"
  ]) includes(cloud, requiredCall, `service-role compatibility use ${requiredCall}`);
}

function verifyCleanupSqlSafetyContract() {
  const uploadCleanup = functionSource(cloud, "cleanupVerificationPhotoUploadRequests");
  for (const clause of [
    "WHERE upload.status IN ('CANCELLED', 'EXPIRED')",
    "AND upload.cleanup_after <= CLOCK_TIMESTAMP()",
    "AND upload.objects_cleaned_at IS NULL",
    "AND NOT EXISTS (",
    "LIMIT 100",
    "AND status IN ('CANCELLED', 'EXPIRED')",
    "AND objects_cleaned_at IS NULL"
  ]) includes(uploadCleanup, clause, `supplemental-photo cleanup safety ${clause}`);
  assert.ok(!uploadCleanup.includes("DELETE FROM public.verification_photos"), "committed photo evidence is never deleted");

  const draftCleanup = functionSource(cloud, "runVerificationPhotoDraftsCleanup");
  includes(draftCleanup, "WITH candidates AS (", "face-draft cleanup claims candidates atomically");
  includes(draftCleanup, "FOR UPDATE OF draft SKIP LOCKED", "an in-flight order transaction excludes its draft");
  includes(draftCleanup, "UPDATE public.verification_photo_drafts AS draft", "candidate claim creates a new row version");
  includes(draftCleanup, "SET expires_at = draft.expires_at", "candidate claim is metadata-neutral");
  includes(draftCleanup, "DELETE FROM public.verification_photo_drafts", "claimed draft is rechecked before deletion");
  assert.equal(
    (draftCleanup.match(/expires_at <= CLOCK_TIMESTAMP\(\) - INTERVAL '10 minutes'/g) || []).length,
    3,
    "candidate selection, claim, and final deletion all enforce the ten-minute grace period"
  );
  assert.equal(
    (draftCleanup.match(/consumed_at IS NULL/g) || []).length,
    3,
    "candidate selection, claim, and final deletion all reject consumed drafts"
  );
  assert.equal(
    (draftCleanup.match(/NOT EXISTS \(/g) || []).length,
    3,
    "candidate selection, claim, and final deletion all recheck bound photo evidence"
  );
  assert.equal(
    (draftCleanup.match(/source_evidence_token/g) || []).length,
    3,
    "every evidence anti-join checks the immutable source token"
  );
  for (const referenceGuard of [
    "photo.original_object_ref = draft.original_object_ref",
    "photo.thumbnail_object_ref = draft.original_object_ref",
    "photo.original_object_ref = draft.thumbnail_object_ref",
    "photo.thumbnail_object_ref = draft.thumbnail_object_ref",
    "photo.original_object_ref = verification_photo_drafts.original_object_ref",
    "photo.thumbnail_object_ref = verification_photo_drafts.original_object_ref",
    "photo.original_object_ref = verification_photo_drafts.thumbnail_object_ref",
    "photo.thumbnail_object_ref = verification_photo_drafts.thumbnail_object_ref"
  ]) includes(draftCleanup, referenceGuard, `face-draft evidence reference guard ${referenceGuard}`);
  includes(draftCleanup, "LIMIT 100", "face-draft cleanup remains bounded");
}

function markdownSection(source, heading) {
  const marker = `## ${heading}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `README section ${heading} must exist`);
  const end = source.indexOf("\n## ", start + marker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

function firstJsonFence(source, label) {
  const match = /```json\s*([\s\S]*?)```/.exec(source);
  assert.ok(match, `${label} must contain a JSON configuration block`);
  return match[1];
}

function verifySeparatedEnvironmentAndTriggerDocs() {
  const faceReadme = fs.readFileSync(path.join(root, "cloudfunctions/faceRecognition/README.md"), "utf8");
  const photoReadme = fs.readFileSync(path.join(root, "cloudfunctions/verificationPhoto/README.md"), "utf8");
  const faceRequired = markdownSection(faceReadme, "必需环境变量");
  const photoRequired = markdownSection(photoReadme, "必需环境变量");

  for (const variable of [
    "FACE_SECRET_ID", "FACE_SECRET_KEY", "FACE_GROUP_ID", "CLOUDBASE_ENV_ID", "CLOUDBASE_APIKEY"
  ]) includes(faceRequired, variable, `faceRecognition required environment ${variable}`);
  for (const variable of [
    "CLOUDBASE_ENV_ID", "CLOUDBASE_APIKEY", "CUSTOMER_PHOTO_BUCKET_ID",
    "VERIFICATION_PHOTO_BUCKET_ID", "VERIFICATION_PHOTO_CLEANUP_TOKEN"
  ]) includes(photoRequired, variable, `verificationPhoto required environment ${variable}`);
  assert.ok(!/FACE_SECRET_ID|FACE_SECRET_KEY|FACE_GROUP_ID/.test(photoRequired), "photo-only required variables exclude Tencent Face credentials");
  includes(
    photoReadme,
    "本函数不需要也不要配置 `CUSTOMER_PHOTO_URL_TTL_SECONDS`",
    "photo-only documentation rejects face/customer-only settings"
  );

  const faceTriggerConfig = firstJsonFence(markdownSection(faceReadme, "部署"), "faceRecognition trigger");
  const photoTriggerConfig = firstJsonFence(markdownSection(photoReadme, "定时清理"), "verificationPhoto trigger");
  for (const [label, config, name, cron] of [
    ["faceRecognition", faceTriggerConfig, "cleanup-verification-photo-drafts-hourly", "0 0 * * * * *"],
    ["verificationPhoto", photoTriggerConfig, "cleanup-verification-photo-uploads-hourly", "0 10 * * * * *"]
  ]) {
    includes(config, '"triggers"', `${label} uses the CloudBase triggers wrapper`);
    includes(config, `"name": "${name}"`, `${label} exact trigger name`);
    includes(config, '"type": "timer"', `${label} timer type`);
    includes(config, `"config": "${cron}"`, `${label} seven-field cron`);
    assert.ok(!/"action"|"cleanupToken"/.test(config), `${label} timer definition contains no business event or secret`);
  }
}

(async () => {
  await verifyTimerMode(false);
  await verifyTimerMode(true);
  verifyManualCleanupAuthorization();
  verifyServiceRoleKeyCompatibility();
  verifyCleanupSqlSafetyContract();
  verifySeparatedEnvironmentAndTriggerDocs();
  console.log("verification photo timer contract tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
