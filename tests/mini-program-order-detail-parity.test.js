"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const pageRoot = path.join(root, "miniprogram-app", "miniprogram", "pages", "order-detail");
const js = fs.readFileSync(path.join(pageRoot, "index.js"), "utf8");
const wxml = fs.readFileSync(path.join(pageRoot, "index.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(pageRoot, "index.wxss"), "utf8");
const sharedRenderer = require(path.join(root, "miniprogram-app", "miniprogram", "services", "order-receipt.js"));

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

function functionSource(source, name) {
  const plainStart = source.indexOf(`  ${name}(`);
  const asyncStart = source.indexOf(`  async ${name}(`);
  const start = plainStart >= 0 ? plainStart : asyncStart;
  assert.ok(start >= 0, `missing page method ${name}`);
  const next = source.indexOf("\n  },", start);
  assert.ok(next > start, `missing page method end ${name}`);
  return source.slice(start, next + 5);
}

function loadHelpers(options = {}) {
  const marker = "\nPage({";
  assert.ok(js.includes(marker), "order-detail helper injection marker exists");
  const instrumented = js.replace(marker, `
globalThis.__orderDetailHelpers = {
  PHOTO_SLOT_COUNT, DETAIL_PHOTO_SLOTS, MAX_EXTRA_SOURCE_PHOTO_BYTES, MAX_EXTRA_UPLOAD_PHOTO_BYTES, imageFormat,
  buildPhotoSlots, normalizePhotoManifest,
  exactOrderKind, routeOrderExpectation, assertExactRouteOrder, detailStatusLabel,
  receiptDocumentData, requestId, jpegPdf, originalPhotoCacheKey,
  ORIGINAL_PHOTO_CACHE_TTL_MS, ORIGINAL_PHOTO_CACHE_STORAGE_KEY
};
Page({`);
  const files = options.files || new Map();
  const storage = options.storage || new Map();
  const context = {
    globalThis: null,
    Page(definition) { context.page = definition; },
    require(request) {
      if (request.endsWith("query-tools")) return require(path.join(root, "miniprogram-app", "miniprogram", "services", "query-tools.js"));
      if (request.endsWith("session")) return { requireSession() { return options.session || null; } };
      if (request.endsWith("submission")) return { acknowledge: options.acknowledge || (() => true) };
      if (request.endsWith("photo-album")) return {
        saveImageToAlbum: options.saveImageToAlbum || (async () => ({ saved: true })),
        isPermissionFailure: options.isPermissionFailure || ((error) => /permission|授权|权限/i.test(String(error?.message || error?.errMsg || "")))
      };
      if (request.endsWith("order-receipt")) return sharedRenderer;
      if (request.endsWith("api")) return {
        callFace: options.callFace || (() => ({})),
        callPhoto: options.callPhoto || (() => ({})),
        callStaff: options.callStaff || (() => ({})),
        callRating: options.callRating || (() => ({}))
      };
      throw new Error(`unexpected require ${request}`);
    },
    Uint8Array,
    ArrayBuffer,
    Map,
    Promise,
    Date,
    Math,
    String,
    Number,
    Object,
    RegExp,
    Error,
    decodeURIComponent,
    encodeURIComponent,
    wx: {
      env: { USER_DATA_PATH: "/mini-data" },
      base64ToArrayBuffer(value) {
        const bytes = Buffer.from(String(value || ""), "base64");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      getFileSystemManager() {
        return {
          writeFile({ filePath, data, success, fail }) {
            try {
              files.set(filePath, Number(data?.byteLength || 0));
              options.writeFile?.(filePath, data);
              success?.({});
            } catch (error) {
              fail?.(error);
            }
          },
          getFileInfo({ filePath, success, fail }) {
            try {
              const size = options.fileInfo?.(filePath) ?? files.get(filePath);
              if (!Number.isFinite(size)) throw new Error("file missing");
              success?.({ size });
            } catch (error) { fail?.(error); }
          },
          copyFile({ srcPath, destPath, success, fail }) {
            try {
              const size = options.fileInfo?.(srcPath) ?? files.get(srcPath);
              if (!Number.isFinite(size)) throw new Error("source file missing");
              files.set(destPath, size);
              success?.({});
            } catch (error) { fail?.(error); }
          },
          unlink({ filePath, success, fail }) {
            try {
              files.delete(filePath);
              options.unlink?.(filePath);
              success?.({});
            } catch (error) { fail?.(error); }
          }
        };
      },
      downloadFile(request) {
        if (options.downloadFile) return options.downloadFile(request);
        request.fail?.(new Error("downloadFile not configured"));
      },
      request(request) {
        if (options.request) return options.request(request);
        request.fail?.(new Error("request not configured"));
      },
      getStorageSync(key) { return storage.get(key); },
      setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
      removeStorageSync(key) { storage.delete(key); },
      showShareImageMenu(request) {
        if (options.showShareImageMenu) return options.showShareImageMenu(request);
        request.success?.({});
      },
      previewImage(request) {
        if (options.previewImage) return options.previewImage(request);
        request.success?.({});
      },
      setNavigationBarTitle() {},
      stopPullDownRefresh() {}
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(instrumented, context, { filename: "order-detail/index.js" });
  return { helpers: context.__orderDetailHelpers, page: context.page, context, files, storage };
}

function pageInstance(definition, data = {}) {
  return {
    ...definition,
    data: { ...definition.data, ...data },
    setData(changes) { Object.assign(this.data, changes); }
  };
}

function cachedOriginalPath(page, key) {
  const cached = page._originalPhotoCache.get(key);
  return typeof cached === "string" ? cached : cached?.filePath;
}

test("verification manifest always normalizes to five explicit slots without hiding read failures", () => {
  const { helpers, page } = loadHelpers();
  assert.equal(helpers.PHOTO_SLOT_COUNT, 5);
  assert.equal(page.data.photos.length, 5, "the first render already owns five slots");

  const manifest = helpers.normalizePhotoManifest({
    maxPhotos: 5,
    photos: [
      { slot: 0, thumbnailUrl: "https://example.test/profile.jpg", originalBytes: 100 },
      { slot: 2, thumbnailUrl: "", thumbnailError: "PHOTO_THUMBNAIL_UNAVAILABLE", originalBytes: 200 }
    ]
  });
  assert.equal(manifest.slots.length, 5);
  assert.equal(manifest.count, 2);
  assert.deepEqual(Array.from(manifest.slots, (photo) => photo.slot), [0, 1, 2, 3, 4]);
  assert.equal(manifest.slots[0].thumbnailState, "ready");
  assert.equal(manifest.slots[1].state, "empty", "only a successful manifest may establish an empty slot");
  assert.equal(manifest.slots[2].declared, true);
  assert.equal(manifest.slots[2].thumbnailState, "error", "a declared unreadable thumbnail is not an empty slot");
  assert.equal(helpers.buildPhotoSlots("list-error").every((photo) => photo.state === "list-error"), true);
  assert.throws(
    () => helpers.normalizePhotoManifest({ maxPhotos: 5, photos: [{ slot: 2 }, { slot: 2 }] }),
    /无效或重复/
  );
  assert.throws(() => helpers.normalizePhotoManifest({ maxPhotos: 4, photos: [] }), /位置数量/);
});

test("tapping one failed photo rereads and updates only that slot", async () => {
  const calls = [];
  const writes = [];
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`;
  const { page } = loadHelpers({
    async callPhoto(action, payload) {
      calls.push({ action, payload });
      return { ok: true, slot: payload.slot, imageBase64: jpeg, bytes: 4 };
    },
    writeFile(filePath, data) { writes.push({ filePath, bytes: data.byteLength }); }
  });
  const photos = page.data.photos.map((photo) => {
    if (photo.slot === 0) return { ...photo, declared: true, thumbnailState: "ready", thumbnailUrl: "https://example.test/slot-0.jpg" };
    if (photo.slot === 2) return { ...photo, declared: true, thumbnailState: "error", thumbnailUrl: "", retryError: "" };
    return photo;
  });
  const instance = pageInstance(page, { order: { id: "71" }, photos });
  instance._photoLoadEpoch = 1;
  instance._photoRetrySequence = new Map();

  await instance.retryThumbnail({ currentTarget: { dataset: { slot: 2 } } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "getVerificationPhotoThumbnailData");
  assert.equal(calls[0].payload.recordId, "71");
  assert.equal(calls[0].payload.slot, 2);
  assert.equal(writes.length, 1);
  assert.match(writes[0].filePath, /^\/mini-data\/order-photo-preview-71-2-[a-z0-9-]+\.jpg$/,
    "the retried thumbnail path is isolated to this page instance");
  assert.equal(writes[0].bytes, 4);
  assert.equal(instance.data.photos.find((photo) => photo.slot === 0).thumbnailUrl, "https://example.test/slot-0.jpg",
    "an already visible photo stays untouched");
  assert.equal(instance.data.photos.find((photo) => photo.slot === 2).thumbnailUrl, writes[0].filePath);
  assert.equal(instance.data.photos.find((photo) => photo.slot === 2).thumbnailState, "ready");
  assert.equal(instance.data.photos.filter((photo) => photo.retrying).length, 0);
});

test("server-read original type controls the exact visible business kind", () => {
  const { helpers } = loadHelpers();
  assert.equal(helpers.exactOrderKind("VERIFICATION", "NORMAL").noun, "核销");
  assert.equal(helpers.exactOrderKind("VERIFICATION", "EXPERIENCE").noun, "体验核销");
  assert.equal(helpers.exactOrderKind("RECHARGE", "NEW").noun, "充值");
  assert.equal(helpers.exactOrderKind("RECHARGE", "REFUND").noun, "退费");
  assert.match(helpers.requestId(4), /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/);
  assert.equal(helpers.MAX_EXTRA_SOURCE_PHOTO_BYTES, 7 * 1024 * 1024);
  assert.equal(helpers.MAX_EXTRA_UPLOAD_PHOTO_BYTES, 3 * 1024 * 1024);
  assert.equal(helpers.imageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), "jpeg");
  assert.equal(helpers.imageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(helpers.imageFormat(new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50
  ])), "webp");
  assert.equal(helpers.imageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38])), "");

  const jpegPage = { width: 1240, height: 1754, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) };
  const pdf = Buffer.from(helpers.jpegPdf([jpegPage]));
  assert.ok(pdf.toString("latin1").startsWith("%PDF-1.4"));
  assert.ok(pdf.toString("latin1").includes("/Subtype /Image"));
  assert.ok(pdf.toString("latin1").endsWith("%%EOF\n"));

  const multipage = Buffer.from(helpers.jpegPdf([jpegPage, jpegPage]));
  assert.ok(multipage.toString("latin1").includes("/Count 2"), "tall receipts become a real multi-page PDF");
  assert.equal((multipage.toString("latin1").match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) || []).length, 2,
    "every PDF page uses an A4 MediaBox");
});

test("detail renders and acknowledges only the exact server-read route identity", async (context) => {
  const baseRecord = {
    id: "41", recordType: "VERIFICATION", recordCode: "VE202608250041",
    originalType: "NORMAL", recordStatus: "APPROVED", unitCount: 1,
    submittedAt: "2026-08-25T05:19:00.000Z", reviewedAt: "2026-08-25T05:19:00.000Z",
    storeName: "测试门店", customerName: "胡勇", productName: "海洋之蕴", teacherName: "叶吴老师"
  };

  async function run({ route = {}, record = baseRecord, acknowledge = () => true } = {}) {
    const acknowledgeCalls = [];
    const { page } = loadHelpers({
      callFace: async () => ({ record }),
      acknowledge(...args) { acknowledgeCalls.push(args); return acknowledge(...args); }
    });
    const instance = pageInstance(page, {
      session: { role: "teacher" }, loading: false,
      baseType: "VERIFICATION", category: "VERIFICATION",
      recordId: "41", recordCode: "VE202608250041", submissionClientRequestId: "request-normal-41",
      ...route
    });
    instance.loadPhotos = async () => true;
    await instance.load();
    return { instance, acknowledgeCalls };
  }

  const exact = await run();
  assert.equal(exact.instance.data.order.recordCode, "VE202608250041");
  assert.equal(exact.instance.data.order.statusLabel, "已完成", "approved normal verification is completed without review semantics");
  assert.deepEqual(exact.acknowledgeCalls, [["VERIFICATION", "41", "request-normal-41"]]);

  const mismatches = [
    { label: "record id", record: { ...baseRecord, id: "42" } },
    { label: "record code", record: { ...baseRecord, recordCode: "VE202608250099" } },
    { label: "server base type", record: { ...baseRecord, recordType: "RECHARGE" } },
    { label: "category", record: { ...baseRecord, originalType: "EXPERIENCE" } },
    { label: "missing route code", route: { recordCode: "" } }
  ];
  for (const mismatch of mismatches) {
    await context.test(mismatch.label, async () => {
      const result = await run(mismatch);
      assert.equal(result.instance.data.order, null, "a mismatched server detail never renders");
      assert.equal(result.acknowledgeCalls.length, 0, "a mismatched server detail never clears the persistent submission lock");
      assert.equal(result.instance.data.error, true);
    });
  }

  const wrongRequest = await run({ acknowledge: () => false });
  assert.ok(wrongRequest.instance.data.order, "an exact readable order may render even when the local request id differs");
  assert.equal(wrongRequest.instance.data.error, true);
  assert.match(wrongRequest.instance.data.message, /防重复提交锁仍保留/);
});

test("route categories and verification completion labels remain exact", () => {
  const { helpers } = loadHelpers();
  assert.equal(helpers.routeOrderExpectation({ baseType: "RECHARGE", category: "NEW", recordId: "1", recordCode: "RC1" }).category, "RECHARGE");
  assert.equal(helpers.routeOrderExpectation({ baseType: "VERIFICATION", category: "SUPPLEMENT", recordId: "2", recordCode: "VS2" }).originalType, "SUPPLEMENT");
  assert.doesNotThrow(() => helpers.assertExactRouteOrder(
    { baseType: "RECHARGE", category: "VOID", recordId: "3", recordCode: "RV3" },
    { id: "3", recordCode: "RV3", serverBaseType: "RECHARGE", originalType: "NEW", voidStatus: "PENDING" }
  ));
  assert.throws(() => helpers.assertExactRouteOrder(
    { baseType: "RECHARGE", category: "VOID", recordId: "3", recordCode: "RV3" },
    { id: "3", recordCode: "RV3", serverBaseType: "RECHARGE", originalType: "NEW", voidStatus: "NONE" }
  ), /不是详情链接指定的作废业务/);
  assert.equal(helpers.detailStatusLabel("VERIFICATION", "NORMAL", "APPROVED"), "已完成");
  assert.equal(helpers.detailStatusLabel("VERIFICATION", "EXPERIENCE", "APPROVED"), "已完成");
  assert.equal(helpers.detailStatusLabel("VERIFICATION", "SUPPLEMENT", "APPROVED"), "审核通过");
});

test("real order data is mapped into the shared web receipt semantics", () => {
  const { helpers } = loadHelpers();
  const base = {
    recordCode: "RC202608250036", typeLabel: "正常核销", originalType: "NORMAL",
    storeName: "测试门店", storeAddress: "江西省测试路 1 号", customerName: "胡勇",
    customerCode: "C1-A3155559265B1691",
    productName: "海洋之蕴", teacherName: "叶吴老师", unitCount: 2,
    submittedAt: "2026-08-25 13:19:00", reviewedAt: "2026-08-25 13:21:00"
  };
  const template = {
    productName: "海洋之蕴", productType: "护理", logo: { reference: "private/logo" },
    verificationInstructions: "核销说明", rechargeInstructions: "充值说明"
  };
  const verification = helpers.receiptDocumentData(base, "VERIFICATION", template);
  assert.equal(verification.title, "核销单 RC202608250036");
  assert.equal(verification.compactVerification, true);
  assert.equal(verification.subtitle, "门店详细地址：江西省测试路 1 号");
  assert.deepEqual(Array.from(verification.facts, (item) => item.label), ["客户", "项目", "门店", "业务老师"],
    "verification exports use the same compact identity layout as recharge receipts");
  assert.equal(verification.facts[0].label, "客户");
  assert.equal(verification.facts[0].value, "胡勇 · C1-A3155559265B1691");
  assert.equal(verification.facts[0].singleLine, true,
    "app receipts print the complete customer name and number together without wrapping");
  assert.deepEqual(Array.from(verification.details, (item) => item.label), ["工单类型", "次数", "提交时间"]);
  assert.equal(verification.details[2].span, 2, "the complete submitted time owns a full-width receipt row");
  assert.equal(verification.productTemplate.instructions, "核销说明");
  assert.equal(verification.productTemplate.logoRequired, true);
  const experience = helpers.receiptDocumentData({ ...base, typeLabel: "体验核销", originalType: "EXPERIENCE" }, "VERIFICATION", template);
  assert.doesNotMatch(JSON.stringify(experience), /审核时间/, "EXPERIENCE omits review time like NORMAL");

  const supplement = helpers.receiptDocumentData({ ...base, typeLabel: "历史补录", originalType: "SUPPLEMENT" }, "VERIFICATION", template);
  assert.doesNotMatch(JSON.stringify(supplement), /审核时间/, "verification receipts never print an approval-time field");

  const refund = helpers.receiptDocumentData({ ...base, typeLabel: "退费申请", originalType: "REFUND" }, "RECHARGE", template);
  assert.equal(refund.title, "退费单 RC202608250036");
  assert.equal(refund.detailTitle, "退费信息");
  assert.deepEqual(Array.from(refund.details, (item) => item.label), ["退费次数", "提交时间", "审核时间"]);
  assert.equal(refund.productTemplate.instructions, "充值说明");

  const recharge = helpers.receiptDocumentData({
    ...base, originalType: "NEW", message: "门店留言", reviewNote: "总部留言", voidNote: "作废原因",
    voidSubmittedAt: "2026-08-25 14:00:00"
  }, "RECHARGE", template);
  assert.deepEqual(Array.from(recharge.messages, (item) => item.label), [],
    "all customer-facing PDF and image exports omit internal messages");

  assert.equal(Object.hasOwn(verification, "photos"), false,
    "receipt semantics never carry verification photos into PDF or image exports");
});

test("verification photo UI has focused recovery, 24-hour originals, album save, forwarding, and server-authorized editing", () => {
  for (const action of [
    "getVerificationPhotos", "getVerificationPhotoThumbnailData", "getVerificationPhotoOriginalUrl",
    "beginVerificationPhotoUpload", "getVerificationPhotoUploadStatus", "cancelVerificationPhotoUpload",
    "commitVerificationPhotoUpload"
  ]) includes(js, `\"${action}\"`, `photo action ${action}`);
  includes(js, "canEdit: result.canEdit === true", "edit permission comes from the manifest");
  includes(js, "editableUntil: result.editableUntil", "edit deadline comes from the manifest");
  includes(js, "slot < 2 || slot > 4", "only extra slots can be changed");
  includes(js, "begin.uploadMode !== \"DIRECT\"", "the mini-program accepts only the dedicated signed direct-upload mode");
  includes(js, "await this.uploadExtraPhotoDirect(begin.originalUpload, buffer)", "the normalized JPEG bytes go directly to private storage");
  includes(js, 'header: { "Content-Type": "image/jpeg" }', "the signed PUT carries the exact JPEG MIME type");
  assert.doesNotMatch(functionSource(js, "uploadExtraPhoto"), /arrayBufferToBase64|imageBase64|functionUploadProof/,
    "the mini-program supplemental-photo path never Base64-expands or relays image bytes through a cloud function");
  includes(js, "sourceBytes.byteLength > MAX_EXTRA_SOURCE_PHOTO_BYTES", "source selection is capped at 7 MB");
  includes(js, "bytes.byteLength <= MAX_EXTRA_UPLOAD_PHOTO_BYTES", "normalized JPEG remains within the server's 3 MB contract");
  includes(js, 'fileType: "jpg"', "PNG and WebP sources are re-encoded as JPEG before upload");
  includes(js, 'return "png"', "PNG source magic bytes are accepted");
  includes(js, 'return "webp"', "WebP source magic bytes are accepted");
  includes(js, "await this.loadPhotos();", "a successful write rereads the database manifest");
  includes(js, "this.data.uploading || this.data.photoLoading", "concurrent writes and manifest reloads are isolated");
  includes(js, "const { saveImageToAlbum, isPermissionFailure }", "album permission behavior and retry classification are shared");
  assert.doesNotMatch(js, /wx\.saveImageToPhotosAlbum/, "order detail cannot bypass the shared permission-and-retry helper");

  includes(wxml, 'wx:for="{{photos}}"', "five-slot renderer");
  includes(wxml, 'bindtap="retryPhotoList"', "list retry");
  includes(wxml, 'bindtap="retryThumbnail"', "per-slot thumbnail retry");
  includes(wxml, 'catchtap="retryThumbnail"', "the retry button cannot bubble into a duplicate request");
  includes(wxml, "点击重新加载这张照片", "the complete failed-photo area explains focused recovery");
  includes(js, "photoPreviewPath(orderId, slot, this._photoPageToken)", "one retried thumbnail is written to a page-owned local file instead of large setData Base64");
  includes(js, "sequence !== Number(this._photoRetrySequence?.get(slot)", "a late focused retry cannot replace a newer slot state");
  assert.doesNotMatch(functionSource(js, "retryThumbnail"), /loadPhotos\(/,
    "clicking one failed photo cannot reload the complete five-photo manifest");
  includes(wxml, 'bindtap="previewPhoto"', "authorized original preview");
  includes(wxml, 'bindtap="savePhoto"', "authorized original album save");
  includes(js, "this._originalPhotoFlights = new Map()", "same-slot original reads are coalesced in flight");
  includes(js, "this._originalPhotoCache = new Map()", "the page owns an in-memory original-file cache");
  includes(js, "const existing = this._originalPhotoFlights.get(key)", "a duplicate slot read joins its current request");
  includes(js, "await fileInfo(cachedPath)", "cached originals are reused only while their local file still exists");
  includes(js, "ORIGINAL_PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000", "originals persist for one day");
  includes(js, "ORIGINAL_PHOTO_CACHE_STORAGE_KEY", "persistent cache metadata survives page navigation");
  includes(js, '"getVerificationPhotoExportData"', "a domain-list failure falls back to authenticated inline bytes");
  includes(js, "STALE_PHOTO_GENERATION", "a replaced manifest invalidates an older original-photo generation");
  includes(js, "wx.showShareImageMenu", "downloaded originals can be forwarded from WeChat");
  includes(wxml, 'bindtap="sharePhoto"', "each original has a direct forward action");
  includes(wxml, 'wx:if="{{photoViewerOpen}}"', "the enlarged viewer is app-controlled");
  assert.match(wxml, /(?:bindtap|catchtap)="shareViewerPhoto"/, "the enlarged viewer also exposes forwarding");
  assert.doesNotMatch(functionSource(js, "onUnload"), /clearOriginalPhotoCache/,
    "leaving the page must not delete the 24-hour original cache");
  assert.doesNotMatch(wxml, /originalBusySlot/, "one slow photo cannot disable every other photo slot");
  assert.match(wxml, /disabled="\{\{item\.originalBusy \|\| uploading\}\}"/,
    "only the active slot is disabled while its original is loading");
  includes(wxml, "photoLoading || item.originalBusy", "a supplemental replacement cannot race the same slot's original read");
  includes(wxml, 'bindtap="uploadExtraPhoto"', "choose-or-capture extra photo");
  includes(functionSource(js, "uploadExtraPhoto"), "photo?.originalBusy",
    "the page handler also rejects a replacement while that slot's original is in flight");
  includes(wxml, "canEdit && item.slot >= 2", "server-authorized edit buttons");
  includes(wxml, 'id="photoNormalizeCanvas"', "a dedicated hidden canvas normalizes supplemental source images");
  assert.match(wxss, /\.photo-card\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s,
    "each photo cell must clip its own controls instead of painting into its neighbor");
  assert.match(wxss, /\.photo-actions button, \.upload-button, \.compact-button\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*box-sizing:\s*border-box;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s,
    "photo controls must fit their grid cell and center the label on real devices");
  assert.match(wxss, /\.upload-button\s*\{[^}]*width:\s*100%;[^}]*justify-self:\s*stretch;/s,
    "each supplemental-photo button occupies only its own bounded card width");
  assert.doesNotMatch(wxml, /photos\.length|暂无核销照片/, "a read failure cannot become a no-photo screen");
  assert.doesNotMatch(`${js}\n${wxml}`, /\bKB\b|不压缩|未压缩/, "size/compression explanations are retired");
});

test("supplemental JPEG uses an exact signed PUT without Base64 expansion", async () => {
  const requests = [];
  const { page } = loadHelpers({
    request(options) {
      requests.push(options);
      options.success({ statusCode: 200, data: "" });
      return {};
    }
  });
  const instance = pageInstance(page);
  const buffer = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
  await instance.uploadExtraPhotoDirect({
    url: "https://private.example.test/object.jpg?token=short-lived",
    method: "PUT",
    expectedBytes: 4,
    headers: { Authorization: "must-not-be-forwarded" }
  }, buffer);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].data, buffer, "wx.request receives the original ArrayBuffer without copying it into text");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].header)), { "Content-Type": "image/jpeg" },
    "only the signed MIME contract is sent; arbitrary response headers are ignored");
  assert.equal(requests[0].timeout, 180000);

  await assert.rejects(
    instance.uploadExtraPhotoDirect({
      url: "https://private.example.test/object.jpg?token=short-lived",
      method: "PUT",
      expectedBytes: 5
    }, buffer),
    /大小与服务器授权不一致/,
    "the mini-program refuses a byte count that does not match the signed intent"
  );
});

