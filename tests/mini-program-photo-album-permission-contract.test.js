const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const helperPath = path.join(__dirname, "..", "miniprogram-app", "miniprogram", "services", "photo-album.js");

function callback(result, options) {
  process.nextTick(() => result instanceof Error ? options.fail(result) : options.success(result));
}

test("every denied album save asks to open settings again", async () => {
  let modalCalls = 0;
  global.wx = {
    getSetting(options) { callback({ authSetting: { "scope.writePhotosAlbum": false } }, options); },
    showModal(options) { modalCalls += 1; callback({ confirm: false, cancel: true }, options); },
    openSetting(options) { callback({ authSetting: { "scope.writePhotosAlbum": false } }, options); },
    saveImageToPhotosAlbum(options) { callback({ errMsg: "ok" }, options); }
  };
  delete require.cache[require.resolve(helperPath)];
  const { saveImageToAlbum } = require(helperPath);

  await assert.rejects(() => saveImageToAlbum("/tmp/a.jpg"), /下次点击保存时会再次询问/);
  await assert.rejects(() => saveImageToAlbum("/tmp/a.jpg"), /下次点击保存时会再次询问/);
  assert.equal(modalCalls, 2);
  delete global.wx;
});

test("opening settings continues the same album save", async () => {
  let permission = false;
  let saveCalls = 0;
  global.wx = {
    getSetting(options) { callback({ authSetting: { "scope.writePhotosAlbum": permission } }, options); },
    showModal(options) { callback({ confirm: true, cancel: false }, options); },
    openSetting(options) { permission = true; callback({ authSetting: { "scope.writePhotosAlbum": true } }, options); },
    saveImageToPhotosAlbum(options) { saveCalls += 1; callback({ errMsg: "ok" }, options); }
  };
  delete require.cache[require.resolve(helperPath)];
  const { saveImageToAlbum } = require(helperPath);

  await saveImageToAlbum("/tmp/a.jpg");
  assert.equal(saveCalls, 1);
  delete global.wx;
});
