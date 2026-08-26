"use strict";

// This module is deliberately local to the verificationPhoto package. It
// improves private-photo reads without changing faceRecognition or moving any
// authorization decision out of the shared service.

const MANAGER_PATCH = Symbol.for("lusizhuoer.verificationPhoto.managerReadReliability");
const STORAGE_PATCH = Symbol.for("lusizhuoer.verificationPhoto.storageReadReliability");
const DEFAULT_SIGN_CONCURRENCY = 6;
const DEFAULT_SIGN_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [40, 120];
const DEFAULT_AUTHENTICATED_READ_ATTEMPTS = 3;
const RESPONSE_URL_SAFETY_MS = 10 * 1000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

function storageErrorText(error) {
  const response = error?.response || error?.Response || error?.data || error?.Data;
  return [
    error?.code,
    error?.Code,
    error?.name,
    error?.message,
    error?.status,
    error?.statusCode,
    response?.code,
    response?.Code,
    response?.message,
    response?.Message,
    response?.status,
    response?.statusCode
  ].filter((value) => value !== undefined && value !== null).join(" ").toUpperCase();
}

function transientStorageReadError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || error?.response?.statusCode || 0);
  if ([408, 425, 429].includes(status) || status >= 500) return true;
  const detail = storageErrorText(error);
  return [
    "INTERNALERROR", "INTERNAL_ERROR", "INTERNAL ERROR", "STORAGE_INTERNAL",
    "REQUEST_TIMEOUT", "TIMED OUT", "TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT",
    "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH",
    "TOO_MANY_REQUESTS", "THROTTL", "SERVICE_UNAVAILABLE", "BAD_GATEWAY",
    "GATEWAY_TIMEOUT"
  ].some((marker) => detail.includes(marker));
}

