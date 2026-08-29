"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../business-detail.js"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const bodyStart = source.indexOf(") {", start) + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`function ${name} is incomplete`);
}

async function clientReadFlights() {
  const harness = { module: { exports: {} }, Map, Promise, Math, Set, Number, __calls: new Map() };
  vm.createContext(harness);
  vm.runInContext(`
    const clean = (value) => String(value ?? "").trim();
    const verificationPhotoReadFlights = new Map();
    const waitForVerificationPhotoRetry = async () => {};
    const callVerificationPhotoReadAttempt = async (data) => {
      const key = [data.action, data.recordId, Number(data.slot ?? -1)].join(":");
      const count = (globalThis.__calls.get(key) || 0) + 1;
      globalThis.__calls.set(key, count);
       if (data.recordId === "internal" && count < 3) {
         const error = new Error("InternalError"); error.code = "InternalError"; throw error;
       }
       if (data.recordId === "truncated" && count < 3) {
         const error = new Error("authenticated body truncated"); error.code = "PHOTO_EXPORT_INVALID"; throw error;
       }
      if (data.recordId === "forbidden") {
        const error = new Error("forbidden"); error.code = "FORBIDDEN"; throw error;
      }
      return { ok: true, key, count };
    };
    ${functionSource("verificationPhotoReadFlightKey")}
    ${functionSource("coalesceVerificationPhotoTask")}
    ${functionSource("verificationPhotoReadCanRetry")}
    ${functionSource("callVerificationPhotoRead")}
    module.exports = { callVerificationPhotoRead };
  `, harness, { filename: "verification-photo-client-read-flights.js" });

  const read = harness.module.exports.callVerificationPhotoRead;
  const same = await Promise.all(Array.from({ length: 30 }, () => read({
    action: "getVerificationPhotoOriginalUrl", recordId: "internal", slot: 1
  })));
  assert.equal(harness.__calls.get("getVerificationPhotoOriginalUrl:internal:1"), 3,
    "30 same-photo readers share one bounded retry sequence");
  assert.ok(same.every((item) => item.count === 3));

  const truncated = await Promise.all(Array.from({ length: 30 }, () => read({
    action: "getVerificationPhotoExportData", recordId: "truncated", slot: 2
  })));
  assert.equal(harness.__calls.get("getVerificationPhotoExportData:truncated:2"), 3,
    "30 same-photo readers share retries for a transient truncated authenticated download");
  assert.ok(truncated.every((item) => item.count === 3));

  const different = await Promise.all(Array.from({ length: 30 }, (_, index) => read({
    action: "getVerificationPhotoOriginalUrl", recordId: "different-" + index, slot: index % 5
  })));
  assert.equal(different.filter((item) => item.count === 1).length, 30,
    "30 different photos keep independent read flights");

  await assert.rejects(read({ action: "getVerificationPhotos", recordId: "forbidden" }), /forbidden/);
  assert.equal(harness.__calls.get("getVerificationPhotos:forbidden:-1"), 1,
    "terminal authorization errors are never retried");
}