test("original photo reads are single-flight, persist for 24 hours, and survive page unload", async () => {
  let releaseFirst;
  let calls = 0;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const sharedFiles = new Map();
  const sharedStorage = new Map();
  const options = {
    files: sharedFiles,
    storage: sharedStorage,
    callPhoto(action, payload) {
      assert.equal(action, "getVerificationPhotoOriginalUrl");
      calls += 1;
      if (payload.slot === 0 && calls === 1) return first;
      return Promise.resolve({ slot: payload.slot, photoUrl: "data:image/jpeg;base64,/9j/2Q==", originalBytes: 4 });
    }
  };
  const { page: definition, helpers } = loadHelpers(options);
  const page = pageInstance(definition, {
    order: { id: "order-1" },
    photos: [
      { slot: 0, declared: true, originalBytes: 4, originalBusy: false },
      { slot: 1, declared: true, originalBytes: 4, originalBusy: false }
    ]
  });
  page._photoLoadEpoch = 1;
  const pendingA = page.originalPhotoLocalPath(0);
  const pendingB = page.originalPhotoLocalPath(0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1, "two simultaneous reads of one slot share one cloud call");
  releaseFirst({ slot: 0, photoUrl: "data:image/jpeg;base64,/9j/2Q==", originalBytes: 4 });
  const [pathA, pathB] = await Promise.all([pendingA, pendingB]);
  assert.equal(pathA, pathB);
  assert.equal(await page.originalPhotoLocalPath(0), pathA, "the page reuses its local file instead of a signed URL or Base64 value");
  assert.equal(calls, 1);
  const pathOther = await page.originalPhotoLocalPath(1);
  assert.equal(calls, 2, "another slot owns an independent read");
  assert.notEqual(pathOther, pathA);
  assert.equal(cachedOriginalPath(page, "order-1:0"), pathA);
  assert.equal(/^https:|^data:/i.test(cachedOriginalPath(page, "order-1:0")), false);
  assert.equal(sharedFiles.size, 2);
  const cacheIndex = sharedStorage.get(helpers.ORIGINAL_PHOTO_CACHE_STORAGE_KEY);
  assert.equal(cacheIndex["order-1:0"].expiresAt - cacheIndex["order-1:0"].cachedAt, helpers.ORIGINAL_PHOTO_CACHE_TTL_MS);

  page.onUnload();
  await Promise.resolve();
  assert.equal(page._originalPhotoCache.size, 0);
  assert.equal(sharedFiles.size, 2, "24-hour originals are not deleted when the detail page closes");

  const { page: nextDefinition } = loadHelpers(options);
  const nextPage = pageInstance(nextDefinition, {
    order: { id: "order-1" },
    photos: [{ slot: 0, declared: true, originalBytes: 4, originalBusy: false }]
  });
  nextPage._photoLoadEpoch = 1;
  assert.equal(await nextPage.originalPhotoLocalPath(0), pathA, "a later page reuses the persisted original");
  assert.equal(calls, 2, "the server is not called again while the 24-hour cache remains valid");
});

