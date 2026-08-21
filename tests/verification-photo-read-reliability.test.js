"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createSigningCoordinator,
  createVerificationPhotoMain,
  photoUrlTiming,
  signedUrlExpiresAt,
  transientStorageReadError,
  wrapStorageSigning
} = require(path.resolve(__dirname, "../cloudfunctions/verificationPhoto/read-reliability.js"));

const photoFunctionDirectory = path.resolve(__dirname, "../cloudfunctions/verificationPhoto");
const photoPackage = JSON.parse(fs.readFileSync(path.join(photoFunctionDirectory, "package.json"), "utf8"));
const sourceWrapper = fs.readFileSync(path.join(photoFunctionDirectory, "index.js"), "utf8");
const deployWrapper = fs.readFileSync(path.join(photoFunctionDirectory, "deploy-index.js"), "utf8");
assert.equal(photoPackage.version, "5.0.0", "reliable read layer has a distinguishable deployment package version");
for (const [label, wrapper] of [["source", sourceWrapper], ["deployment", deployWrapper]]) {
  assert.match(wrapper, /installManagerSigningReliability\(CloudBaseManager\)/, `${label} wrapper installs signing reliability before use`);
  assert.match(wrapper, /createVerificationPhotoMain\(sharedService\.main\)/, `${label} wrapper installs authorized read fallbacks`);
}

const FIXED_NOW = 1_800_000_000_000;
const FIXED_SECONDS = Math.floor(FIXED_NOW / 1000);

function signedUrl(objectName, start = FIXED_SECONDS, end = FIXED_SECONDS + 900) {
  return `https://private-photos.example.test/${encodeURIComponent(objectName)}?q-sign-time=${start};${end}&q-key-time=${start};${end}`;
}

function signArgs(objectName, expiresIn = 900) {
  return {
    bucketId: "customer-photos",
    objectName,
    expiresIn,
    envId: "same-env",
    accessToken: "test-service-role-token"
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function sameObjectThirtyRequestLoad() {
  const release = deferred();
  let calls = 0;
  const storage = {
    signObject: async ({ objectName }) => {
      calls += 1;
      await release.promise;
      return { data: { signedURL: signedUrl(objectName) } };
    }
  };
  wrapStorageSigning(storage, createSigningCoordinator({
    now: () => FIXED_NOW,
    sleep: async () => {},
    random: () => 0.5,
    maxConcurrent: 6
  }));
  const requests = Array.from({ length: 30 }, () => storage.signObject(signArgs("records/71/slot-2/same.jpg")));
  assert.equal(calls, 1, "30 simultaneous requests for one object must share one provider signing call");
  release.resolve();
  const responses = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.equal(new Set(responses.map((response) => response.data.signedURL)).size, 1);
}

async function differentObjectThirtyRequestLoad() {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const storage = {
    signObject: async ({ objectName }) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { signedUrl: signedUrl(objectName) };
    }
  };
  wrapStorageSigning(storage, createSigningCoordinator({
    now: () => FIXED_NOW,
    sleep: async () => {},
    random: () => 0.5,
    maxConcurrent: 6
  }));
  const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => (
    storage.signObject(signArgs(`records/71/slot-2/different-${index}.jpg`))
  )));
  assert.equal(responses.length, 30);
  assert.equal(calls, 30, "30 different objects must each be signed");
  assert.ok(peak > 1 && peak <= 6, `different-object peak signing concurrency must be 2..6, saw ${peak}`);
  assert.equal(new Set(responses.map((response) => response.signedUrl)).size, 30);
}

async function internalErrorRetryAndJitter() {
  const delays = [];
  let calls = 0;
  const storage = {
    signObject: async ({ objectName }) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("provider InternalError"), { code: "InternalError" });
      return { url: signedUrl(objectName) };
    }
  };
  wrapStorageSigning(storage, createSigningCoordinator({
    now: () => FIXED_NOW,
    sleep: async (milliseconds) => delays.push(milliseconds),
    random: () => 0.5,
    retryDelaysMs: [40, 120],
    maxAttempts: 3
  }));
  const response = await storage.signObject(signArgs("records/71/slot-2/retry.jpg"));
  assert.match(response.url, /^https:/);
  assert.equal(calls, 3, "two transient InternalError responses receive exactly two retries");
  assert.deepEqual(delays, [40, 120], "injected midpoint jitter keeps retry timing deterministic in tests");
  assert.equal(transientStorageReadError({ code: "InternalError" }), true);
  assert.equal(transientStorageReadError({ code: "STORAGE_OBJECT_NOT_FOUND" }), false);

  let persistentCalls = 0;
  const persistent = {
    signObject: async () => {
      persistentCalls += 1;
      throw Object.assign(new Error("still internal"), { code: "InternalError" });
    }
  };
  wrapStorageSigning(persistent, createSigningCoordinator({
    now: () => FIXED_NOW,
    sleep: async () => {},
    random: () => 0.5,
    retryDelaysMs: [0, 0],
    maxAttempts: 3
  }));
  await assert.rejects(persistent.signObject(signArgs("records/71/slot-2/persistent.jpg")), /still internal/);
  assert.equal(persistentCalls, 3, "persistent InternalError is bounded to three provider attempts");
}

