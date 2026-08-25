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
    code: text(item.person_code, item.teacher_code) || "—", name: text(item.staff_name, item.teacher_name, item.name) || "未命名老师",
    phone: text(item.phone) || "—", authUid: text(item.auth_uid),
    archived: authoritative.length ? authoritative.includes("ARCHIVED") : archived(item)
  };
}
function confirmModal(content, confirmText = "确认") {
  return new Promise((resolve) => wx.showModal({ title: "请确认", content, confirmText, success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
}

Page({
  data: {
    type: "store", title: "门店管理", noun: "门店", unit: "家", loading: true, mutatingRef: "", message: "", error: false,
    rows: [], activeRows: [], archivedRows: [], searched: false, searchRows: [], searchName: "", searchPhone: ""
  },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    if (options.type === "product") {
      wx.redirectTo({ url: "/pages/product-management/index" });
      return;
    }
    const type = META[options.type] ? options.type : "store";
    const meta = META[type];
    this.setData({ type, title: meta.title, noun: meta.noun, unit: meta.unit });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
  },
  onShow() {
    if (!requireSession(["hq"]) || !META[this.data.type]) return;
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    if (this._loading) return;
    this._loading = true;
    this.setData({ loading: true, message: "", error: false });
    try {
      const result = await callStaff(META[this.data.type].action, this.data.type === "teacher" ? { role: "teacher" } : {});
      const source = this.data.type === "store" ? result.stores : result.staff;
      const rows = (source || []).map(this.data.type === "store" ? storeView : teacherView);
      this.setData({ rows, activeRows: rows.filter((item) => !item.archived), archivedRows: rows.filter((item) => item.archived) }, () => {
        if (this.data.searched) this.applySearch();
      });
    } catch (error) {
      this.setData({ rows: [], activeRows: [], archivedRows: [], searchRows: [], message: error.message || `${this.data.noun}数据读取失败`, error: true });
    } finally {
      this._loading = false;
      this.setData({ loading: false });
    }
  },
  inputSearchName(event) { this.setData({ searchName: event.detail.value }); },
  inputSearchPhone(event) { this.setData({ searchPhone: event.detail.value }); },
  runSearch() {
    const name = text(this.data.searchName).toLocaleLowerCase("zh-CN");
    const phone = normalizedPhone(this.data.searchPhone);
    if (!name && !phone) {
      this.setData({ searched: false, searchRows: [] });
      return;
    }
    this.applySearch();
  },
  applySearch() {
    const name = text(this.data.searchName).toLocaleLowerCase("zh-CN");
    const phone = normalizedPhone(this.data.searchPhone);
    const rows = this.data.rows.filter((item) =>
      (!name || item.name.toLocaleLowerCase("zh-CN").includes(name) || item.code.toLocaleLowerCase("zh-CN").includes(name))
      && (!phone || normalizedPhone(item.phone).includes(phone)));
    this.setData({ searched: true, searchRows: rows });
  },
  openCreate() {
    wx.navigateTo({ url: this.data.type === "store" ? "/pages/store-create/index" : "/pages/teacher-create/index" });
  },
  openDetail(event) {
    const ref = String(event.currentTarget.dataset.ref || "");
    if (!ref) return;
    const route = this.data.type === "store" ? "store-detail/index?storeRef" : "teacher-detail/index?teacherRef";
    wx.navigateTo({ url: `/pages/${route}=${encodeURIComponent(ref)}` });
  },
  openExperience(event) { this.openDetail(event); },
  async toggleTeacherStatus(event) {
    if (this.data.type !== "teacher" || this.data.mutatingRef) return;
    const ref = String(event.currentTarget.dataset.ref || "");
    const row = this.data.rows.find((item) => item.ref === ref);
    if (!row) return;
    const next = row.archived ? "ACTIVE" : "ARCHIVED";
    const action = row.archived ? "激活" : "封存";
    if (!await confirmModal(`确认${action}老师“${row.name}”？${next === "ARCHIVED" ? "历史业务和体验额度记录会完整保留。" : ""}`, action)) return;
    this.setData({ mutatingRef: ref, message: `正在${action}老师…`, error: false });
    try {
      if (row.authUid) await callStaff("setStaffStatus", { uid: row.authUid, phone: row.phone === "—" ? "" : row.phone, status: next });
      else if (row.teacherId) await callStaff("setMasterStatus", { teacherId: row.teacherId, status: next });
      else throw new Error("老师资料缺少可用账号或老师编号");
      await this.load();
      const current = this.data.rows.find((item) => item.ref === ref);
      if (!current || current.archived !== (next === "ARCHIVED")) throw new Error(`${action}结果未能由数据库确认，请刷新后核对`);
      this.setData({ message: `老师已${action}。`, error: false });
    } catch (error) {
      this.setData({ message: error.message || `老师${action}失败`, error: true });
    } finally { this.setData({ mutatingRef: "" }); }
  }
});