test("signed original URL failures fall back to authenticated bytes and never retain the URL", async () => {
  const signedUrls = [];
  const actions = [];
  const { page: definition } = loadHelpers({
    callPhoto(action, payload) {
      actions.push(action);
      if (action === "getVerificationPhotoOriginalUrl") {
        return Promise.resolve({ slot: payload.slot, photoUrl: `https://signed.example.test/photo-${payload.slot}?token=secret`, originalBytes: 4 });
      }
      if (action === "getVerificationPhotoExportData") {
        return Promise.resolve({ slot: payload.slot, imageBase64: "data:image/jpeg;base64,/9j/2Q==", bytes: 4 });
      }
      throw new Error(`unexpected photo action ${action}`);
    },
    downloadFile(request) {
      signedUrls.push(request.url);
      request.fail({ errMsg: "downloadFile:fail url not in domain list" });
    }
  });
  const page = pageInstance(definition, {
    order: { id: "order-signed" },
    photos: [{ slot: 0, declared: true, originalBytes: 4, originalBusy: false, originalAction: "" }]
  });
  page._photoLoadEpoch = 1;
  const localPath = await page.originalPhotoLocalPath(0);
  assert.match(localPath, /order-photo-cache-order-signed-0-/);
  assert.equal(cachedOriginalPath(page, "order-signed:0"), localPath);
  assert.equal(JSON.stringify(page.data).includes("signed.example.test"), false);
  assert.equal(JSON.stringify(Array.from(page._originalPhotoCache.values())).includes("signed.example.test"), false);
  assert.equal(signedUrls.length, 1);
  assert.deepEqual(actions, ["getVerificationPhotoOriginalUrl", "getVerificationPhotoExportData"]);
  assert.equal(await page.originalPhotoLocalPath(0), localPath);
  assert.equal(signedUrls.length, 1, "the fallback result is cached rather than downloaded again");
});

