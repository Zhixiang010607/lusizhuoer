const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.resolve(__dirname, "../miniprogram-app/miniprogram/services/training-material-cache.js");

test("training PDF cache reuses the same private file and invalidates changed content", async () => {
  const files = new Map([["/tmp/first.pdf", 128]]);
  let stored = [];
  let copyCount = 0;
  global.wx = {
    env: { USER_DATA_PATH: "/private" },
    getStorageSync() { return stored; },
    setStorageSync(_key, value) { stored = JSON.parse(JSON.stringify(value)); },
    getFileSystemManager() {
      return {
        getFileInfo({ filePath, success, fail }) {
          if (files.has(filePath)) success({ size: files.get(filePath) });
          else fail({ errMsg: "not found" });
        },
        copyFile({ srcPath, destPath, success, fail }) {
          if (!files.has(srcPath)) return fail({ errMsg: "not found" });
          copyCount += 1;
          files.set(destPath, files.get(srcPath));
          success({});
        },
        unlink({ filePath, success, fail }) {
          if (files.delete(filePath)) success({});
          else fail({ errMsg: "not found" });
        }
      };
    }
  };

  delete require.cache[modulePath];
  const cache = require(modulePath);
  const first = { id: "7", bytes: 128, publishedAt: "2026-10-12T01:00:00Z" };
  assert.equal(await cache.find(first), "");
  const cachedPath = await cache.store("/tmp/first.pdf", first);
  assert.match(cachedPath, /^\/private\/training-material-cache-7-/);
  assert.equal(copyCount, 1);
  assert.equal(await cache.find(first), cachedPath);
  assert.equal(copyCount, 1, "reopening the same PDF must not download or copy it again");

  const changed = { ...first, publishedAt: "2026-10-12T02:00:00Z" };
  assert.equal(await cache.find(changed), "");
  await cache.invalidate(first.id);
  assert.equal(stored.length, 0);
  delete global.wx;
});
