const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../miniprogram-app/miniprogram/pages/training-materials/index.js`, "utf8");
const tap = { currentTarget: { dataset: { id: "pdf" } } };

function harness(options = {}) {
  let page, current = { staffId: "teacher", uid: "uid", role: options.role || "teacher" };
  const calls = [], opened = [], loading = [], invalidated = [];
  let openCount = 0;
  vm.runInNewContext(source, {
    Page: (value) => { page = value; },
    getApp: () => ({ globalData: { startupReady: true, session: current } }),
    require: (name) => {
      if (name.endsWith("session")) return { requireSession: () => current };
      if (name.endsWith("api")) return { callStaff: async (action) => {
        calls.push(action);
        if (options.access) return options.access();
        if (options.denied) throw Object.assign(new Error("denied"), { code: options.denied });
        return { access: { url: "https://private.example.test/signed" } };
      } };
      if (name.endsWith("training-material-cache")) return {
        find: async () => { calls.push("cache"); return options.cached || ""; },
        store: async () => { calls.push("store"); if (options.cacheFull) throw new Error("disk full"); return options.emptyCache ? "" : "/private/good.pdf"; },
        invalidate: async (id) => { invalidated.push(id); }
      };
      return {};
    },
    wx: {
      showLoading: (value) => loading.push(value.title), hideLoading: () => {},
      downloadFile: (request) => {
        calls.push("download");
        queueMicrotask(() => {
          if (options.downloadError) request.fail({ errMsg: options.downloadError });
          else request.success({ statusCode: options.http || 200, tempFilePath: "/temp/new.pdf" });
        });
        return { onProgressUpdate: (callback) => callback({ progress: 34 }), abort: () => {} };
      },
      getFileSystemManager: () => ({ getFileInfo: ({ success }) => success({ size: options.bytes ?? 280 * 1024 }) }),
      openDocument: (request) => {
        opened.push({ filePath: request.filePath, showMenu: request.showMenu, fileType: request.fileType });
        if (options.allOpenFail || options.firstOpenFail && openCount++ === 0) request.fail({ errMsg: "openDocument:fail invalid file" });
        else request.success({});
      }
    }
  });
  page.data = { ...page.data, session: { ...current }, materials: [{ id: "pdf", title: "测试", bytes: 280 * 1024 }], isHq: current.role === "hq" };
  page.setData = (data) => Object.assign(page.data, data);
  return { page, calls, opened, loading, invalidated, switchActor: () => { current = { ...current, staffId: "other", uid: "other-uid" }; } };
}

test("teacher reauthorizes cached PDF, reuses bytes and disables native document menu", async () => {
  const h = harness({ cached: "/private/cached.pdf" });
  await h.page.openMaterial(tap);
  assert.deepEqual(h.calls, ["getTrainingMaterialAccess", "cache"]);
  assert.deepEqual(h.opened, [{ filePath: "/private/cached.pdf", showMenu: false, fileType: "pdf" }]);
});

test("downlisted or forbidden PDF cannot be opened from teacher cache", async () => {
  for (const denied of ["NOT_FOUND", "FORBIDDEN"]) {
    const h = harness({ cached: "/private/cached.pdf", denied });
    await h.page.openMaterial(tap);
    assert.deepEqual(h.calls, ["getTrainingMaterialAccess"]);
    assert.equal(h.opened.length, 0);
    assert.deepEqual(h.invalidated, ["pdf"]);
    assert.equal(h.page.data.error, true);
  }
});

test("fresh PDF uses real download progress and byte validation before caching", async () => {
  const h = harness(); await h.page.openMaterial(tap);
  assert.deepEqual(h.calls, ["getTrainingMaterialAccess", "cache", "download", "store"]);
  assert.ok(h.loading.includes("读取 PDF 34%"));
  assert.equal(h.opened[0].filePath, "/private/good.pdf");
});

test("partial PDF is never cached or opened", async () => {
  const h = harness({ bytes: 8 }); await h.page.openMaterial(tap);
  assert.equal(h.opened.length, 0);
  assert.ok(!h.calls.includes("store"));
  assert.equal(h.page.data.message, "PDF 文件不完整，请重新读取");
});

test("failed native cached PDF is invalidated and redownloaded exactly once", async () => {
  const h = harness({ cached: "/private/broken.pdf", firstOpenFail: true });
  await h.page.openMaterial(tap);
  assert.deepEqual(h.invalidated, ["pdf"]);
  assert.equal(h.calls.filter((call) => call === "download").length, 1);
  assert.equal(h.opened.length, 2);
  assert.equal(h.page.data.error, false);
});

test("native failure after one refresh does not loop or keep a broken cache", async () => {
  const h = harness({ cached: "/private/broken.pdf", allOpenFail: true });
  await h.page.openMaterial(tap);
  assert.equal(h.opened.length, 2);
  assert.equal(h.invalidated.length, 2);
  assert.equal(h.page.data.error, true);
});

test("full/unavailable cache can open only the already byte-verified temp PDF", async () => {
  for (const options of [{ cacheFull: true }, { emptyCache: true }]) {
    const h = harness(options); await h.page.openMaterial(tap);
    assert.equal(h.opened[0].filePath, "/temp/new.pdf");
  }
});

test("domain and network failures have actionable Chinese rather than raw signed URLs", async () => {
  for (const [downloadError, message] of [
    ["downloadFile:fail url not in domain list https://private.example.test/?token=secret", "PDF 下载域名未配置，请联系总部"],
    ["downloadFile:fail timeout", "PDF 读取超时，请重试"],
    ["downloadFile:fail network error", "网络连接失败，请重试"]
  ]) {
    const h = harness({ downloadError }); await h.page.openMaterial(tap);
    assert.equal(h.opened.length, 0);
    assert.equal(h.page.data.message, message);
  }
});

test("unloaded page or switched account cannot open a late authorized document", async () => {
  for (const unload of [false, true]) {
    let resolveAccess;
    const h = harness({ access: () => new Promise((resolve) => { resolveAccess = resolve; }) });
    const operation = h.page.openMaterial(tap);
    if (unload) h.page.onUnload(); else h.switchActor();
    resolveAccess({ access: { url: "https://private.example.test/signed" } });
    await operation;
    assert.equal(h.opened.length, 0);
    assert.ok(!h.calls.includes("cache"));
  }
});
