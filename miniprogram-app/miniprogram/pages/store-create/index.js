const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function phone(value) {
  const result = String(value || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(result)) throw new Error("请输入有效的中国大陆手机号");
  return result;
}
function password(value) {
  const result = String(value || "");
  const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(result)).length;
  if (!/^[A-Za-z0-9]/.test(result)) throw new Error("初始密码不能以特殊字符开头，请以英文字母或数字开头");
  if (result.length < 8 || result.length > 32 || groups < 3) throw new Error("初始密码需为 8–32 位，并包含大写、小写、数字、特殊字符中的至少三类");
  return result;
}
function pendingKey(value) { return `lusizhuoerPendingStoreProvision:${value}`; }

Page({
  data: { form: { name: "", region: [], regionText: "", address: "", contactName: "", phone: "", password: "" }, submitting: false, message: "", error: false },
  onLoad() { if (requireSession(["hq"])) wx.setNavigationBarTitle({ title: "露思卓儿" }); },
  input(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  chooseRegion(event) {
    const region = event.detail.value || [];
    this.setData({ "form.region": region, "form.regionText": region.join(" · ") });
  },
  back() { if (!this.data.submitting) wx.navigateBack(); },
  async submit() {
    if (this.data.submitting) return;
    try {
      const form = this.data.form;
      const contactPhone = phone(form.phone);
      if (!text(form.name) || form.region.length !== 3 || !text(form.address) || !text(form.contactName)) throw new Error("请完整填写门店资料和唯一登录联系人资料");
      const pending = wx.getStorageSync(pendingKey(contactPhone)) || {};
      const payload = {
        storeName: text(form.name), province: form.region[0], city: form.region[1], district: form.region[2],
        addressDetail: text(form.address), address: text(form.address), contactName: text(form.contactName), contactPhone,
        initialPassword: password(form.password), existingStoreId: text(pending.storeId)
      };
      this.setData({ submitting: true, message: "正在创建门店资料与登录账号…", error: false });
      try {
        const result = await callStaff("createStoreWithAccount", payload);
        const store = result.store || result;
        const storeId = text(store.id || result.storeId);
        if (!storeId) throw new Error("门店已创建，但未获得门店编号；请返回门店管理核对后再试");
        wx.removeStorageSync(pendingKey(contactPhone));
        wx.redirectTo({ url: `/pages/store-detail/index?storeRef=${encodeURIComponent(storeId)}` });
      } catch (error) {
        if (error.storeRolledBack) wx.removeStorageSync(pendingKey(contactPhone));
        else if (error.storeId) wx.setStorageSync(pendingKey(contactPhone), { storeId: String(error.storeId), storeCode: String(error.storeCode || "") });
        const hint = error.storeId ? "；门店资料已保留，请使用相同资料再次提交以恢复账号绑定" : "";
        throw new Error(`${error.message || "门店与登录账号创建失败"}${hint}`);
      }
    } catch (error) {
      this.setData({ message: error.message || "请检查填写内容", error: true });
    } finally { this.setData({ submitting: false }); }
  }
});