async function clientBlobFlights() {
  const harness = {
    module: { exports: {} }, Blob, Map, Promise, Date, Number,
    __mode: "success", __direct: 0, __refresh: 0, __fallback: 0
  };
  vm.createContext(harness);
  vm.runInContext(`
    const clean = (value) => String(value ?? "").trim();
    const verificationExportBlobCache = new Map();
    const verificationPhotoBlobFlights = new Map();
    let verificationExportDirectFetchUnavailable = false;
    const fetchVerificationPhotoUrlBlob = async (url) => {
      globalThis.__direct += 1;
      if (globalThis.__mode === "stale" && String(url).includes("stale")) throw new Error("HTTP 403");
      if (globalThis.__mode === "cors") throw new TypeError("Failed to fetch");
      return new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" });
    };
    const refreshVerificationPhotoOriginalUrl = async (recordId, slot, photo) => {
      globalThis.__refresh += 1;
      const photoUrl = "https://fresh.test/" + recordId + "/" + slot;
      photo.originalUrl = photoUrl; photo.originalUrlExpiresAt = Date.now() + 60000;
      return { ok: true, photoUrl, expiresIn: 60 };
    };
    const fetchVerificationPhotoExportFallback = async () => {
      globalThis.__fallback += 1;
      return new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" });
    };
    ${functionSource("verificationExportCacheKey")}
    ${functionSource("coalesceVerificationPhotoTask")}
    ${functionSource("fetchVerificationPhotoBlob")}
    module.exports = {
      fetchVerificationPhotoBlob,
      reset: () => {
        verificationExportBlobCache.clear(); verificationPhotoBlobFlights.clear();
        verificationExportDirectFetchUnavailable = false;
      }
    };
  `, harness, { filename: "verification-photo-client-blob-flights.js" });

  const api = harness.module.exports;
  const photo = {
    slot: 0, originalBytes: 4, uploadedAt: "same",
    originalUrl: "https://signed.test/same", originalUrlExpiresAt: Date.now() + 60000
  };
  const same = await Promise.all(Array.from({ length: 30 }, () => api.fetchVerificationPhotoBlob("71", photo)));
  assert.equal(harness.__direct, 1, "30 same-image consumers perform one browser download");
  assert.ok(same.every((blob) => blob === same[0]));

  api.reset();
  harness.__mode = "stale"; harness.__direct = 0; harness.__refresh = 0; harness.__fallback = 0;
  await api.fetchVerificationPhotoBlob("72", {
    slot: 1, originalBytes: 5, uploadedAt: "stale",
    originalUrl: "https://signed.test/stale", originalUrlExpiresAt: Date.now() + 60000
  });
  assert.equal(harness.__direct, 2, "expired/rejected cached URL is retried once with a fresh signature");
  assert.equal(harness.__refresh, 1);
  assert.equal(harness.__fallback, 0);

  api.reset();
  harness.__mode = "cors"; harness.__direct = 0; harness.__refresh = 0; harness.__fallback = 0;
  const corsPhoto = {
    slot: 2, originalBytes: 6, uploadedAt: "cors",
    originalUrl: "https://signed.test/cors", originalUrlExpiresAt: Date.now() + 60000
  };
  await Promise.all(Array.from({ length: 30 }, () => api.fetchVerificationPhotoBlob("73", corsPhoto)));
  assert.equal(harness.__direct, 1, "one CORS failure is shared by all same-image consumers");
  assert.equal(harness.__refresh, 0, "known CORS failure skips another browser URL");
  assert.equal(harness.__fallback, 1, "one authenticated byte fallback serves all same-image consumers");
}

async function inlineDataUrlIsPageLifetimeOnly() {
  const harness = {
    module: { exports: {} }, Blob, Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    fetch: () => { throw new Error("inline data URL must not use network fetch"); },
    window: { setTimeout, clearTimeout }, AbortController
  };
  vm.createContext(harness);
  vm.runInContext(`
    const clean = (value) => String(value ?? "").trim();
    const photoSlotLabel = () => "photo";
    ${functionSource("verificationPhotoUrlNeverExpires")}
    ${functionSource("verificationPhotoDataBlob")}
    ${functionSource("fetchVerificationPhotoUrlBlob")}
    module.exports = { verificationPhotoUrlNeverExpires, fetchVerificationPhotoUrlBlob };
  `, harness, { filename: "verification-photo-client-inline-data.js" });
  const dataUrl = "data:image/jpeg;base64,/9j/2Q==";
  assert.equal(harness.module.exports.verificationPhotoUrlNeverExpires(dataUrl), true);
  const blob = await harness.module.exports.fetchVerificationPhotoUrlBlob(dataUrl, 0);
  assert.equal(blob.type, "image/jpeg");
  assert.equal(blob.size, 4);
}