async function failedFlightIsRemoved() {
  const release = deferred();
  let calls = 0;
  const storage = {
    signObject: async ({ objectName }) => {
      calls += 1;
      if (calls === 1) {
        await release.promise;
        throw Object.assign(new Error("one non-retryable failure"), { code: "PHOTO_SIGN_REJECTED" });
      }
      return { url: signedUrl(objectName) };
    }
  };
  wrapStorageSigning(storage, createSigningCoordinator({
    now: () => FIXED_NOW,
    sleep: async () => {},
    random: () => 0.5
  }));
  const firstWave = Array.from({ length: 30 }, () => storage.signObject(signArgs("records/71/slot-2/flight.jpg")));
  assert.equal(calls, 1);
  release.resolve();
  const outcomes = await Promise.allSettled(firstWave);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
  assert.equal(calls, 1, "a failed same-object wave is still deduplicated");
  const recovered = await storage.signObject(signArgs("records/71/slot-2/flight.jpg"));
  assert.match(recovered.url, /^https:/);
  assert.equal(calls, 2, "the failed in-flight entry must be removed so a later request can retry");
}

async function completedSignaturesAreNeverReusedAcrossRequests() {
  let calls = 0;
  const storage = {
    signObject: async ({ objectName }) => {
      calls += 1;
      const issued = FIXED_SECONDS;
      return { url: signedUrl(objectName, issued, issued + 120) };
    }
  };
  wrapStorageSigning(storage, createSigningCoordinator({
    sleep: async () => {},
    random: () => 0.5
  }));
  await storage.signObject(signArgs("records/71/slot-2/expiry.jpg", 900));
  await storage.signObject(signArgs("records/71/slot-2/expiry.jpg", 900));
  assert.equal(calls, 2, "completed manager signatures are not reused beneath the shared service expiry cache");
  assert.equal(signedUrlExpiresAt(signedUrl("x", FIXED_SECONDS, FIXED_SECONDS + 120), FIXED_NOW, 900), FIXED_NOW + 120000);
  assert.equal(
    signedUrlExpiresAt(`https://private.example.test/x?x-amz-date=20270115T080000Z&x-amz-expires=60`, FIXED_NOW, 900),
    Date.UTC(2027, 0, 15, 8, 1, 0),
    "signed URL expiry parameters are parsed case-insensitively"
  );
  const encodedSignature = "https://private.example.test/x?token=a%2Fb%2Bc%3D&signature=x%2Fy";
  assert.equal(photoUrlTiming(encodedSignature, 900, FIXED_NOW).url, encodedSignature, "signed URL encoding is never reserialized");
  assert.equal(photoUrlTiming("http://private.example.test/object", 900, FIXED_NOW).usable, false);
}

