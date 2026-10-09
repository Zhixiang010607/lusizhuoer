const { restoreAndValidateSession } = require("./services/session");

function clearColdStartBleAttempt() {
  const submission = require("./services/submission");
  const ble = require("./services/ble-verification");
  const intent = submission.read("VERIFICATION");
  const progress = ble.readProgress();
  const completedLocally = intent?.state === "CONFIRMED"
    || Number(progress?.deviceResult?.status) === 2;
  if (!intent || completedLocally) return;
  ble.clearProgress();
  submission.clear("VERIFICATION");
}

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
      }
      if (this.globalData.session) {
        try {
          clearColdStartBleAttempt();
        } catch (error) {
          console.warn("[app] 清理冷启动前的未完成设备资格失败", error?.message || error);
        }
      }
      this.globalData.startupReady = true;
      return this.globalData.session;
    })();
    return this.globalData.startupPromise;
  },
  onShow() { keepScreenAwake(); }
});
