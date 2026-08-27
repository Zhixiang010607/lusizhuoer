const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const { displayDateTimeAny } = require("../../services/query-tools");
const rechargeIntent = require("../../services/teacher-experience-recharge");

function text(...values) { return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "").trim(); }
function number(row, names, fallback = 0) { for (const name of names) { const value = Number(row && row[name]); if (Number.isFinite(value)) return value; } return fallback; }
function optionalNumber(row, names) { for (const name of names) { const raw = row && row[name]; if (raw === null || raw === undefined || raw === "") continue; const value = Number(raw); if (Number.isFinite(value)) return value; } return null; }
function archived(staff = {}) {
  const authoritative = [staff.account_status, staff.teacher_status].map((value) => text(value).toUpperCase()).filter((value) => ["ACTIVE", "ARCHIVED"].includes(value));
  return authoritative.length ? authoritative.includes("ARCHIVED") : [staff.status, staff.profile_status].map((value) => text(value).toUpperCase()).includes("ARCHIVED");
}
function formatTime(...values) {
  const formatted = displayDateTimeAny(...values);
  return formatted === "—" ? "未记录" : formatted;
}
function historyType(value) {
  const code = text(value).toUpperCase();
  return ({
    TOP_UP: "额度充值", RECHARGE: "额度充值",
    CONFIGURATION: "配置额度", CONFIGURED: "配置额度", CREATE: "配置额度",
    REMOVED: "删除配置", REMOVE: "删除配置", DELETED: "删除配置",
    MONTHLY_RESET: "月度更新", RESET: "月度更新",
    EXPERIENCE: "体验核销", USAGE: "体验核销", CONSUMPTION: "体验核销"
  })[code] || "额度变更";
}
function entitlement(row = {}) {
  return {
    id: text(row.id, row.entitlementId, row.entitlement_id), productId: text(row.productId, row.product_id), productCode: text(row.productCode, row.product_code),
    productName: text(row.productName, row.product_name) || "未命名产品", productStatus: (text(row.productStatus, row.product_status) || "ACTIVE").toUpperCase(),
    monthlyAllowance: number(row, ["monthlyAllowance", "monthly_allowance"]), usedCount: number(row, ["usedCount", "used_count"]),
    availableCount: number(row, ["availableCount", "available_count"]),
    totalExperienceCount: optionalNumber(row, ["totalExperienceCount", "total_experience_count", "totalUsedCount", "total_used_count"]),
    productArchived: (text(row.productStatus, row.product_status) || "ACTIVE").toUpperCase() === "ARCHIVED"
  };
}
function totalRow(row = {}) { return { productId: text(row.productId, row.product_id), productCode: text(row.productCode, row.product_code), productName: text(row.productName, row.product_name) || "未命名产品", productStatus: (text(row.productStatus, row.product_status) || "ARCHIVED").toUpperCase(), totalExperienceCount: number(row, ["totalExperienceCount", "total_experience_count", "totalUsedCount", "total_used_count"]) }; }
function historyRow(row = {}, index = 0) {
  const count = number(row, ["unitCount", "unit_count", "deltaCount", "delta_count", "count", "amount"]);
  return { key: `${text(row.id, row.ledgerId, row.ledger_id, row.createdAt, row.created_at, row.occurredAt, row.occurred_at) || "history"}-${index}`, at: formatTime(row.createdAt, row.created_at, row.occurredAt, row.occurred_at, row.eventAt, row.event_at, row.at), type: historyType(text(row.eventType, row.event_type, row.type, row.recordType, row.record_type)), productName: text(row.productName, row.product_name) || "未命名产品", productCode: text(row.productCode, row.product_code), count, countText: `${count > 0 ? "+" : ""}${count} 次`, note: text(row.note, row.message, row.reason), actorName: text(row.actorName, row.actor_name, row.createdByName, row.created_by_name, row.operatorName, row.operator_name) || "系统／总部" };
}
function summaryRows(rows, totals) {
  const map = new Map(rows.map((row) => [row.productId, { ...row }]));
  totals.forEach((total) => { const current = map.get(total.productId); if (current) current.totalExperienceCount = total.totalExperienceCount; else map.set(total.productId, { ...total, monthlyAllowance: 0, usedCount: 0, availableCount: 0, productArchived: total.productStatus === "ARCHIVED" }); });
  return [...map.values()].map((row) => ({ ...row, totalDisplay: row.totalExperienceCount === null ? row.usedCount : row.totalExperienceCount })).sort((left, right) => left.productName.localeCompare(right.productName, "zh-CN"));
}
function validPassword(value) { const password = String(value || ""); const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(password)).length; return password.length >= 8 && password.length <= 32 && /^[A-Za-z0-9]/.test(password) && groups >= 3; }
function confirm(content, confirmText) { return new Promise((resolve) => wx.showModal({ title: "请确认", content, confirmText, success: (result) => resolve(result.confirm), fail: () => resolve(false) })); }
const REQUEST_EPOCH_KEYS = Object.freeze(["_loadRequestEpoch", "_profileRequestEpoch", "_productsRequestEpoch", "_experienceRequestEpoch", "_mutationRequestEpoch"]);
function bump(page, key) { const epoch = (page[key] || 0) + 1; page[key] = epoch; return epoch; }
function current(page, key, epoch) { return !page._unloaded && page[key] === epoch; }
function productSnapshot(products) { return Object.freeze((products || []).map((item) => Object.freeze({ ...item }))); }
function emptyExperienceState() {
  return {
    entitlements: [], summaryRows: [], history: [], configureProducts: [], configureLabels: [],
    configureIndex: 0, configureProductId: "", rechargeProducts: [], rechargeLabels: [], rechargeIndex: 0, rechargeProductId: "",
    overview: { available: 0, used: 0, lifetime: 0, activeProducts: 0 }
  };
}
function experienceState(data, productSource, selected) {
  const rows = (data.entitlements || []).map(entitlement).filter((row) => row.productId);
  const totals = (data.experienceTotals || []).map(totalRow).filter((row) => row.productId);
  const history = (data.history || data.ledger || data.events || data.records || []).map(historyRow);
  const configured = new Set(rows.map((row) => row.productId));
  const products = (productSource || []).map((product) => ({
    id: text(product.id, product.product_id), code: text(product.product_code, product.productCode),
    name: text(product.product_name, product.productName), status: (text(product.product_status, product.productStatus) || "ACTIVE").toUpperCase()
  }));
  const configureProducts = products.filter((product) => product.status === "ACTIVE" && !configured.has(product.id));
  const rechargeProducts = rows.filter((row) => row.productStatus === "ACTIVE");
  const summary = summaryRows(rows, totals);
  const configureProductId = configureProducts.some((item) => item.id === selected.configureProductId)
    ? selected.configureProductId : configureProducts[0] && configureProducts[0].id || "";
  const rechargeProductId = rechargeProducts.some((item) => item.productId === selected.rechargeProductId)
    ? selected.rechargeProductId : rechargeProducts[0] && rechargeProducts[0].productId || "";
  return {
    entitlements: rows, summaryRows: summary, history,
    configureProducts, configureLabels: configureProducts.map((item) => `${item.name}${item.code ? `（${item.code}）` : ""}`),
    configureIndex: Math.max(0, configureProducts.findIndex((item) => item.id === configureProductId)), configureProductId,
    rechargeProducts, rechargeLabels: rechargeProducts.map((item) => `${item.productName}${item.productCode ? `（${item.productCode}）` : ""}`),
    rechargeIndex: Math.max(0, rechargeProducts.findIndex((item) => item.productId === rechargeProductId)), rechargeProductId,
    overview: {
      available: number(data, ["totalAvailableCount", "totalAvailable"], rows.reduce((sum, row) => sum + row.availableCount, 0)),
      used: rows.reduce((sum, row) => sum + row.usedCount, 0),
      lifetime: number(data, ["totalExperienceCount", "total_experience_count"], summary.reduce((sum, row) => sum + row.totalDisplay, 0)),
      activeProducts: rechargeProducts.length
    }
  };
}
function exactRechargeProof(result, intent) {
  const recharge = result && result.recharge || {};
  const entitlement = result && result.entitlement || {};
  const rechargeId = text(recharge.id, recharge.rechargeId, recharge.recharge_id);
  const productId = text(entitlement.productId, entitlement.product_id);
  const unitCount = number(recharge, ["unitCount", "unit_count"], NaN);
  const before = number(recharge, ["availableBeforeCount", "available_before_count"], NaN);
  const after = number(recharge, ["availableAfterCount", "available_after_count"], NaN);
  if (!rechargeId || productId !== intent.productId || unitCount !== intent.unitCount
      || !Number.isFinite(before) || !Number.isFinite(after) || after - before !== intent.unitCount) {
    throw new Error("服务端未返回与原请求完全一致的体验充值证明，防重复提交锁仍保留");
  }
  return { rechargeId };
}
function definitiveRechargeRejection(error) {
  if (error && (error.submissionUncertain === true || error.transportUncertain === true)) return false;
  return [
    "BAD_REQUEST", "FORBIDDEN", "UNAUTHENTICATED", "ARCHIVED",
    "TEACHER_EXPERIENCE_QUOTA_NOT_CONFIGURED", "MASTER_DATA_NOT_ACTIVE"
  ].includes(text(error && error.code).toUpperCase());
}

