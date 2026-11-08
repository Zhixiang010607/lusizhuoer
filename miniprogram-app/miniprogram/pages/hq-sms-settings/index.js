const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const KEYS = ["purchase", "recharge", "refund", "verification"];
const LABELS = ["产品审核", "充值审核", "退费审核", "核销审核"];
Page({
  data: { loading: true, loaded: false, saving: false, name: "", phone: "", active: false, categories: KEYS.map((key, i) => ({ key, label: LABELS[i], checked: false })), message: "", error: false },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    const id = String(options.staffAccountId || "");
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      this.setData({ loading: false, error: true, message: "缺少有效的总部人员信息，请返回重新选择" }); return;
    }
    this._targetId = id;
  },
  onShow() { if (requireSession(["hq"]) && this._targetId) this.load(); },
  onUnload() { this._unloaded = true; this._epoch = (this._epoch || 0) + 1; },
  applyPreference(value) {
    if (!value || String(value.staffAccountId) !== this._targetId || KEYS.some(key => typeof value.categories?.[key] !== "boolean")) throw new Error("短信设置读取不完整，请重试");
    this.setData({ name: value.name, phone: value.phone, active: value.active === true, loaded: true,
      categories: KEYS.map((key, i) => ({ key, label: LABELS[i], checked: value.categories[key] })) });
  },
  async load() {
    if (!requireSession(["hq"]) || !this._targetId || this.data.saving) return;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({ loading: true, loaded: false, message: "", error: false });
    try {
      const result = await callStaff("getHqReviewSmsPreference", { staffAccountId: this._targetId });
      if (this._unloaded || epoch !== this._epoch) return;
      this.applyPreference(result.preference);
    } catch (error) {
      if (!this._unloaded && epoch === this._epoch) this.setData({ message: error.message || "读取失败，请重试", error: true });
    } finally { if (!this._unloaded && epoch === this._epoch) this.setData({ loading: false }); }
  },
  changeCategories(event) {
    if (!this.data.loaded || this.data.loading || this.data.saving) return;
    const selected = new Set(event.detail.value || []);
    this.setData({ categories: this.data.categories.map(item => ({ ...item, checked: selected.has(item.key) })), message: "", error: false });
  },
  async save() {
    if (!requireSession(["hq"]) || !this.data.loaded || this.data.loading || this.data.saving) return;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    const categories = Object.fromEntries(this.data.categories.map(item => [item.key, item.checked]));
    this.setData({ saving: true, message: "正在保存…", error: false });
    try {
      const result = await callStaff("setHqReviewSmsPreference", { staffAccountId: this._targetId, categories });
      if (this._unloaded || epoch !== this._epoch) return;
      this.applyPreference(result.preference);
      this.setData({ message: "设置已保存", error: false });
    } catch (error) {
      if (!this._unloaded && epoch === this._epoch) this.setData({ loaded: false, message: `${error.message || "保存结果未确认"}；请重新读取设置核对。`, error: true });
    } finally { if (!this._unloaded && epoch === this._epoch) this.setData({ saving: false }); }
  }
});
