const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

function text(...values) { return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "").trim(); }
function number(row, names, fallback = 0) { for (const name of names) { const value = Number(row && row[name]); if (Number.isFinite(value)) return value; } return fallback; }
function optionalNumber(row, names) { for (const name of names) { const raw = row && row[name]; if (raw === null || raw === undefined || raw === "") continue; const value = Number(raw); if (Number.isFinite(value)) return value; } return null; }
function archived(staff = {}) {
  const authoritative = [staff.account_status, staff.teacher_status].map((value) => text(value).toUpperCase()).filter((value) => ["ACTIVE", "ARCHIVED"].includes(value));
  return authoritative.length ? authoritative.includes("ARCHIVED") : [staff.status, staff.profile_status].map((value) => text(value).toUpperCase()).includes("ARCHIVED");
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "未记录" : new Date(date.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function entitlement(row = {}) {
  return {
    id: text(row.id, row.entitlementId, row.entitlement_id), productId: text(row.productId, row.product_id), productCode: text(row.productCode, row.product_code),
    productName: text(row.productName, row.product_name) || "未命名产品", productStatus: (text(row.productStatus, row.product_status) || "ACTIVE").toUpperCase(),
    monthlyAllowance: number(row, ["monthlyAllowance", "monthly_allowance"]), usedCount: number(row, ["usedCount", "used_count"]),
    manualRechargeCount: number(row, ["manualRechargeCount", "manual_recharge_count"]), availableCount: number(row, ["availableCount", "available_count"]),
    totalExperienceCount: optionalNumber(row, ["totalExperienceCount", "total_experience_count", "totalUsedCount", "total_used_count"]),
    monthlyResetText: formatTime(text(row.monthlyResetAt, row.monthly_reset_at)), productArchived: (text(row.productStatus, row.product_status) || "ACTIVE").toUpperCase() === "ARCHIVED"
  };
}
function totalRow(row = {}) { return { productId: text(row.productId, row.product_id), productCode: text(row.productCode, row.product_code), productName: text(row.productName, row.product_name) || "未命名产品", productStatus: (text(row.productStatus, row.product_status) || "ARCHIVED").toUpperCase(), totalExperienceCount: number(row, ["totalExperienceCount", "total_experience_count", "totalUsedCount", "total_used_count"]) }; }
function historyRow(row = {}, index = 0) {
  const count = number(row, ["unitCount", "unit_count", "deltaCount", "delta_count", "count", "amount"]);
  return { key: `${text(row.id, row.ledgerId, row.ledger_id, row.createdAt, row.created_at, row.occurredAt, row.occurred_at) || "history"}-${index}`, at: formatTime(text(row.createdAt, row.created_at, row.occurredAt, row.occurred_at, row.eventAt, row.event_at, row.at)), type: text(row.eventType, row.event_type, row.type, row.recordType, row.record_type) || "体验额度变更", productName: text(row.productName, row.product_name) || "未命名产品", productCode: text(row.productCode, row.product_code), count, countText: `${count > 0 ? "+" : ""}${count} 次`, note: text(row.note, row.message, row.reason), actorName: text(row.actorName, row.actor_name, row.createdByName, row.created_by_name, row.operatorName, row.operator_name) || "系统／总部" };
}
function summaryRows(rows, totals) {
  const map = new Map(rows.map((row) => [row.productId, { ...row }]));
  totals.forEach((total) => { const current = map.get(total.productId); if (current) current.totalExperienceCount = total.totalExperienceCount; else map.set(total.productId, { ...total, monthlyAllowance: 0, usedCount: 0, manualRechargeCount: 0, availableCount: 0, productArchived: total.productStatus === "ARCHIVED" }); });
  return [...map.values()].map((row) => ({ ...row, totalDisplay: row.totalExperienceCount === null ? row.usedCount : row.totalExperienceCount })).sort((left, right) => left.productName.localeCompare(right.productName, "zh-CN"));
}
function validPassword(value) { const password = String(value || ""); const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(password)).length; return password.length >= 8 && password.length <= 32 && /^[A-Za-z0-9]/.test(password) && groups >= 3; }
function requestId() { return `teacher_experience_recharge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 64); }
function confirm(content, confirmText) { return new Promise((resolve) => wx.showModal({ title: "请确认", content, confirmText, success: (result) => resolve(result.confirm), fail: () => resolve(false) })); }

Page({
  data: {
    teacherRef: "", staff: null, teacherId: "", profile: {}, loading: true, mutating: "", message: "", error: false,
    entitlements: [], summaryRows: [], history: [], visibleHistory: [], historyExpanded: false,
    products: [], configureProducts: [], configureLabels: [], configureIndex: 0, configureProductId: "", monthlyAllowance: "",
    rechargeProducts: [], rechargeLabels: [], rechargeIndex: 0, rechargeProductId: "", rechargeCount: "", rechargeNote: "", rechargeRequestId: "",
    overview: { available: 0, used: 0, lifetime: 0, activeProducts: 0 }, newPassword: ""
  },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    this.setData({ teacherRef: decodeURIComponent(options.teacherRef || "") });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack(); },
  profileView(staff) {
    const name = text(staff.staff_name, staff.teacher_name) || "老师";
    return { name, initials: Array.from(name)[0] || "师", code: text(staff.person_code, staff.teacher_code) || "未分配", phone: text(staff.phone) || "未填写", archived: archived(staff), passwordStatus: [true, "true", "t", 1, "1"].includes(staff.password_change_required) ? "临时密码待本人修改" : "密码已由本人确认", authUid: text(staff.auth_uid) };
  },
  async load() {
    if (this._loading) return;
    this._loading = true;
    this.setData({ loading: true, message: "", error: false });
    try {
      const [staffResult, productResult] = await Promise.all([callStaff("listStaff", { role: "teacher" }), callStaff("listProducts")]);
      const staff = (staffResult.staff || []).find((item) => [item.auth_uid, item.id, item.staff_id, item.teacher_id, item.teacher_code, item.person_code].map(text).includes(this.data.teacherRef));
      if (!staff) throw new Error("未找到该老师账号或老师主档");
      const teacherId = text(staff.teacher_id, staff.teacherId);
      if (!/^\d+$/.test(teacherId)) throw new Error("老师资料缺少有效数据库编号");
      this.setData({ staff, teacherId, profile: this.profileView(staff), products: productResult.products || [] });
      await this.loadExperience();
    } catch (error) { this.setData({ message: error.message || "老师主页读取失败", error: true }); }
    finally { this._loading = false; this.setData({ loading: false }); }
  },
  async refreshStaff() {
    const result = await callStaff("listStaff", { role: "teacher" });
    const staff = (result.staff || []).find((item) => text(item.teacher_id) === this.data.teacherId || [item.auth_uid, item.id, item.person_code].map(text).includes(this.data.teacherRef));
    if (!staff) throw new Error("状态修改后未能重新读取老师资料");
    this.setData({ staff, profile: this.profileView(staff) });
    return staff;
  },
  async loadExperience() {
    const data = await callStaff("getTeacherExperienceEntitlements", { teacherId: this.data.teacherId });
    const rows = (data.entitlements || []).map(entitlement).filter((row) => row.productId);
    const totals = (data.experienceTotals || []).map(totalRow).filter((row) => row.productId);
    const history = (data.history || data.ledger || data.events || data.records || []).map(historyRow);
    const configured = new Set(rows.map((row) => row.productId));
    const products = (this.data.products || []).map((product) => ({ id: text(product.id, product.product_id), code: text(product.product_code, product.productCode), name: text(product.product_name, product.productName), status: (text(product.product_status, product.productStatus) || "ACTIVE").toUpperCase() }));
    const configureProducts = products.filter((product) => product.status === "ACTIVE" && !configured.has(product.id));
    const rechargeProducts = rows.filter((row) => row.productStatus === "ACTIVE");
    const summary = summaryRows(rows, totals);
    const overview = {
      available: number(data, ["totalAvailableCount", "totalAvailable"], rows.reduce((sum, row) => sum + row.availableCount, 0)),
      used: rows.reduce((sum, row) => sum + row.usedCount, 0),
      lifetime: number(data, ["totalExperienceCount", "total_experience_count"], summary.reduce((sum, row) => sum + row.totalDisplay, 0)),
      activeProducts: rechargeProducts.length
    };
    this.setData({ entitlements: rows, summaryRows: summary, history, visibleHistory: history.slice(0, this.data.historyExpanded ? history.length : 10), configureProducts, configureLabels: configureProducts.map((item) => `${item.name}${item.code ? `（${item.code}）` : ""}`), configureIndex: 0, configureProductId: configureProducts[0] && configureProducts[0].id || "", rechargeProducts, rechargeLabels: rechargeProducts.map((item) => `${item.productName}${item.productCode ? `（${item.productCode}）` : ""}`), rechargeIndex: 0, rechargeProductId: rechargeProducts[0] && rechargeProducts[0].productId || "", overview });
  },
  chooseConfigureProduct(event) { const index = Number(event.detail.value || 0); this.setData({ configureIndex: index, configureProductId: this.data.configureProducts[index] && this.data.configureProducts[index].id || "" }); },
  chooseRechargeProduct(event) { const index = Number(event.detail.value || 0); this.setData({ rechargeIndex: index, rechargeProductId: this.data.rechargeProducts[index] && this.data.rechargeProducts[index].productId || "", rechargeRequestId: "" }); },
  input(event) { const field = event.currentTarget.dataset.field; this.setData({ [field]: event.detail.value, ...(field.startsWith("recharge") ? { rechargeRequestId: "" } : {}) }); },
  async saveConfiguration() {
    if (this.data.mutating || this.data.profile.archived) return;
    const monthlyAllowance = Number(this.data.monthlyAllowance);
    if (!this.data.configureProductId || !Number.isInteger(monthlyAllowance) || monthlyAllowance < 0 || monthlyAllowance > 99999) return this.setData({ message: "请选择产品，并填写 0 至 99,999 的整数体验次数。", error: true });
    this.setData({ mutating: "configure", message: "正在保存体验额度配置…", error: false });
    try { await callStaff("upsertTeacherExperienceEntitlement", { teacherId: this.data.teacherId, productId: this.data.configureProductId, monthlyAllowance }); await this.loadExperience(); this.setData({ monthlyAllowance: "", message: `体验额度已保存并立即生效：当前可用 ${monthlyAllowance} 次。`, error: false }); }
    catch (error) { this.setData({ message: error.message || "体验额度配置失败", error: true }); }
    finally { this.setData({ mutating: "" }); }
  },
  async recharge() {
    if (this.data.mutating || this.data.profile.archived) return;
    const unitCount = Number(this.data.rechargeCount);
    if (!this.data.rechargeProductId || !Number.isInteger(unitCount) || unitCount < 1 || unitCount > 99999) return this.setData({ message: "请选择已配置产品，并填写 1 至 99,999 的整数充值次数。", error: true });
    const clientRequestId = this.data.rechargeRequestId || requestId();
    this.setData({ mutating: "recharge", rechargeRequestId: clientRequestId, message: "正在为老师充值体验次数…", error: false });
    try { await callStaff("rechargeTeacherExperienceEntitlement", { teacherId: this.data.teacherId, productId: this.data.rechargeProductId, unitCount, note: text(this.data.rechargeNote), clientRequestId }); await this.loadExperience(); this.setData({ rechargeCount: "", rechargeNote: "", rechargeRequestId: "", message: "老师体验次数已充值；客户余额未发生变化。", error: false }); }
    catch (error) { this.setData({ message: error.message || "体验次数充值失败", error: true }); }
    finally { this.setData({ mutating: "" }); }
  },
  async deleteConfiguration(event) {
    if (this.data.mutating || this.data.profile.archived) return;
    const productId = String(event.currentTarget.dataset.id || "");
    const row = this.data.entitlements.find((item) => item.productId === productId);
    if (!row || !await confirm(`确认删除“${row.productName}”的当前体验额度配置？历史记录仍会保留。`, "删除")) return;
    this.setData({ mutating: `delete:${productId}`, message: "正在删除体验额度配置…", error: false });
    try { await callStaff("deleteTeacherExperienceEntitlement", { teacherId: this.data.teacherId, productId }); await this.loadExperience(); this.setData({ message: "体验额度配置已删除，历史记录继续保留。", error: false }); }
    catch (error) { this.setData({ message: error.message || "体验额度删除失败", error: true }); }
    finally { this.setData({ mutating: "" }); }
  },
  toggleHistory() { const expanded = !this.data.historyExpanded; this.setData({ historyExpanded: expanded, visibleHistory: this.data.history.slice(0, expanded ? this.data.history.length : 10) }); },
  async resetPassword() {
    if (this.data.mutating || !this.data.profile.authUid) return;
    if (!validPassword(this.data.newPassword)) return this.setData({ message: "新临时密码需为 8–32 位，以字母或数字开头，并至少包含三类字符。", error: true });
    if (!await confirm(`确认重置“${this.data.profile.name}”的临时密码？老师下次登录后仍需自行修改。`, "确认重置")) return;
    this.setData({ mutating: "password", message: "正在保存新临时密码…", error: false });
    try { await callStaff("resetPassword", { uid: this.data.profile.authUid, newPassword: this.data.newPassword }); await this.refreshStaff(); this.setData({ newPassword: "", message: "新临时密码已保存。", error: false }); }
    catch (error) { this.setData({ message: error.message || "密码重置失败", error: true }); }
    finally { this.setData({ mutating: "" }); }
  },
  async toggleStatus() {
    if (this.data.mutating || !this.data.staff) return;
    const next = this.data.profile.archived ? "ACTIVE" : "ARCHIVED";
    const action = next === "ARCHIVED" ? "封存" : "激活";
    if (!await confirm(`确认${action}老师“${this.data.profile.name}”？历史业务和体验额度记录会完整保留。`, action)) return;
    this.setData({ mutating: "status", message: `正在${action}老师…`, error: false });
    try {
      if (this.data.profile.authUid) await callStaff("setStaffStatus", { uid: this.data.profile.authUid, phone: this.data.profile.phone === "未填写" ? "" : this.data.profile.phone, status: next });
      else await callStaff("setMasterStatus", { teacherId: this.data.teacherId, status: next });
      const refreshed = await this.refreshStaff();
      if (archived(refreshed) !== (next === "ARCHIVED")) throw new Error("数据库回读状态与本次操作不一致");
      await this.loadExperience();
      this.setData({ message: `老师已${action}。`, error: false });
    } catch (error) { this.setData({ message: error.message || `老师${action}失败`, error: true }); }
    finally { this.setData({ mutating: "" }); }
  }
});
