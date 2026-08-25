const { restoreAndValidateSession } = require("./services/session");

App({
  globalData: { session: null, startupReady: false, startupPromise: null },
  onLaunch() {
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
  }
});