function validHttpsUrl(value) {
  if (typeof value !== "string" || !/^https:\/\//i.test(value.trim())) return "";
  const original = value.trim();
  try {
    const parsed = new URL(original);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return "";
    // Do not serialize a signed URL again: even an equivalent encoding can
    // change the exact canonical query string checked by the storage gateway.
    return original;
  } catch (_) {
    return "";
  }
}

function signedResponseUrl(value, depth = 0, seen = new Set()) {
  if (depth > 7 || value === null || value === undefined) return "";
  if (typeof value === "string") return validHttpsUrl(value);
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = signedResponseUrl(item, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }
  const preferred = Object.entries(value).filter(([key]) => /^(?:url|signedurl|signed_url|fullsignedurl)$/i.test(key));
  const remaining = Object.entries(value).filter(([key]) => !/^(?:url|signedurl|signed_url|fullsignedurl)$/i.test(key));
  for (const [, item] of [...preferred, ...remaining]) {
    const found = signedResponseUrl(item, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function epochMilliseconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric >= 1e12) return Math.trunc(numeric);
  if (numeric >= 1e9) return Math.trunc(numeric * 1000);
  return 0;
}

function awsDateMilliseconds(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(String(value || "").trim());
  if (!match) return 0;
  const parsed = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function jwtExpiryMilliseconds(value) {
  const token = String(value || "").trim();
  const pieces = token.split(".");
  if (pieces.length !== 3 || !pieces[1]) return 0;
  try {
    const payload = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
    return epochMilliseconds(payload?.exp);
  } catch (_) {
    return 0;
  }
}

function queryValue(searchParams, ...names) {
  const expected = new Set(names.map((name) => String(name).toLowerCase()));
  for (const [name, value] of searchParams) {
    if (expected.has(String(name).toLowerCase())) return value;
  }
  return null;
}

function signedUrlExpiresAt(value, issuedAt, requestedTtlSeconds) {
  const url = validHttpsUrl(value);
  if (!url) return 0;
  const now = Number(issuedAt) || Date.now();
  const requestedTtl = boundedInteger(requestedTtlSeconds, 0, 0, 24 * 60 * 60);
  const candidates = requestedTtl > 0 ? [now + requestedTtl * 1000] : [];
  const parsed = new URL(url);
  const signTime = queryValue(parsed.searchParams, "q-sign-time", "sign-time");
  const signTimeMatch = /^(\d{9,16});(\d{9,16})$/.exec(String(signTime || ""));
  if (signTimeMatch) {
    const expiry = epochMilliseconds(signTimeMatch[2]);
    if (expiry) candidates.push(expiry);
  }
  const awsDate = awsDateMilliseconds(queryValue(parsed.searchParams, "x-amz-date"));
  const awsTtl = Number(queryValue(parsed.searchParams, "x-amz-expires"));
  if (awsDate && Number.isFinite(awsTtl) && awsTtl > 0) candidates.push(awsDate + awsTtl * 1000);
  for (const name of ["expires", "expiry", "expiration", "exp", "x-oss-expires"]) {
    const expiry = epochMilliseconds(queryValue(parsed.searchParams, name));
    if (expiry) candidates.push(expiry);
  }
  for (const name of ["token", "access_token", "x-cos-security-token", "x-amz-security-token"]) {
    const expiry = jwtExpiryMilliseconds(queryValue(parsed.searchParams, name));
    if (expiry) candidates.push(expiry);
  }
  return candidates.length ? Math.min(...candidates) : 0;
}

function signingRequestKey(method, args = {}) {
  const paths = method === "signObjects"
    ? (Array.isArray(args.paths) ? args.paths : []).map((value) => String(value || ""))
    : [String(args.objectName || args.path || "")];
  // accessToken stays only in this in-memory key and is never logged. Including
  // it prevents results from crossing credential scopes if a test or future
  // manager client uses more than one service identity.
  return JSON.stringify([
    method,
    String(args.envId || ""),
    String(args.bucketId || ""),
    String(args.accessToken || ""),
    boundedInteger(args.expiresIn, 0, 0, 24 * 60 * 60),
    paths
  ]);
}

function createConcurrencyGate(limit) {
  const maximum = boundedInteger(limit, DEFAULT_SIGN_CONCURRENCY, 1, 32);
  let active = 0;
  const queue = [];
  return async (operation) => {
    if (active >= maximum) await new Promise((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function createSigningCoordinator(options = {}) {
  const sleep = typeof options.sleep === "function" ? options.sleep : wait;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const attempts = boundedInteger(options.maxAttempts, DEFAULT_SIGN_ATTEMPTS, 1, 5);
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const gate = createConcurrencyGate(options.maxConcurrent);
  const inFlight = new Map();
  // The shared verification-photo service already owns the completed signed-URL
  // cache and its caller-facing expiry. Caching a completed manager response in
  // this lower layer would let the upper layer treat an old URL as newly issued
  // and extend it past the token's real expiry. Keep only same-request flights.
  const cache = new Map();

  async function sign(method, args, invoke) {
    const key = signingRequestKey(method, args);
    if (inFlight.has(key)) return inFlight.get(key);

    const flight = gate(async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await invoke();
          return response;
        } catch (error) {
          lastError = error;
          if (attempt >= attempts || !transientStorageReadError(error)) throw error;
          const baseDelay = Number(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] || 0);
          // Per-request jitter prevents many different objects that encounter
          // one provider incident from retrying in the same millisecond.
          const jitter = 0.75 + Math.min(1, Math.max(0, Number(random()) || 0)) * 0.5;
          await sleep(Math.max(0, Math.round(baseDelay * jitter)));
        }
      }
      throw lastError || new Error("Private photo signing failed.");
    });
    inFlight.set(key, flight);
    try {
      return await flight;
    } finally {
      if (inFlight.get(key) === flight) inFlight.delete(key);
    }
  }

  return { sign, inFlight, cache };
}

function wrapStorageSigning(storage, coordinator) {
  if (!storage || typeof storage !== "object") return storage;
  if (storage[STORAGE_PATCH]) return storage;
  const signingCoordinator = coordinator || createSigningCoordinator();
  for (const method of ["signObject", "signObjects"]) {
    if (typeof storage[method] !== "function") continue;
    const original = storage[method];
    storage[method] = function reliableVerificationPhotoSign(args = {}) {
      return signingCoordinator.sign(method, args, () => original.call(this, args));
    };
  }
  Object.defineProperty(storage, STORAGE_PATCH, { value: signingCoordinator });
  return storage;
}

function installManagerSigningReliability(managerModule, options = {}) {
  if (!managerModule || typeof managerModule.init !== "function") {
    throw new TypeError("CloudBase manager module must expose init().");
  }
  if (managerModule[MANAGER_PATCH]) return managerModule[MANAGER_PATCH];
  const coordinator = createSigningCoordinator(options);
  const originalInit = managerModule.init;
  managerModule.init = function reliableVerificationPhotoManagerInit(...args) {
    const client = originalInit.apply(this, args);
    if (client && typeof client.then === "function") {
      return client.then((resolved) => {
        wrapStorageSigning(resolved?.storage, coordinator);
        return resolved;
      });
    }
    wrapStorageSigning(client?.storage, coordinator);
    return client;
  };
  Object.defineProperty(managerModule, MANAGER_PATCH, { value: coordinator });
  return coordinator;
}

function photoUrlTiming(url, reportedSeconds, now = Date.now()) {
  const value = String(url || "").trim();
  if (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/i.test(value)) {
    return { usable: true, url: value, expiresIn: 0, expiresAt: Number.MAX_SAFE_INTEGER, transport: "FUNCTION_DATA" };
  }
  const httpsUrl = validHttpsUrl(value);
  if (!httpsUrl) return { usable: false, url: "", expiresIn: 0, expiresAt: 0, transport: "" };
  const reported = boundedInteger(reportedSeconds, 0, 0, 24 * 60 * 60);
  const expiresAt = signedUrlExpiresAt(httpsUrl, now, reported);
  const remaining = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : reported;
  return {
    usable: remaining * 1000 > RESPONSE_URL_SAFETY_MS,
    url: httpsUrl,
    expiresIn: remaining,
    expiresAt,
    transport: "SIGNED_URL"
  };
}

function signingFailureResult(result) {
  const code = String(result?.code || "").trim().toUpperCase();
  return [
    "PHOTO_SIGN_FAILED", "PHOTO_THUMBNAIL_UNAVAILABLE", "INTERNALERROR",
    "INTERNAL_ERROR", "STORAGE_INTERNAL_ERROR", "FUNCTION_ERROR"
  ].includes(code);
}

function authenticatedReadRetryableResult(result) {
  if (result?.ok === true) return false;
  const code = String(result?.code || "").trim().toUpperCase();
  return [
    "PHOTO_EXPORT_INVALID", "PHOTO_UPLOAD_DOWNLOAD_FAILED", "PHOTO_DOWNLOAD_TRUNCATED",
    "INTERNALERROR", "INTERNAL_ERROR", "STORAGE_INTERNAL_ERROR", "FUNCTION_ERROR"
  ].includes(code);
}

function safeJpegDataUrl(value, expectedBytes) {
  const data = String(value || "").trim();
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/i.exec(data);
  if (!match) return "";
  let bytes;
  try { bytes = Buffer.from(match[1], "base64"); }
  catch (_) { return ""; }
  const recordedBytes = Number(expectedBytes || 0);
  if (!bytes.length || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return "";
  if (Number.isInteger(recordedBytes) && recordedBytes > 0 && bytes.length !== recordedBytes) return "";
  return data;
}

function createVerificationPhotoMain(sharedMain, options = {}) {
  if (typeof sharedMain !== "function") throw new TypeError("Shared verification-photo main must be a function.");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : wait;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const authenticatedReadAttempts = boundedInteger(
    options.authenticatedReadAttempts,
    DEFAULT_AUTHENTICATED_READ_ATTEMPTS,
    1,
    5
  );

  async function authorizedExportData(event, context) {
    let lastResult = null;
    let lastError = null;
    for (let attempt = 1; attempt <= authenticatedReadAttempts; attempt += 1) {
      try {
        lastResult = await sharedMain({ ...event, action: "getVerificationPhotoExportData" }, context);
        lastError = null;
        if (lastResult?.ok === true || !authenticatedReadRetryableResult(lastResult)) return lastResult;
      } catch (error) {
        lastError = error;
        if (!transientStorageReadError(error)) throw error;
      }
      if (attempt < authenticatedReadAttempts) {
        const baseDelay = DEFAULT_RETRY_DELAYS_MS[Math.min(attempt - 1, DEFAULT_RETRY_DELAYS_MS.length - 1)];
        const jitter = 0.75 + Math.min(1, Math.max(0, Number(random()) || 0)) * 0.5;
        await sleep(Math.max(0, Math.round(baseDelay * jitter)));
      }
    }
    if (lastError) throw lastError;
    return lastResult || {
      ok: false,
      code: "PHOTO_DOWNLOAD_TRUNCATED",
      message: "核销照片安全读取连续失败，请稍后重试。"
    };
  }

  async function originalDataFallback(event, context, initialResult) {
    const exportResult = await authorizedExportData(event, context);
    const imageBase64 = exportResult?.ok === true
      ? safeJpegDataUrl(exportResult.imageBase64, exportResult.bytes)
      : "";
    if (!imageBase64) {
      if (initialResult?.ok !== true) return initialResult;
      return exportResult?.ok === false ? exportResult : {
        ok: false,
        code: "PHOTO_FALLBACK_INVALID",
        message: "核销照片安全读取结果与记录大小不一致，请稍后重试。"
      };
    }
    return {
      ok: true,
      slot: Number(exportResult.slot ?? event.slot),
      photoUrl: imageBase64,
      originalBytes: Number(exportResult.bytes || 0),
      width: Number(exportResult.width || initialResult?.width || 0),
      height: Number(exportResult.height || initialResult?.height || 0),
      expiresIn: 0,
      transport: "FUNCTION_DATA",
      fallbackFrom: "SIGNED_URL"
    };
  }

  async function improveOriginal(event, context, result) {
    if (result?.ok === true) {
      const timing = photoUrlTiming(result.photoUrl, result.expiresIn, now());
      if (timing.usable) return { ...result, photoUrl: timing.url, expiresIn: timing.expiresIn, transport: timing.transport };
      return originalDataFallback(event, context, result);
    }
    if (!signingFailureResult(result)) return result;
    return originalDataFallback(event, context, result);
  }

  function improveManifest(result) {
    if (result?.ok !== true || !Array.isArray(result.photos)) return result;
    const photos = result.photos.map((photo) => {
      const timing = photoUrlTiming(photo?.thumbnailUrl, photo?.thumbnailUrlExpiresIn ?? result.expiresIn, now());
      if (timing.usable) {
        return { ...photo, thumbnailUrl: timing.url, thumbnailUrlExpiresIn: timing.expiresIn };
      }
      // Do not turn one slow or unavailable private-storage read into five
      // sequential original reads during the first manifest request. The row
      // remains declared, so clients can render an honest per-slot recovery
      // target. Only the slot the user taps enters the separately authorized
      // byte fallback below; other loaded slots and their URLs stay untouched.
      return {
        ...photo,
        thumbnailUrl: "",
        thumbnailUrlExpiresIn: 0,
        thumbnailError: String(photo?.thumbnailError || "PHOTO_THUMBNAIL_DEFERRED"),
        thumbnailRetryable: true,
        thumbnailFallbackAction: "getVerificationPhotoThumbnailData"
      };
    });
    return { ...result, photos };
  }

  function thumbnailDataResult(event, exportResult) {
    if (exportResult?.ok !== true) return exportResult;
    const dataUrl = safeJpegDataUrl(exportResult.imageBase64, exportResult.bytes);
    if (!dataUrl) {
      return {
        ok: false,
        code: "PHOTO_THUMBNAIL_BYTES_INVALID",
        message: "核销照片安全缩略图数据与记录大小不一致，请稍后重试。"
      };
    }
    return {
      ok: true,
      slot: Number(exportResult.slot ?? event.slot),
      imageBase64: dataUrl,
      bytes: Number(exportResult.bytes || 0),
      width: Number(exportResult.width || 0),
      height: Number(exportResult.height || 0),
      transport: "FUNCTION_DATA",
      fallbackFrom: "THUMBNAIL_SIGNED_URL"
    };
  }

  return async function verificationPhotoMain(event = {}, context = {}) {
    // Authorization, order scoping and auditing always happen in sharedMain
    // before this adapter examines or falls back from a read result.
    const action = String(event?.action || "health");
    const result = action === "getVerificationPhotoThumbnailData"
      ? await authorizedExportData(event, context)
      : await sharedMain(event, context);
    const trustedTimerEvent = String(event?.Type || event?.type || "").toLowerCase() === "timer";
    if (action === "health" && !trustedTimerEvent && result?.ok === true) {
      return {
        ...result,
        version: "v10",
        sharedVersion: String(result.version || ""),
        verificationPhotoReadReliability: {
          signedUrlExpiryAware: true,
          sameObjectFlightDeduplication: true,
          maxSigningAttempts: DEFAULT_SIGN_ATTEMPTS,
          maxSigningConcurrency: DEFAULT_SIGN_CONCURRENCY,
          thumbnailDataFallback: true,
          manifestFallbackDeferred: true,
          perPhotoRetryIsolated: true
        }
      };
    }
    if (action === "getVerificationPhotoThumbnailData") return thumbnailDataResult(event, result);
    if (action === "getVerificationPhotos") return improveManifest(result);
    if (action === "getVerificationPhotoOriginalUrl") return improveOriginal(event, context, result);
    return result;
  };
}

module.exports = {
  createSigningCoordinator,
  createVerificationPhotoMain,
  installManagerSigningReliability,
  photoUrlTiming,
  signedResponseUrl,
  signedUrlExpiresAt,
  transientStorageReadError,
  validHttpsUrl,
  wrapStorageSigning
};