test("a missing cached file invalidates and rereads only its own slot", async () => {
  let calls = 0;
  const { page: definition, files } = loadHelpers({
    callPhoto(action, payload) {
      assert.equal(action, "getVerificationPhotoOriginalUrl");
      calls += 1;
      return Promise.resolve({ slot: payload.slot, photoUrl: "data:image/jpeg;base64,/9j/2Q==", originalBytes: 4 });
    }
  });
  const page = pageInstance(definition, {
    order: { id: "order-missing-cache" },
    photos: [
      { slot: 0, declared: true, originalBytes: 4, originalBusy: false },
      { slot: 1, declared: true, originalBytes: 4, originalBusy: false }
    ]
  });
  page._photoLoadEpoch = 1;
  const firstPath = await page.originalPhotoLocalPath(0);
  const untouchedPath = await page.originalPhotoLocalPath(1);
  assert.equal(calls, 2);

  files.delete(firstPath);
  const refreshedPath = await page.originalPhotoLocalPath(0);
  assert.equal(calls, 3, "only the missing slot is fetched again");
  assert.equal(refreshedPath, firstPath, "the stable cache filename is restored after a missing-file reread");
  assert.equal(cachedOriginalPath(page, "order-missing-cache:1"), untouchedPath);
  assert.equal(files.has(untouchedPath), true, "another slot's valid local file is preserved");
});

