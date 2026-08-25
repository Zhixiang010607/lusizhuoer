const { signOut } = require("../../services/session");

Component({
  properties: {
    active: { type: String, value: "management" }
  },
  data: { open: "" },
  methods: {
    noop() {},
    close() { this.setData({ open: "" }); },
    toggle(event) {
      const name = String(event.currentTarget.dataset.name || "");
      this.setData({ open: this.data.open === name ? "" : name });
    },
    goHome() {
      this.close();
      wx.reLaunch({ url: "/pages/home/index" });
    },
    go(event) {
      const route = String(event.currentTarget.dataset.route || "");
      this.close();
      if (route) wx.redirectTo({ url: route });
    },
    async logout() {
      this.close();
      const result = await new Promise((resolve) => wx.showModal({
        title: "退出登录", content: "确认退出当前总部账号？", confirmText: "退出",
        success: (value) => resolve(value.confirm), fail: () => resolve(false)
      }));
      if (!result) return;
      try { await signOut(); } finally { wx.reLaunch({ url: "/pages/login/index" }); }
    }
  }
});