Page({
  data: {
    teacherRef: "", staff: null, teacherId: "", profile: {}, loading: true, mutating: "", message: "", error: false,
    entitlements: [], summaryRows: [], history: [],
    products: [], configureProducts: [], configureLabels: [], configureIndex: 0, configureProductId: "", monthlyAllowance: "",
    rechargeProducts: [], rechargeLabels: [], rechargeIndex: 0, rechargeProductId: "", rechargeCount: "", rechargeNote: "", rechargePending: false,
    overview: { available: 0, used: 0, lifetime: 0, activeProducts: 0 }, newPassword: ""
  },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    this._unloaded = false;
    this.setData({ teacherRef: decodeURIComponent(options.teacherRef || "") });
    this.syncRechargePending();
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },
  onUnload() {
    this._unloaded = true;
    REQUEST_EPOCH_KEYS.forEach((key) => bump(this, key));
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.navigateBack(); },
  profileView(staff) {
    const name = text(staff.staff_name, staff.teacher_name) || "老师";
    return { name, initials: Array.from(name)[0] || "师", code: text(staff.person_code, staff.teacher_code) || "未分配", phone: text(staff.phone) || "未填写", archived: archived(staff), authUid: text(staff.auth_uid) };
  },
  async load() {
    if (this._unloaded) return;
    const request = Object.freeze({
      epoch: bump(this, "_loadRequestEpoch"), profileEpoch: bump(this, "_profileRequestEpoch"),
      productsEpoch: bump(this, "_productsRequestEpoch"), invalidatedExperienceEpoch: bump(this, "_experienceRequestEpoch"),
      teacherRef: text(this.data.teacherRef)
    });
    this.setData({ loading: true, message: "", error: false });
    try {
      const [staffResult, productResult] = await Promise.all([callStaff("listStaff", Object.freeze({ role: "teacher" })), callStaff("listProducts")]);
      if (!current(this, "_loadRequestEpoch", request.epoch)) return;
      const staff = (staffResult.staff || []).find((item) => [item.auth_uid, item.id, item.staff_id, item.teacher_id, item.teacher_code, item.person_code].map(text).includes(request.teacherRef));
      if (!staff) throw new Error("未找到该老师账号或老师主档");
      const teacherId = text(staff.teacher_id, staff.teacherId);
      if (!/^\d+$/.test(teacherId)) throw new Error("老师资料缺少有效数据库编号");
      const products = productSnapshot(productResult.products);
      const patch = { teacherId };
      if (current(this, "_profileRequestEpoch", request.profileEpoch)) Object.assign(patch, { staff, profile: this.profileView(staff) });
      if (current(this, "_productsRequestEpoch", request.productsEpoch)) patch.products = products;
      this.setData(patch);
      try {
        await this.loadExperience({ teacherId, products });
      } catch (error) {
        if (current(this, "_loadRequestEpoch", request.epoch)) this.setData({ message: error.message || "老师体验数据读取失败", error: true });
      }
    } catch (error) {
      if (!current(this, "_loadRequestEpoch", request.epoch)) return;
      const patch = { message: error.message || "老师主页读取失败", error: true };
      if (current(this, "_profileRequestEpoch", request.profileEpoch)) Object.assign(patch, { staff: null, teacherId: "", profile: {} });
      if (current(this, "_productsRequestEpoch", request.productsEpoch)) patch.products = [];
      if (current(this, "_experienceRequestEpoch", request.invalidatedExperienceEpoch)) Object.assign(patch, emptyExperienceState());
      this.setData(patch);
    } finally {
      if (current(this, "_loadRequestEpoch", request.epoch)) this.setData({ loading: false });
    }
  },
  async refreshStaff() {
    const request = Object.freeze({
      epoch: bump(this, "_profileRequestEpoch"), teacherId: text(this.data.teacherId), teacherRef: text(this.data.teacherRef)
    });
    try {
      const result = await callStaff("listStaff", Object.freeze({ role: "teacher" }));
      const staff = (result.staff || []).find((item) => text(item.teacher_id) === request.teacherId || [item.auth_uid, item.id, item.person_code].map(text).includes(request.teacherRef));
      if (!staff) throw new Error("状态修改后未能重新读取老师资料");
      if (!current(this, "_profileRequestEpoch", request.epoch)) return null;
      this.setData({ staff, profile: this.profileView(staff) });
      return staff;
    } catch (error) {
      if (!current(this, "_profileRequestEpoch", request.epoch)) return null;
      this.setData({ staff: null, profile: {} });
      throw error;
    }
  },
  async loadExperience(options = {}) {
    const teacherId = text(options.teacherId, this.data.teacherId);
    if (!teacherId) throw new Error("老师资料缺少有效数据库编号");
    const request = Object.freeze({
      epoch: bump(this, "_experienceRequestEpoch"), teacherId,
      products: productSnapshot(options.products || this.data.products)
    });
    try {
      const data = await callStaff("getTeacherExperienceEntitlements", Object.freeze({ teacherId: request.teacherId }));
      if (!current(this, "_experienceRequestEpoch", request.epoch)) return false;
      const selected = { configureProductId: this.data.configureProductId, rechargeProductId: this.data.rechargeProductId };
      this.setData(experienceState(data, request.products, selected));
      return true;
    } catch (error) {
      if (!current(this, "_experienceRequestEpoch", request.epoch)) return false;
      this.setData(emptyExperienceState());
      throw error;
    }
  },
  chooseConfigureProduct(event) { const index = Number(event.detail.value || 0); this.setData({ configureIndex: index, configureProductId: this.data.configureProducts[index] && this.data.configureProducts[index].id || "" }); },
  chooseRechargeProduct(event) { const index = Number(event.detail.value || 0); this.setData({ rechargeIndex: index, rechargeProductId: this.data.rechargeProducts[index] && this.data.rechargeProducts[index].productId || "" }); },
  input(event) { const field = event.currentTarget.dataset.field; this.setData({ [field]: event.detail.value }); },
  syncRechargePending() {
    let intent = null;
    try { intent = rechargeIntent.read(); }
    catch (error) { this.setData({ rechargePending: true, message: error.message || "体验充值防重复提交锁读取失败", error: true }); return null; }
    this.setData({ rechargePending: Boolean(intent) });
    return intent;
  },
  async saveConfiguration() {
    if (this.data.mutating || this.data.profile.archived) return;
    const monthlyAllowance = Number(this.data.monthlyAllowance);
    if (!this.data.configureProductId || !Number.isInteger(monthlyAllowance) || monthlyAllowance < 0 || monthlyAllowance > 99999) return this.setData({ message: "请选择产品，并填写 0 至 99,999 的整数体验次数。", error: true });
    const request = Object.freeze({
      epoch: bump(this, "_mutationRequestEpoch"), teacherId: text(this.data.teacherId),
      productId: text(this.data.configureProductId), monthlyAllowance
    });
    this.setData({ mutating: "configure", message: "正在保存体验额度配置…", error: false });
    try {
      await callStaff("upsertTeacherExperienceEntitlement", Object.freeze({ teacherId: request.teacherId, productId: request.productId, monthlyAllowance: request.monthlyAllowance }));
      if (!current(this, "_mutationRequestEpoch", request.epoch)) return;
      if (!await this.loadExperience({ teacherId: request.teacherId })) return;
      if (!current(this, "_mutationRequestEpoch", request.epoch)) return;
      this.setData({ monthlyAllowance: "", message: `体验额度已保存并立即生效：当前可用 ${request.monthlyAllowance} 次。`, error: false });
    } catch (error) {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ message: error.message || "体验额度配置失败", error: true });
    } finally {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ mutating: "" });
    }
  },
  async recharge() {
    if (this.data.mutating || this.data.profile.archived || this.data.rechargePending) return;
    const unitCount = Number(this.data.rechargeCount);
    if (!this.data.rechargeProductId || !Number.isInteger(unitCount) || unitCount < 1 || unitCount > 99999) return this.setData({ message: "请选择已配置产品，并填写 1 至 99,999 的整数充值次数。", error: true });
    let intent;
    try {
      intent = rechargeIntent.begin({
        teacherId: text(this.data.teacherId), productId: text(this.data.rechargeProductId),
        unitCount, note: text(this.data.rechargeNote)
      });
    } catch (error) {
      this.syncRechargePending();
      this.setData({ message: error.message || "无法建立体验充值防重复提交锁", error: true });
      return;
    }
    this.setData({ rechargePending: true });
    await this.runRechargeIntent(intent, false);
  },
  async recoverRecharge() {
    if (this.data.mutating) return;
    const intent = this.syncRechargePending();
    if (!intent) return this.setData({ message: "当前没有待确认的体验充值。", error: false });
    await this.runRechargeIntent(intent, true);
  },
  async runRechargeIntent(intent, recovering) {
    const request = Object.freeze({
      epoch: bump(this, "_mutationRequestEpoch"), teacherId: text(intent.teacherId), productId: text(intent.productId),
      unitCount: Number(intent.unitCount), note: text(intent.note), clientRequestId: text(intent.clientRequestId)
    });
    if (!this._unloaded) this.setData({ mutating: "recharge", rechargePending: true, message: recovering ? "正在确认上次体验充值结果…" : "正在为老师充值体验次数…", error: false });
    try {
      const result = await callStaff("rechargeTeacherExperienceEntitlement", Object.freeze({
        teacherId: request.teacherId, productId: request.productId, unitCount: request.unitCount,
        note: request.note, clientRequestId: request.clientRequestId
      }));
      const proof = exactRechargeProof(result, request);
      rechargeIntent.confirm(request.clientRequestId, proof.rechargeId);
      const readback = await callStaff("getTeacherExperienceEntitlements", Object.freeze({ teacherId: request.teacherId }));
      if (text(readback && readback.teacher && (readback.teacher.id || readback.teacher.teacherId)) !== request.teacherId) {
        throw new Error("体验充值后的数据库回读老师不一致，防重复提交锁仍保留");
      }
      if (!(readback.entitlements || []).some((row) => text(row.productId, row.product_id) === request.productId)) {
        throw new Error("体验充值后的数据库回读产品不一致，防重复提交锁仍保留");
      }
      if (!rechargeIntent.acknowledge(request.clientRequestId, proof.rechargeId)) {
        throw new Error("体验充值已写入，但原请求确认信息不一致，防重复提交锁仍保留");
      }
      if (!this._unloaded && current(this, "_mutationRequestEpoch", request.epoch)) {
        if (text(this.data.teacherId) === request.teacherId) {
          const selected = { configureProductId: this.data.configureProductId, rechargeProductId: this.data.rechargeProductId };
          this.setData(experienceState(readback, this.data.products, selected));
        }
        this.setData({
          rechargeCount: "", rechargeNote: "", rechargePending: false,
          message: recovering ? "上次老师体验充值已从数据库确认；未重复增加次数。" : "老师体验次数已充值；客户余额未发生变化。",
          error: false
        });
      }
    } catch (error) {
      let pending = true;
      try {
        if (definitiveRechargeRejection(error)) {
          pending = !rechargeIntent.clearRejected(request.clientRequestId);
          if (pending) rechargeIntent.markUncertain(request.clientRequestId);
        } else {
          rechargeIntent.markUncertain(request.clientRequestId);
        }
      } catch (lockError) {
        error = lockError;
        pending = true;
      }
      if (!this._unloaded && current(this, "_mutationRequestEpoch", request.epoch)) {
        this.setData({
          rechargePending: pending,
          message: pending
            ? `${error.message || "体验充值结果暂时无法确认"}。请点击“确认上次充值结果”，不要重新充值。`
            : error.message || "体验次数充值未执行，请修改后重试。",
          error: true
        });
      }
    } finally {
      if (!this._unloaded && current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ mutating: "" });
    }
  },
  async deleteConfiguration(event) {
    if (this.data.mutating || this.data.profile.archived) return;
    const productId = String(event.currentTarget.dataset.id || "");
    const row = this.data.entitlements.find((item) => item.productId === productId);
    if (!row || !await confirm(`确认删除“${row.productName}”的当前体验额度配置？历史记录仍会保留。`, "删除")) return;
    if (this._unloaded) return;
    const request = Object.freeze({ epoch: bump(this, "_mutationRequestEpoch"), teacherId: text(this.data.teacherId), productId, productName: row.productName });
    this.setData({ mutating: `delete:${productId}`, message: "正在删除体验额度配置…", error: false });
    try {
      await callStaff("deleteTeacherExperienceEntitlement", Object.freeze({ teacherId: request.teacherId, productId: request.productId }));
      if (!current(this, "_mutationRequestEpoch", request.epoch)) return;
      if (!await this.loadExperience({ teacherId: request.teacherId })) return;
      if (!current(this, "_mutationRequestEpoch", request.epoch)) return;
      this.setData({ message: "体验额度配置已删除，历史记录继续保留。", error: false });
    } catch (error) {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ message: error.message || "体验额度删除失败", error: true });
    } finally {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ mutating: "" });
    }
  },
  async resetPassword() {
    if (this.data.mutating || !this.data.profile.authUid) return;
    if (!validPassword(this.data.newPassword)) return this.setData({ message: "新临时密码需为 8–32 位，以字母或数字开头，并至少包含三类字符。", error: true });
    if (!await confirm(`确认重置“${this.data.profile.name}”的临时密码？老师下次登录后仍需自行修改。`, "确认重置")) return;
    if (this._unloaded) return;
    const request = Object.freeze({
      epoch: bump(this, "_mutationRequestEpoch"), uid: text(this.data.profile.authUid),
      newPassword: String(this.data.newPassword), teacherId: text(this.data.teacherId), teacherRef: text(this.data.teacherRef)
    });
    this.setData({ mutating: "password", message: "正在保存新临时密码…", error: false });
    try {
      await callStaff("resetPassword", Object.freeze({ uid: request.uid, newPassword: request.newPassword }));
      if (!current(this, "_mutationRequestEpoch", request.epoch)) return;
      const refreshed = await this.refreshStaff();
      if (!refreshed || !current(this, "_mutationRequestEpoch", request.epoch)) return;
      this.setData({ newPassword: "", message: "新临时密码已保存。", error: false });
    } catch (error) {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ message: error.message || "密码重置失败", error: true });
    } finally {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ mutating: "" });
    }
  },
  async toggleStatus() {
    if (this.data.mutating || !this.data.staff) return;
    const next = this.data.profile.archived ? "ACTIVE" : "ARCHIVED";
    const action = next === "ARCHIVED" ? "封存" : "激活";
    if (!await confirm(`确认${action}老师“${this.data.profile.name}”？历史业务和体验额度记录会完整保留。`, action)) return;
    if (this._unloaded) return;
    const request = Object.freeze({
      epoch: bump(this, "_mutationRequestEpoch"), next, action, authUid: text(this.data.profile.authUid),
      phone: this.data.profile.phone === "未填写" ? "" : text(this.data.profile.phone), teacherId: text(this.data.teacherId)
    });
    bump(this, "_profileRequestEpoch");
    this.setData({ mutating: "status", message: `正在${action}老师…`, error: false });
    try {
      if (request.authUid) await callStaff("setStaffStatus", Object.freeze({ uid: request.authUid, phone: request.phone, status: request.next }));
      else await callStaff("setMasterStatus", Object.freeze({ teacherId: request.teacherId, status: request.next }));
      if (!current(this, "_mutationRequestEpoch", request.epoch)) return;
      const refreshed = await this.refreshStaff();
      if (!refreshed || !current(this, "_mutationRequestEpoch", request.epoch)) return;
      if (archived(refreshed) !== (next === "ARCHIVED")) throw new Error("数据库回读状态与本次操作不一致");
      if (!await this.loadExperience({ teacherId: request.teacherId })) return;
      if (!current(this, "_mutationRequestEpoch", request.epoch)) return;
      this.setData({ message: `老师已${request.action}。`, error: false });
    } catch (error) {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ message: error.message || `老师${request.action}失败`, error: true });
    } finally {
      if (current(this, "_mutationRequestEpoch", request.epoch)) this.setData({ mutating: "" });
    }
  }
});
