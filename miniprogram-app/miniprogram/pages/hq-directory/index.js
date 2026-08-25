const { callStaff, callTeacherCreate } = require("../../services/api");
const { requireSession } = require("../../services/session");

const META = Object.freeze({
  product: { title: "产品管理", noun: "产品", action: "listProducts" },
  store: { title: "门店管理", noun: "门店", action: "listStores" },
  teacher: { title: "老师管理", noun: "老师", action: "listStaff" }
});

function text(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item).trim());
  return String(value || "").trim();
}
function normalizedPhone(value) { return String(value || "").replace(/\D/g, ""); }
function validPhone(value) { return /^1[3-9]\d{9}$/.test(normalizedPhone(value)); }
function validPassword(value) {
  const password = String(value || "");
  const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(password)).length;
  return password.length >= 8 && password.length <= 32 && /^[A-Za-z0-9]/.test(password) && groups >= 3;
}
function requestId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`.slice(0, 64);
}
function archived(item) {
  const status = [item.product_status, item.store_status, item.account_status, item.teacher_status, item.status]
    .map((value) => text(value).toUpperCase()).filter(Boolean);
  return status.includes("ARCHIVED");
}
function normalizeProduct(item) {
  return {
    id: text(item.id), ref: text(item.product_code, item.id), code: text(item.product_code),
    name: text(item.product_name, item.name) || "未命名产品", type: text(item.product_type) || "未分类",
    description: text(item.description) || "未填写介绍", phone: "", secondary: text(item.product_type) || "未分类",
    tertiary: text(item.description) || "未填写介绍", archived: archived(item)
  };
}
function normalizeStore(item) {
  const address = [item.province, item.city, item.district, item.address_detail].map(text).filter(Boolean).join(" ");
  return {
    id: text(item.id), ref: text(item.id, item.store_code), code: text(item.store_code),
    name: text(item.store_name, item.name) || "未命名门店", phone: text(item.contact_phone, item.phone),
    contact: text(item.contact_name, item.staff_name) || "—", secondary: text(item.contact_name, item.staff_name) || "—",
    tertiary: address || "未填写地址", address: address || "未填写地址", authUid: text(item.auth_uid), archived: archived(item)
  };
}
function normalizeTeacher(item) {
  const authoritative = [item.account_status, item.teacher_status].map((value) => text(value).toUpperCase())
    .filter((value) => ["ACTIVE", "ARCHIVED"].includes(value));
  return {
    id: text(item.id), teacherId: text(item.teacher_id, item.teacherId), ref: text(item.auth_uid, item.teacher_id, item.id),
    code: text(item.person_code, item.teacher_code), name: text(item.staff_name, item.teacher_name, item.name) || "未命名老师",
    phone: text(item.phone), secondary: text(item.person_code, item.teacher_code) || "—", tertiary: text(item.phone) || "—",
    authUid: text(item.auth_uid), archived: authoritative.length ? authoritative.includes("ARCHIVED") : archived(item)
  };
}
function confirmModal(content) {
  return new Promise((resolve) => wx.showModal({ title: "请确认", content, confirmText: "确认", success: (result) => resolve(result.confirm), fail: () => resolve(false) }));
}

Page({
  data: {
    session: {}, type: "product", title: "产品管理", noun: "产品", loading: true, mutating: false,
    message: "", error: false, rows: [], activeRows: [], archivedRows: [], searched: false, searchRows: [],
    searchName: "", searchPhone: "", createOpen: false, createLocked: false, createRequestId: "", pendingStoreId: "", detailOpen: false, current: null,
    form: { name: "", category: "", description: "", region: [], regionText: "", address: "", contactName: "", phone: "", password: "" },
    experienceLoading: false, experienceRows: [], experienceHistory: []
  },

  async onLoad(options) {
    const session = requireSession(["hq"]);
    if (!session) return;
    const type = META[options.type] ? options.type : "product";
    const meta = META[type];
    this.setData({ session, type, title: meta.title, noun: meta.noun });
    wx.setNavigationBarTitle({ title: meta.title });
    await this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    if (this.data.loading && this.data.rows.length) return;
    this.setData({ loading: true, message: "", error: false });
    try {
      const meta = META[this.data.type];
      const result = await callStaff(meta.action, this.data.type === "teacher" ? { role: "teacher" } : {});
      const source = this.data.type === "product" ? result.products : this.data.type === "store" ? result.stores : result.staff;
      const mapper = this.data.type === "product" ? normalizeProduct : this.data.type === "store" ? normalizeStore : normalizeTeacher;
      const rows = (source || []).map(mapper);
      this.setData({ rows, activeRows: rows.filter((item) => !item.archived), archivedRows: rows.filter((item) => item.archived) }, () => this.applySearch(false));
    } catch (error) {
      this.setData({ rows: [], activeRows: [], archivedRows: [], message: error.message || `${this.data.noun}数据读取失败`, error: true });
    } finally { this.setData({ loading: false }); }
  },
  inputSearchName(event) { this.setData({ searchName: event.detail.value }); },
  inputSearchPhone(event) { this.setData({ searchPhone: event.detail.value }); },
  runSearch() { this.applySearch(true); },
  resetSearch() { this.setData({ searchName: "", searchPhone: "", searched: false, searchRows: [] }); },
  applySearch(searched = this.data.searched) {
    if (!searched) { this.setData({ searched: false, searchRows: [] }); return; }
    const name = text(this.data.searchName).toLocaleLowerCase("zh-CN");
    const phone = normalizedPhone(this.data.searchPhone);
    const rows = !name && !phone ? [] : this.data.rows.filter((item) =>
      (!name || item.name.toLocaleLowerCase("zh-CN").includes(name) || item.code.toLocaleLowerCase("zh-CN").includes(name))
      && (!phone || normalizedPhone(item.phone).includes(phone)));
    this.setData({ searched: true, searchRows: rows });
  },

  openCreate() {
    if (this.data.createLocked) {
      this.setData({ message: "上一笔老师创建结果待确认，请先离开本页并在老师目录查询，禁止重复提交。", error: true });
      return;
    }
    this.setData({ createOpen: true, message: "", error: false,
      createRequestId: requestId(this.data.type === "teacher" ? "teacher_create" : "product"),
      form: { name: "", category: "", description: "", region: [], regionText: "", address: "", contactName: "", phone: "", password: "" } });
  },
  closeCreate() { if (!this.data.mutating) this.setData({ createOpen: false }); },
  inputForm(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  chooseRegion(event) {
    const region = event.detail.value || [];
    this.setData({ "form.region": region, "form.regionText": region.join(" · ") });
  },
  async submitCreate() {
    if (this.data.mutating || this.data.createLocked) return;
    const form = this.data.form;
    const name = text(form.name);
    if (!name) { this.setData({ message: `请填写${this.data.noun}名称`, error: true }); return; }
    this.setData({ mutating: true, message: `正在创建${this.data.noun}…`, error: false });
    try {
      if (this.data.type === "product") {
        if (!text(form.category)) throw new Error("请填写产品类别");
        await callStaff("createProduct", { productName: name, productType: text(form.category), description: text(form.description), clientRequestId: this.data.createRequestId });
      } else {
        if (!validPhone(form.phone)) throw new Error("请输入有效的中国大陆手机号");
        if (!validPassword(form.password)) throw new Error("初始密码需为 8–32 位、以字母或数字开头，并包含四类字符中的至少三类");
        if (this.data.type === "store") {
          if ((form.region || []).length !== 3 || !text(form.address) || !text(form.contactName)) throw new Error("请完整填写地区、详细地址和联系人");
          await callStaff("createStoreWithAccount", {
            storeName: name, province: form.region[0], city: form.region[1], district: form.region[2],
            addressDetail: text(form.address), contactName: text(form.contactName), contactPhone: normalizedPhone(form.phone), initialPassword: form.password,
            existingStoreId: this.data.pendingStoreId
          });
        } else {
          const result = await callTeacherCreate({ staffName: name, phone: normalizedPhone(form.phone), initialPassword: form.password, clientRequestId: this.data.createRequestId });
          if (result.completed !== true || result.proof?.complete !== true) throw new Error("服务端没有返回完整的账号与老师主档激活证明；请先回列表查询，禁止重复提交");
        }
      }
      await this.load();
      this.setData({ createOpen: false, createLocked: false, createRequestId: "", pendingStoreId: "", message: `${this.data.noun}创建成功，已重新读取数据库`, error: false });
    } catch (error) {
      const uncertainTeacher = this.data.type === "teacher" && (error.submissionUncertain === true || error.transportUncertain === true
        || /TIMEOUT|CLEANUP_INCOMPLETE/.test(`${error.code || ""} ${error.message || ""}`.toUpperCase()));
      const pendingStoreId = this.data.type === "store" && error.storeId && !error.storeRolledBack ? String(error.storeId) : this.data.pendingStoreId;
      this.setData({
        createLocked: uncertainTeacher, pendingStoreId,
        message: uncertainTeacher
          ? "老师创建结果暂时无法确认，请关闭表单后先在老师目录查询，禁止重复提交。"
          : `${error.message || `${this.data.noun}创建失败`}${pendingStoreId ? "；门店资料已保留，可用相同资料再次提交恢复账号绑定" : ""}`,
        error: true
      });
    } finally { this.setData({ mutating: false }); }
  },

  async openDetail(event) {
    const current = this.data.rows.find((item) => item.ref === String(event.currentTarget.dataset.ref || ""));
    if (!current) return;
    this.setData({ current, detailOpen: true, experienceRows: [], experienceHistory: [] });
    if (this.data.type === "teacher" && current.teacherId) {
      this.setData({ experienceLoading: true });
      try {
        const result = await callStaff("getTeacherExperienceEntitlements", { teacherId: current.teacherId });
        this.setData({ experienceRows: result.entitlements || [], experienceHistory: result.history || [] });
      } catch (error) {
        this.setData({ message: error.message || "老师体验额度读取失败", error: true });
      } finally { this.setData({ experienceLoading: false }); }
    }
  },
  closeDetail() { this.setData({ detailOpen: false, current: null }); },
  noop() {},
  async toggleStatus(event) {
    if (this.data.mutating) return;
    const row = this.data.rows.find((item) => item.ref === String(event.currentTarget.dataset.ref || ""));
    if (!row) return;
    const next = row.archived ? "ACTIVE" : "ARCHIVED";
    const action = row.archived ? "激活" : "封存";
    const warning = row.archived
      ? `确认激活${this.data.noun}“${row.name}”？`
      : `确认封存${this.data.noun}“${row.name}”？历史业务和统计会完整保留。`;
    if (!await confirmModal(warning)) return;
    this.setData({ mutating: true, message: `正在${action}${this.data.noun}…`, error: false });
    try {
      if (this.data.type === "product") await callStaff("setProductStatus", { productRef: row.ref, status: next });
      else if (this.data.type === "store") await callStaff("setMasterStatus", { storeId: row.id, status: next });
      else if (row.teacherId) await callStaff("setMasterStatus", { teacherId: row.teacherId, status: next });
      else await callStaff("setStaffStatus", { uid: row.authUid, phone: row.phone, status: next });
      await this.load();
      const current = this.data.rows.find((item) => item.ref === row.ref);
      if (!current || current.archived !== (next === "ARCHIVED")) throw new Error(`${action}结果未能由数据库确认，请刷新后核对，禁止连续重复提交`);
      this.setData({ detailOpen: false, current: null, message: `${action}成功，数据库状态已确认`, error: false });
    } catch (error) {
      await this.load();
      this.setData({ message: error.message || `${this.data.noun}${action}失败`, error: true });
    } finally { this.setData({ mutating: false }); }
  }
});
