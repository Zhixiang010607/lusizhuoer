const { restoreAndValidateSession } = require("./services/session");

function keepScreenAwake() {
  if (typeof wx === "undefined" || typeof wx.setKeepScreenOn !== "function") return;
  wx.setKeepScreenOn({
    keepScreenOn: true,
    fail(error) { console.warn("[app] 保持屏幕常亮失败", error?.errMsg || error?.message || error); }
  });
}

App({
  globalData: { session: null, startupReady: false, startupPromise: null },
  onLaunch() {
    keepScreenAwake();
    this.globalData.startupReady = false;
    this.globalData.startupPromise = (async () => {
      try {
        this.globalData.session = await restoreAndValidateSession();
      } catch (_) {
        this.globalData.session = null;
      } finally {
        this.globalData.startupReady = true;
      }
      return this.globalData.session;
    })();
    return this.globalData.startupPromise;
  },
  onShow() { keepScreenAwake(); }
});