test("a manifest replacement invalidates the old slot generation and rejects its late flight", async () => {
  let releaseOld;
  let calls = 0;
  const oldSource = new Promise((resolve) => { releaseOld = resolve; });
  const { page: definition } = loadHelpers({
    callPhoto(action, payload) {
      assert.equal(action, "getVerificationPhotoOriginalUrl");
      calls += 1;
      if (calls === 1) return oldSource;
      return Promise.resolve({ slot: payload.slot, photoUrl: "data:image/jpeg;base64,/9j/2Q==", originalBytes: 4 });
    }
  });
  const page = pageInstance(definition, { order: { id: "order-replaced" }, noun: "核销" });
  page._photoLoadEpoch = 1;
  page.applyPhotoManifest({
    maxPhotos: 5,
    photos: [{ slot: 2, originalBytes: 4, uploadedAt: "2026-08-29T00:00:00Z" }]
  });
  const oldOutcome = page.originalPhotoLocalPath(2).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);

  page.applyPhotoManifest({
    maxPhotos: 5,
    photos: [{ slot: 2, originalBytes: 4, uploadedAt: "2026-08-29T00:01:00Z" }]
  });
  const freshPath = await page.originalPhotoLocalPath(2);
  assert.equal(calls, 2, "the new manifest starts a new slot generation immediately");
  releaseOld({ slot: 2, photoUrl: "data:image/jpeg;base64,/9j/2Q==", originalBytes: 4 });
  const stale = await oldOutcome;
  assert.equal(stale.error?.code, "STALE_PHOTO_GENERATION");
  assert.equal(cachedOriginalPath(page, "order-replaced:2"), freshPath,
    "the late old flight cannot overwrite the replacement generation's cache");
});

