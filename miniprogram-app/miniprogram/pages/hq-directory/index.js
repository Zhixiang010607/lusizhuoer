const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

const META = Object.freeze({
  store: { title: "门店管理", noun: "门店", action: "listStores", unit: "家" },
  teacher: { title: "老师管理", noun: "老师", action: "listStaff", unit: "人" }
});
function text(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item).trim());
  return String(value || "").trim();
}
function normalizedPhone(value) { return String(value || "").replace(/\D/g, ""); }
function archived(item) {
  return [item.store_status, item.account_status, item.teacher_status, item.status]
    .map((value) => text(value).toUpperCase()).includes("ARCHIVED");
}
function storeView(item) {
  const address = [item.province, item.city, item.district, item.address_detail].map((value) => text(value)).filter(Boolean).join(" ");
  return {
    id: text(item.id), ref: text(item.id, item.store_code, item.auth_uid), code: text(item.store_code),
    name: text(item.store_name, item.name) || "未命名门店", contact: text(item.contact_name, item.staff_name) || "—",
    phone: text(item.contact_phone, item.phone) || "—", address: address || "未填写地址", authUid: text(item.auth_uid),
    archived: archived(item)
  };
}
function teacherView(item) {
  const authoritative = [item.account_status, item.teacher_status].map((value) => text(value).toUpperCase())
    .filter((value) => ["ACTIVE", "ARCHIVED"].includes(value));
  return {
    id: text(item.id), teacherId: text(item.teacher_id, item.teacherId), ref: text(item.auth_uid, item.teacher_id, item.id),
    name: text(item.staff_name, item.teacher_name, item.name) || "未命名老师",
    phone: text(item.phone) || "—", authUid: text(item.auth_uid),
    archived: authoritative.length ? authoritative.includes("ARCHIVED") : archived(item)
  };
}
Page({
  data: {
    type: "store", title: "门店管理", noun: "门店", unit: "家", loading: true, message: "", error: false,
    rows: [], activeRows: [], archivedRows: [], searched: false, searchRows: [], searchName: "", searchPhone: "",
    activePageRows: [], archivedPageRows: [], searchPageRows: [],
    activePage: 1, archivedPage: 1, searchPage: 1,
    activePages: 1, archivedPages: 1, searchPages: 1,
    activePageInput: "1", archivedPageInput: "1", searchPageInput: "1"
  },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    this._unloaded = false;
    if (options.type === "project") {
      this._redirecting = true;
      wx.redirectTo({ url: "/pages/product-management/index" });
      return;
    }
    if (options.type === "product") {
      this._redirecting = true;
      wx.redirectTo({ url: "/pages/retail-product-management/index" });
      return;
    }
    const type = META[options.type] ? options.type : "store";
    const meta = META[type];
    this.setData({ type, title: meta.title, noun: meta.noun, unit: meta.unit });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
  },
  onShow() {
    if (this._redirecting || !requireSession(["hq"]) || !META[this.data.type]) return;
    this.load();
  },
  onUnload() {
    this._unloaded = true;
    this._requestEpoch = (this._requestEpoch || 0) + 1;
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    const type = this.data.type;
    const meta = META[type];
    if (this._unloaded || !meta) return;
    const epoch = (this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    const request = Object.freeze({ epoch, type, action: meta.action, noun: meta.noun });
    this.setData({ loading: true, message: "", error: false });
    try {
      const payload = request.type === "teacher" ? Object.freeze({ role: "teacher" }) : Object.freeze({});
      const result = await callStaff(request.action, payload);
      if (this._unloaded || request.epoch !== this._requestEpoch || request.type !== this.data.type) return;
      const source = request.type === "store" ? result.stores : result.staff;
      const rows = (source || []).map(request.type === "store" ? storeView : teacherView);
      const name = text(this.data.searchName).toLocaleLowerCase("zh-CN");
      const phone = normalizedPhone(this.data.searchPhone);
      const searchRows = this.data.searched ? rows.filter((item) =>
        (!name || item.name.toLocaleLowerCase("zh-CN").includes(name))
        && (!phone || normalizedPhone(item.phone).includes(phone))) : [];
      this.setData({ rows, activeRows: rows.filter((item) => !item.archived), archivedRows: rows.filter((item) => item.archived), searchRows }, () => this.syncDirectoryPages(true));
    } catch (error) {
      if (this._unloaded || request.epoch !== this._requestEpoch || request.type !== this.data.type) return;
      this.setData({ rows: [], activeRows: [], archivedRows: [], searchRows: [], message: error.message || `${request.noun}数据读取失败`, error: true }, () => this.syncDirectoryPages(true));
    } finally {
      if (!this._unloaded && request.epoch === this._requestEpoch && request.type === this.data.type) this.setData({ loading: false });
    }
  },
  inputSearchName(event) { this.setData({ searchName: event.detail.value }); },
  inputSearchPhone(event) { this.setData({ searchPhone: event.detail.value }); },
  runSearch() {
    const name = text(this.data.searchName).toLocaleLowerCase("zh-CN");
    const phone = normalizedPhone(this.data.searchPhone);
    if (!name && !phone) {
      this.setData({ searched: false, searchRows: [] }, () => this.syncDirectoryPages(true));
      return;
    }
    this.applySearch();
  },
  applySearch() {
    const name = text(this.data.searchName).toLocaleLowerCase("zh-CN");
    const phone = normalizedPhone(this.data.searchPhone);
    const rows = this.data.rows.filter((item) =>
      (!name || item.name.toLocaleLowerCase("zh-CN").includes(name))
      && (!phone || normalizedPhone(item.phone).includes(phone)));
    this.setData({ searched: true, searchRows: rows }, () => this.syncDirectoryPages(true));
  },
  syncDirectoryPages(reset = false) {
    const patch = {};
    for (const kind of ["active", "archived", "search"]) {
      const rows = this.data[`${kind}Rows`] || [];
      const pages = Math.max(1, Math.ceil(rows.length / 10));
      const page = reset ? 1 : Math.min(Math.max(1, this.data[`${kind}Page`] || 1), pages);
      patch[`${kind}Pages`] = pages;
      patch[`${kind}Page`] = page;
      patch[`${kind}PageInput`] = String(page);
      patch[`${kind}PageRows`] = rows.slice((page - 1) * 10, page * 10);
    }
    this.setData(patch);
  },
  inputDirectoryPage(event) {
    const kind = event.currentTarget.dataset.kind;
    if (["active", "archived", "search"].includes(kind)) this.setData({ [`${kind}PageInput`]: event.detail.value });
  },
  directoryPage(event) {
    if (this.data.loading) return;
    const { kind, direction } = event.currentTarget.dataset;
    if (!["active", "archived", "search"].includes(kind)) return;
    const raw = direction ? String(this.data[`${kind}Page`] + Number(direction)) : String(this.data[`${kind}PageInput`] || "").trim();
    const page = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 || page > this.data[`${kind}Pages`]) {
      this.setData({ message: `请输入 1 到 ${this.data[`${kind}Pages`]} 的整数页码`, error: true }); return;
    }
    this.setData({ [`${kind}Page`]: page, message: "", error: false }, () => this.syncDirectoryPages());
  },
  openCreate() {
    wx.navigateTo({ url: this.data.type === "store" ? "/pages/store-create/index" : "/pages/teacher-create/index" });
  },
  openDetail(event) {
    const ref = String(event.currentTarget.dataset.ref || "");
    if (!ref) return;
    const route = this.data.type === "store" ? "store-detail/index?storeRef" : "teacher-detail/index?teacherRef";
    wx.navigateTo({ url: `/pages/${route}=${encodeURIComponent(ref)}` });
  }
});