async function localOriginalDownloadPreservesExactBytes() {
  const exact = new Blob([new Uint8Array([255, 216, 255, 11, 22, 33, 255, 217])], { type: "image/jpeg" });
  const harness = {
    module: { exports: {} }, Blob, Uint8Array, Number,
    __exact: exact, __authenticatedReads: 0
  };
  vm.createContext(harness);
  vm.runInContext(`
    const clean = (value) => String(value ?? "").trim();
    const verificationExportBlobCache = new Map();
    const verificationPhotoBlobFlights = new Map();
    const verificationExportCacheKey = (recordId, photo) => [recordId, photo.slot, photo.originalBytes, photo.uploadedAt].join(":");
    const photoSlotLabel = (slot) => "photo " + slot;
    const fetchVerificationPhotoBlob = async () => new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" });
    const fetchVerificationPhotoExportFallback = async () => {
      globalThis.__authenticatedReads += 1;
      return globalThis.__exact;
    };
    ${functionSource("assertVerificationPhotoOriginalBlob")}
    ${functionSource("fetchVerificationPhotoOriginalForDownload")}
    module.exports = fetchVerificationPhotoOriginalForDownload;
  `, harness, { filename: "verification-photo-original-download.js" });
  const downloaded = await harness.module.exports("71", { slot: 4, originalBytes: exact.size, uploadedAt: "now" });
  assert.equal(downloaded, exact, "download returns the exact authenticated original Blob without conversion");
  assert.equal(downloaded.size, 8);
  assert.equal(harness.__authenticatedReads, 1, "a mismatched direct response is replaced by one authenticated original-byte read");
}

async function mobileAlbumSavePreservesExactBytes() {
  const exact = new Blob([new Uint8Array([255, 216, 255, 41, 42, 43, 255, 217])], { type: "image/jpeg" });
  const harness = {
    module: { exports: {} }, Blob, Uint8Array, Date,
    __canShare: true, __shareMode: "success", __shared: null, __downloaded: null
  };
  vm.createContext(harness);
  vm.runInContext(`
    const usesMobilePhotoLibrary = () => true;
    class File extends Blob {
      constructor(parts, name, options = {}) {
        super(parts, options);
        this.name = name;
        this.lastModified = options.lastModified || 0;
      }
    }
    const navigator = {
      canShare: () => globalThis.__canShare,
      share: async (payload) => {
        if (globalThis.__shareMode === "cancel") {
          const error = new Error("cancelled"); error.name = "AbortError"; throw error;
        }
        globalThis.__shared = payload.files[0];
      }
    };
    const window = {
      OrderExporter: {
        downloadBlob: (blob, filename) => { globalThis.__downloaded = { blob, filename }; }
      }
    };
    ${functionSource("saveVerificationPhotoOriginal")}
    module.exports = saveVerificationPhotoOriginal;
  `, harness, { filename: "verification-photo-mobile-album-save.js" });

  const shared = await harness.module.exports(exact, "核销照片高清原图.jpg");
  assert.equal(shared.mode, "album", "supported phones open the native save/share sheet");
  assert.equal(harness.__downloaded, null, "native share does not create a duplicate browser download");
  assert.equal(harness.__shared.name, "核销照片高清原图.jpg");
  assert.equal(harness.__shared.type, "image/jpeg");
  assert.equal(harness.__shared.size, exact.size, "native file keeps the exact original byte count");
  assert.deepEqual(
    Array.from(new Uint8Array(await harness.__shared.arrayBuffer())),
    Array.from(new Uint8Array(await exact.arrayBuffer())),
    "native file keeps every original JPEG byte without canvas conversion"
  );

  harness.__canShare = false;
  harness.__shared = null;
  const fallback = await harness.module.exports(exact, "fallback.jpg");
  assert.equal(fallback.mode, "download", "unsupported phones receive an original-file download fallback");
  assert.equal(harness.__downloaded.blob, exact, "fallback also receives the exact original Blob");

  harness.__canShare = true;
  harness.__shareMode = "cancel";
  harness.__downloaded = null;
  await assert.rejects(
    harness.module.exports(exact, "cancel.jpg"),
    (error) => error?.code === "PHOTO_ALBUM_SAVE_CANCELLED"
  );
  assert.equal(harness.__downloaded, null, "cancelling the native panel never starts an unexpected download");
}

(async () => {
  await clientReadFlights();
  await clientBlobFlights();
  await inlineDataUrlIsPageLifetimeOnly();
  await localOriginalDownloadPreservesExactBytes();
  await mobileAlbumSavePreservesExactBytes();
  console.log("verification photo client read reliability: PASS (30 same + 30 different)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