test("preview, album save, direct forwarding, and viewer forwarding reuse one local original", async () => {
  let photoCalls = 0;
  let saveCalls = 0;
  let shareCalls = 0;
  const { page: definition } = loadHelpers({
    callPhoto(action, payload) {
      assert.equal(action, "getVerificationPhotoOriginalUrl");
      photoCalls += 1;
      return Promise.resolve({ slot: payload.slot, photoUrl: "data:image/jpeg;base64,/9j/2Q==", originalBytes: 4 });
    },
    async saveImageToAlbum() {
      saveCalls += 1;
      return { saved: true };
    },
    showShareImageMenu(request) {
      shareCalls += 1;
      request.success({});
    }
  });
  const page = pageInstance(definition, {
    order: { id: "order-2" },
    photos: [
      { slot: 0, declared: true, originalBytes: 4, originalBusy: false, originalAction: "" },
      { slot: 1, declared: true, originalBytes: 4, originalBusy: false, originalAction: "" }
    ]
  });
  page._photoLoadEpoch = 1;
  const firstSlotPath = await page.originalPhotoLocalPath(0);
  assert.equal(photoCalls, 1);

  await page.previewPhoto({ currentTarget: { dataset: { slot: 0 } } });
  assert.equal(page.data.photoViewerOpen, true);
  assert.equal(page.data.photoViewerPath, firstSlotPath);
  assert.equal(page.data.error, false);

  await page.savePhoto({ currentTarget: { dataset: { slot: 0 } } });
  await page.sharePhoto({ currentTarget: { dataset: { slot: 0 } } });
  await page.saveViewerPhoto();
  await page.shareViewerPhoto();
  assert.equal(saveCalls, 2);
  assert.equal(shareCalls, 2);
  assert.equal(photoCalls, 1, "all actions reuse the exact same local original without repeat requests");
  assert.equal(page.data.message, "原图已保存到系统相册。");
});

