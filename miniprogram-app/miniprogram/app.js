const { restoreAndValidateSession } = require("./services/session");

App({
  globalData: { session: null, startupReady: false },
  async onLaunch() {
    try {
      this.globalData.session = await restoreAndValidateSession();
    } catch (_) {
      this.globalData.session = null;
    } finally {
      this.globalData.startupReady = true;
    }
  }
});