function jpegDataUrl(bytes = 4) {
  const jpeg = Buffer.alloc(bytes, 0);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[jpeg.length - 1] = 0xd9;
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

async function authorizedFallbacksAndNoUnauthorizedLeak() {
  const context = { requestId: "context-1", auth: { uid: "authorized-user" } };
  const calls = [];
  const sharedMain = async (event, seenContext) => {
    assert.equal(seenContext, context, "fallbacks must retain the original trusted invocation context");
    calls.push({ action: event.action, slot: event.slot });
    if (event.action === "getVerificationPhotos") {
      return {
        ok: true,
        expiresIn: 900,
        photos: [{
          slot: 2,
          thumbnailUrl: "",
          thumbnailUrlExpiresIn: 0,
          thumbnailError: "PHOTO_SIGN_FAILED",
          originalBytes: 4
        }]
      };
    }
    if (event.action === "getVerificationPhotoOriginalUrl") return { ok: false, code: "PHOTO_SIGN_FAILED" };
    if (event.action === "getVerificationPhotoExportData") {
      return { ok: true, slot: event.slot, imageBase64: jpegDataUrl(4), bytes: 4, width: 1, height: 1 };
    }
    throw new Error(`unexpected action ${event.action}`);
  };
  const main = createVerificationPhotoMain(sharedMain, { now: () => FIXED_NOW });
  const manifest = await main({ action: "getVerificationPhotos", recordId: "71" }, context);
  assert.equal(manifest.photos[0].thumbnailFallback, "FUNCTION_DATA");
  assert.equal(manifest.photos[0].thumbnailRetryable, false);
  assert.match(manifest.photos[0].thumbnailUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(calls.map((call) => call.action), [
    "getVerificationPhotos",
    "getVerificationPhotoOriginalUrl",
    "getVerificationPhotoExportData"
  ], "manifest fallback re-enters shared authorization for original URL and bytes");

  calls.length = 0;
  const thumbnailData = await main({ action: "getVerificationPhotoThumbnailData", recordId: "71", slot: 2 }, context);
  assert.equal(thumbnailData.ok, true);
  assert.equal(thumbnailData.transport, "FUNCTION_DATA");
  assert.deepEqual(calls, [{ action: "getVerificationPhotoExportData", slot: 2 }], "thumbnail action translates directly to the authorized shared export action");

  let unauthorizedCalls = 0;
  const unauthorizedMain = createVerificationPhotoMain(async () => {
    unauthorizedCalls += 1;
    return { ok: false, code: "FORBIDDEN", message: "no access" };
  });
  const unauthorizedOriginal = await unauthorizedMain({ action: "getVerificationPhotoOriginalUrl", recordId: "71", slot: 2 }, {});
  assert.equal(unauthorizedOriginal.code, "FORBIDDEN");
  assert.equal(Object.hasOwn(unauthorizedOriginal, "photoUrl"), false);
  assert.equal(unauthorizedCalls, 1, "authorization failures never enter export fallback");
  const unauthorizedThumbnail = await unauthorizedMain({ action: "getVerificationPhotoThumbnailData", recordId: "71", slot: 2 }, {});
  assert.equal(unauthorizedThumbnail.code, "FORBIDDEN");
  assert.equal(Object.hasOwn(unauthorizedThumbnail, "imageBase64"), false);
  assert.equal(unauthorizedCalls, 2, "thumbnail bytes are returned only by the shared authorized export action");
}

async function authenticatedTruncationGetsBoundedServerRetry() {
  const calls = [];
  const delays = [];
  let exportAttempts = 0;
  const main = createVerificationPhotoMain(async (event) => {
    calls.push(event.action);
    if (event.action === "getVerificationPhotoOriginalUrl") {
      return { ok: false, code: "PHOTO_SIGN_FAILED", message: "signing unavailable" };
    }
    if (event.action === "getVerificationPhotoExportData") {
      exportAttempts += 1;
      if (exportAttempts < 3) {
        return { ok: false, code: "PHOTO_EXPORT_INVALID", message: "truncated authenticated body" };
      }
      return { ok: true, slot: 2, imageBase64: jpegDataUrl(4), bytes: 4, width: 1, height: 1 };
    }
    throw new Error(`unexpected action ${event.action}`);
  }, {
    sleep: async (milliseconds) => delays.push(milliseconds),
    random: () => 0.5,
    authenticatedReadAttempts: 3
  });

  const result = await main({ action: "getVerificationPhotoOriginalUrl", recordId: "71", slot: 2 }, {});
  assert.equal(result.ok, true);
  assert.equal(result.transport, "FUNCTION_DATA");
  assert.equal(exportAttempts, 3, "two transient truncated downloads receive exactly two server-side retries");
  assert.deepEqual(delays, [40, 120]);
  assert.deepEqual(calls, [
    "getVerificationPhotoOriginalUrl",
    "getVerificationPhotoExportData",
    "getVerificationPhotoExportData",
    "getVerificationPhotoExportData"
  ], "each authenticated-byte retry re-enters the shared authorization path");
}

async function healthIdentifiesReliabilityLayer() {
  const main = createVerificationPhotoMain(async (event) => ({
    ok: true,
    ready: true,
    version: "v3",
    service: event.action === "health" ? "verificationPhoto" : "unexpected"
  }));
  const health = await main({ action: "health" }, {});
  assert.equal(health.version, "v5");
  assert.equal(health.sharedVersion, "v3");
  assert.deepEqual(health.verificationPhotoReadReliability, {
    signedUrlExpiryAware: true,
    sameObjectFlightDeduplication: true,
    maxSigningAttempts: 3,
    maxSigningConcurrency: 6,
    thumbnailDataFallback: true
  });
  const timerResult = await main({ Type: "Timer", TriggerName: "cleanup-verification-photo-uploads-hourly" }, {});
  assert.equal(timerResult.version, "v3", "timer cleanup results are not mislabeled as health v5");
  assert.equal(Object.hasOwn(timerResult, "sharedVersion"), false);
}

async function originalAndManifestResponseFallbackLimits() {
  const smallJpeg = jpegDataUrl(4);
  const expired = signedUrl("expired.jpg", FIXED_SECONDS - 200, FIXED_SECONDS - 100);
  const originalCalls = [];
  const originalMain = createVerificationPhotoMain(async (event) => {
    originalCalls.push(event.action);
    if (event.action === "getVerificationPhotoOriginalUrl") {
      return { ok: true, slot: 2, photoUrl: expired, expiresIn: 900, width: 1, height: 1 };
    }
    return { ok: true, slot: 2, imageBase64: smallJpeg, bytes: 4, width: 1, height: 1 };
  }, { now: () => FIXED_NOW });
  const original = await originalMain({ action: "getVerificationPhotoOriginalUrl", recordId: "71", slot: 2 }, {});
  assert.equal(original.transport, "FUNCTION_DATA", "an actually expired cached signed URL falls back to the authorized function payload");
  assert.deepEqual(originalCalls, ["getVerificationPhotoOriginalUrl", "getVerificationPhotoExportData"]);

  const twoMegabytes = 2 * 1024 * 1024;
  const largeJpeg = jpegDataUrl(twoMegabytes);
  const exportSlots = [];
  const budgetMain = createVerificationPhotoMain(async (event) => {
    if (event.action === "getVerificationPhotos") {
      return {
        ok: true,
        expiresIn: 900,
        photos: [2, 3].map((slot) => ({
          slot,
          thumbnailUrl: "",
          thumbnailError: "PHOTO_SIGN_FAILED",
          originalBytes: twoMegabytes
        }))
      };
    }
    if (event.action === "getVerificationPhotoOriginalUrl") return { ok: false, code: "PHOTO_SIGN_FAILED" };
    if (event.action === "getVerificationPhotoExportData") {
      exportSlots.push(event.slot);
      return { ok: true, slot: event.slot, imageBase64: largeJpeg, bytes: twoMegabytes, width: 10, height: 10 };
    }
    throw new Error("unexpected action");
  }, { now: () => FIXED_NOW });
  const budgetManifest = await budgetMain({ action: "getVerificationPhotos", recordId: "71" }, {});
  assert.equal(budgetManifest.ok, true, "one oversized fallback never fails the complete manifest");
  assert.equal(budgetManifest.photos[0].thumbnailFallback, "FUNCTION_DATA");
  assert.equal(budgetManifest.photos[1].thumbnailError, "PHOTO_THUMBNAIL_BYTES_DEFERRED");
  assert.equal(budgetManifest.photos[1].thumbnailRetryable, true);
  assert.equal(budgetManifest.photos[1].thumbnailFallbackAction, "getVerificationPhotoThumbnailData");
  assert.deepEqual(exportSlots, [2], "the response budget prevents materializing bytes that cannot be returned");

  const mismatchMain = createVerificationPhotoMain(async (event) => {
    if (event.action === "getVerificationPhotoThumbnailData") throw new Error("wrapper must translate this action");
    return { ok: true, slot: 2, imageBase64: smallJpeg, bytes: 5, width: 1, height: 1 };
  });
  const mismatch = await mismatchMain({ action: "getVerificationPhotoThumbnailData", recordId: "71", slot: 2 }, {});
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "PHOTO_THUMBNAIL_BYTES_INVALID", "byte-count mismatch cannot be returned as an inline thumbnail");
}

(async () => {
  await sameObjectThirtyRequestLoad();
  await differentObjectThirtyRequestLoad();
  await internalErrorRetryAndJitter();
  await failedFlightIsRemoved();
  await completedSignaturesAreNeverReusedAcrossRequests();
  await authorizedFallbacksAndNoUnauthorizedLeak();
  await authenticatedTruncationGetsBoundedServerRetry();
  await healthIdentifiesReliabilityLayer();
  await originalAndManifestResponseFallbackLimits();
  console.log("verification photo read reliability: PASS (30 same-object + 30 different-object requests)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