test("all four order categories export actual receipts without exporting verification photos", () => {
  for (const action of ["getProductReceiptTemplate", "getProductReceiptLogoData"]) {
    includes(js, `\"${action}\"`, `export action ${action}`);
  }
  assert.doesNotMatch(js, /verificationPhotosForExport|const receiptPhotos = RECEIPT_PHOTO_SLOTS\.map/,
    "verification originals never enter receipt export");
  includes(js, "template.verificationInstructions", "verification and experience use the verification receipt instructions");
  includes(js, "template.rechargeInstructions", "recharge and refund use the recharge receipt instructions");
  includes(js, 'require("../../services/order-receipt")', "real orders import the same receipt service as product previews");
  includes(js, "renderReceiptCanvas({", "real orders use the shared canvas layout");
  includes(functionSource(js, "renderSharedReceipt"), "photos: []", "every exported order receipt explicitly renders with no photos");
  includes(js, "exportReceiptJpegs(receipt, this)", "real orders use the shared A4/long-image splitter");
  includes(js, "const pages = await this.readReceiptPdfPages(receipt.images)", "PDF reads the shared A4 page images");
  includes(js, "const pdf = jpegPdf(pages)", "PDF uses the shared multi-page JPEG-to-PDF helper");
  includes(js, "wx.openDocument({", "PDF opens in the WeChat native document viewer");
  includes(js, "showMenu: true", "the native document viewer exposes its share and save menu");
  assert.doesNotMatch(js, /shareFileMessage/,
    "the async receipt renderer cannot invoke shareFileMessage after the original TAP gesture expires");
  includes(js, "saveImageToAlbum(receipt.images[0].path)", "receipt image is saved to the authorized album flow");
  assert.doesNotMatch(js, /instructionLayout|drawPhotoCell|canvasPdfPages|PDF_CANVAS_PAGE_HEIGHT/,
    "order detail must not retain a second hand-written receipt renderer");
  const productDetail = fs.readFileSync(path.join(root, "miniprogram-app", "miniprogram", "pages", "product-detail", "index.js"), "utf8");
  includes(productDetail, 'require("../../services/order-receipt")', "product previews import the shared receipt service too");
  includes(wxml, 'bindtap="exportPdf"', "PDF export button");
  includes(wxml, 'bindtap="exportImage"', "image export button");
  includes(wxml, 'id="receiptCanvas"', "native mini-program export canvas");
});

