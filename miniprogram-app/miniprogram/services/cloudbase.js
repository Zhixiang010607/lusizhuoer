const config = require("../config/env");

let app = null;
let auth = null;

function moduleDefault(value) { return value && value.default ? value.default : value; }

function getApp() {
  if (app) return app;
  const cloudbase = moduleDefault(require("@cloudbase/js-sdk"));
  const adapter = moduleDefault(require("@cloudbase/adapter-wx_mp"));
  if (!cloudbase || typeof cloudbase.init !== "function") throw new Error("CloudBase 小程序 SDK 尚未构建，请先执行 pnpm install --frozen-lockfile，并在微信开发者工具中构建 npm");
  if (typeof cloudbase.useAdapters === "function") cloudbase.useAdapters(adapter);
  app = cloudbase.init({ env: config.envId, region: config.region });
  return app;
}

function getAuth() {
  if (!auth) auth = getApp().auth();
  return auth;
}

module.exports = { getApp, getAuth };