test("normal and experience details omit review time while supplement review remains visible", () => {
  includes(wxml, "baseType === 'RECHARGE' || order.originalType === 'SUPPLEMENT'", "review-time visibility contract");
  assert.equal((wxml.match(/<text>审核时间<\/text>/g) || []).length, 1, "there is only one guarded review-time row");
  includes(js, 'request.baseType === "RECHARGE" || clean(order.originalType).toUpperCase() === "SUPPLEMENT"',
    "normal and experience records do not render a review note either");
  includes(js, "exactOrderKind(request.baseType, order.originalType)", "database original type corrects the immutable route hint");
  includes(js, 'wx.setNavigationBarTitle({ title: "露思卓儿" })', "authenticated order pages retain the native brand title");
  assert.match(wxss, /\.detail-grid \.detail-value \{[^}]*font-weight:\s*800;/);
  assert.match(wxss, /\.detail-grid text \{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/,
    "detail scalar values are one-line ellipsized");
  const orderTitleRule = wxss.match(/\.order-title \{[^}]*\}/)?.[0] || "";
  const orderTitleScrollRule = wxss.match(/\.order-title-scroll \{[^}]*\}/)?.[0] || "";
  assert.match(wxml, /<scroll-view class="order-title-scroll" scroll-x="true"[^>]*><text class="order-title">/, "the full order number owns an internal horizontal scroller");
  assert.match(orderTitleScrollRule, /width:\s*100%/);
  assert.match(orderTitleScrollRule, /max-width:\s*100%/);
  assert.match(orderTitleScrollRule, /overflow:\s*hidden/, "the long title cannot paint outside its card");
  assert.match(orderTitleRule, /white-space:\s*nowrap/, "the hero order number stays on one line");
  assert.doesNotMatch(orderTitleRule, /text-overflow:\s*ellipsis|overflow:\s*hidden|overflow-wrap:/,
    "the hero order number remains complete instead of being clipped or wrapped");
  const titleSize = Number(/font-size:\s*([0-9.]+)rpx/.exec(orderTitleRule)?.[1] || 0);
  assert.ok(titleSize > 0 && titleSize <= 30, "the complete one-line order number remains compact enough for narrow cards");
  assert.match(wxss, /\.order-hero \{[^}]*flex-direction:\s*column;/,
    "the title owns a full row and the status badge moves below it");
  assert.doesNotMatch(wxss, /word-break:\s*break-all/, "detail values no longer break every character");
});


test("rating access denial is quiet and not retried, while transport failure stays retryable", async () => {
  let calls = 0;
  let code = "FORBIDDEN";
  const { page: definition } = loadHelpers({ callRating: async () => {
    calls++;
    const error = new Error("示例读取失败"); error.code = code; throw error;
  } });
  const page = pageInstance(definition, { baseType: "VERIFICATION", order: { id: "qa-1", originalType: "NORMAL" } });
  await page.loadRating();
  assert.equal(page.data.ratingRestricted, true);
  assert.equal(page.data.ratingError, "");
  assert.equal(await page.retryRating(), false);
  assert.equal(calls, 1);
  // A fresh order load clears the presentation state and defers authorization to the server again.
  code = "FUNCTION_INVOCATION_FAILED";
  page.data.order = { id: "qa-2", originalType: "EXPERIENCE" };
  await page.loadRating();
  assert.equal(page.data.ratingRestricted, false);
  assert.equal(page.data.ratingError, "示例读取失败");
  await page.retryRating();
  assert.equal(calls, 3);
});

test("a late rating denial cannot overwrite another order's rating state", async () => {
  let rejectRequest;
  const { page: definition } = loadHelpers({ callRating: () => new Promise((_, reject) => { rejectRequest = reject; }) });
  const page = pageInstance(definition, { baseType: "VERIFICATION", order: { id: "qa-1", originalType: "NORMAL" } });
  const request = page.loadRating();
  page.setData({ order: { id: "qa-2", originalType: "NORMAL" }, ratingLoading: false, ratingRestricted: false, ratingError: "" });
  const error = new Error("旧工单评价不可见"); error.code = "FORBIDDEN"; rejectRequest(error);
  await request;
  assert.equal(page.data.ratingRestricted, false);
  assert.equal(page.data.ratingLoading, false);
  assert.equal(page.data.ratingError, "");
});
