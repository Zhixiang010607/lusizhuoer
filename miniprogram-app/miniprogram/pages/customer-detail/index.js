const { callFace } = require("../../services/api");
const { requireSession } = require("../../services/session");
const query = require("../../services/query-tools");

const HISTORY_LIMIT = 50;
const MESSAGE_LIMIT = 20;
const HISTORY_FIELDS = Object.freeze({
  RECHARGE: "recharges",
  REFUND: "refunds",
  VERIFICATION: "verifications",
  EXPERIENCE: "experiences",
  PRODUCT_PURCHASE: "productPurchases"
});

function clean(value) { return String(value ?? "").trim(); }
function freshHistoryState() {
  return {
    RECHARGE: { hasMore: false, nextCursor: null, loading: false, message: "", error: false },
    REFUND: { hasMore: false, nextCursor: null, loading: false, message: "", error: false },
    VERIFICATION: { hasMore: false, nextCursor: null, loading: false, message: "", error: false },
    EXPERIENCE: { hasMore: false, nextCursor: null, loading: false, message: "", error: false },
    PRODUCT_PURCHASE: { hasMore: false, nextCursor: null, loading: false, message: "", error: false }
  };
}
function messageRole(value) {
  return ({ hq: "总部", store: "门店", teacher: "老师" })[clean(value).toLowerCase()] || "账号";
}
function businessTeacher(row = {}) {
  const name = clean(row.teacherName);
  return name || "未指定";
}
function orderStatus(row = {}, type = "RECHARGE") {
  const status = clean(row.recordStatus).toUpperCase();
  if (!["RECHARGE", "REFUND"].includes(type)) {
    if (status === "VOIDED") return "历史已作废";
    const verificationType = clean(row.verificationType).toUpperCase();
    if (["NORMAL", "EXPERIENCE"].includes(verificationType) && status === "APPROVED") return "已完成";
    return ({ PENDING: "待审核", APPROVED: "审核通过", REJECTED: "已驳回" })[status] || "未记录";
  }
  const voidStatus = clean(row.voidRequestStatus || "NONE").toUpperCase();
  if (status === "VOIDED" || voidStatus === "APPROVED") return "已作废";
  const base = ({ PENDING: "待审核", APPROVED: "审核通过", REJECTED: "已驳回" })[status] || "未记录";
  if (status === "APPROVED" && voidStatus === "PENDING") return `${base} · 作废待审核`;
  if (status === "APPROVED" && voidStatus === "REJECTED") return `${base} · 作废已驳回`;
  return base;
}
function mapHistoryRow(row = {}, type = "RECHARGE") {
  const rechargeHistory = ["RECHARGE", "REFUND"].includes(type);
  const productPurchase = type === "PRODUCT_PURCHASE";
  const originalType = clean(row.rechargeType || row.verificationType).toUpperCase();
  const units = Math.abs(Number(row.unitCount || (rechargeHistory || productPurchase ? 0 : 1)));
  const negative = rechargeHistory && ["REFUND", "VOID"].includes(originalType);
  return {
    ...row,
    id: clean(row.id),
    recordCode: clean(row.rechargeCode || row.verificationCode || row.purchaseCode || row.id) || "—",
    originalType,
    productName: clean(row.productName) || "—",
    teacherLabel: businessTeacher(row),
    unitLabel: productPurchase ? `${units} 件` : `${rechargeHistory ? (negative ? "−" : "+") : ""}${units} 次`,
    submittedAtLabel: query.displayDateTimeAny(
      row.submittedAt, row.submitted_at, row.applicationTime, row.application_time,
      row.originalSubmittedAt, row.original_submitted_at, row.createdAt, row.created_at
    ),
    statusLabel: orderStatus(row, type)
  };
}
function mapHistory(rows, type) {
  return (Array.isArray(rows) ? rows : []).map((row) => mapHistoryRow(row, type));
}
function mapProfile(value = {}) {
  return {
    ...value,
    customerCode: clean(value.customerCode),
    customerName: clean(value.customerName) || "—",
    birthDateLabel: query.displayDateAny(value.birthDate, value.birth_date),
    storeLabel: [clean(value.storeName), clean(value.storeCode)].filter(Boolean).join(" · ") || "—",
    latestRechargeLabel: query.displayDateAny(value.latestRechargeAt, value.latest_recharge_at),
    latestVerificationLabel: query.displayDateAny(value.latestVerificationAt, value.latest_verification_at),
    createdAtLabel: query.displayDateAny(value.createdAt, value.created_at),
    customerStatus: clean(value.customerStatus).toUpperCase() === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
    totalRechargeCount: Number(value.totalRechargeCount || 0),
    totalVerificationCount: Number(value.totalVerificationCount || 0),
    totalExperienceCount: Number(value.totalExperienceCount || 0)
  };
}
function mapBalances(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    productName: clean(row.productName) || "—",
    productCode: clean(row.productCode),
    totalRechargeCount: Number(row.totalRechargeCount || 0),
    totalVerificationCount: Number(row.totalVerificationCount || 0),
    remainingCount: Number(row.remainingCount || 0)
  }));
}
function mapRetailProductSummary(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    productId: clean(row.productId), productName: clean(row.productName) || "—",
    purchasedCount: Number(row.purchasedCount || 0), giftedCount: Number(row.giftedCount || 0)
  }));
}
function retailSummaryView(rows) {
  const retailProductSummary = mapRetailProductSummary(rows);
  const visibleRows = Math.min(5, retailProductSummary.length);
  return {
    retailProductSummary,
    retailSummaryScrollable: retailProductSummary.length > 5,
    retailSummaryViewportHeight: 68 + visibleRows * 76
  };
}
function mapMessages(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    id: clean(row.id),
    authorLabel: clean(row.authorName) || "未命名账号",
    roleLabel: messageRole(row.authorRole),
    createdAtLabel: query.displayDateTimeAny(
      row.createdAt, row.created_at, row.messageTime, row.message_time, row.submittedAt, row.submitted_at
    ),
    content: String(row.content || "")
  }));
}

Page({
  data: {
    session: {}, canManageStatus: false, canEditNotes: false,
    customerCode: "", profile: null, balances: [], retailProductSummary: [],
    retailSummaryScrollable: false, retailSummaryViewportHeight: 68,
    recharges: [], refunds: [], verifications: [], experiences: [], productPurchases: [],
    historyType: "RECHARGE", visibleHistory: [], historyHasMore: false, historyScrollLeft: 0,
    historyLoading: false, historyMessage: "", historyError: false,
    messages: [], messageTotal: 0, messageHasMore: false,
    messagesLoading: false, messageSubmitting: false, messageText: "", messageLength: 0,
    messageMessage: "", messageError: false,
    notes: "", originalNotes: "", notesEditing: false, notesChanged: false,
    savingNotes: false, notesMessage: "", notesError: false,
    statusUpdating: false, statusMessage: "", statusError: false,
    photoUrl: "", photoLoading: false, photoMessage: "", photoError: false,
    loading: false, message: "", error: false
  },

  onLoad(options = {}) {
    const session = requireSession(["hq", "store", "teacher"]);
    if (!session) return;
    this._historyState = freshHistoryState();
    this._messageCursor = null;
    this._profileEpoch = 0;
    this._photoEpoch = 0;
    this._messageEpoch = 0;
    this.setData({
      session,
      canManageStatus: session.role === "hq" || session.role === "store",
      canEditNotes: ["hq", "store", "teacher"].includes(session.role),
      customerCode: decodeURIComponent(options.customerCode || "")
    });
    void this.load();
  },
  onUnload() {
    this._profileEpoch = Number(this._profileEpoch || 0) + 1;
    this._photoEpoch = Number(this._photoEpoch || 0) + 1;
    this._messageEpoch = Number(this._messageEpoch || 0) + 1;
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    if (!this.data.customerCode) {
      this.setData({ message: "缺少客户编号", error: true });
      return;
    }
    const epoch = Number(this._profileEpoch || 0) + 1;
    this._profileEpoch = epoch;
    this._historyState = freshHistoryState();
    this.setData({
      loading: true, message: "", error: false,
      profile: null, balances: [], retailProductSummary: [], retailSummaryScrollable: false, retailSummaryViewportHeight: 68,
      recharges: [], refunds: [], verifications: [], experiences: [], productPurchases: [],
      visibleHistory: [], historyHasMore: false, historyLoading: false, historyScrollLeft: 0,
      historyMessage: "", historyError: false,
      notesEditing: false, notesChanged: false, notesMessage: "", notesError: false,
      statusMessage: "", statusError: false
    });
    void this.loadPhoto();
    try {
      const result = await callFace("getCustomerProfile", {
        customerCode: this.data.customerCode,
        historyLimit: HISTORY_LIMIT
      });
      if (epoch !== this._profileEpoch) return;
      const profile = mapProfile(result.customer || {});
      if (!profile.customerCode || profile.customerCode !== this.data.customerCode) {
        throw new Error("服务端返回的客户档案与当前客户不一致");
      }
      const nextHistory = freshHistoryState();
      for (const [type, field] of Object.entries(HISTORY_FIELDS)) {
        const page = result.history?.[field] || {};
        nextHistory[type].hasMore = page.hasMore === true;
        nextHistory[type].nextCursor = page.nextCursor || null;
      }
      this._historyState = nextHistory;
      const notes = String(profile.notes || "");
      this.setData({
        profile,
        balances: mapBalances(result.balances),
        ...retailSummaryView(result.retailProductSummary),
        recharges: mapHistory(result.recharges, "RECHARGE"),
        refunds: mapHistory(result.refunds, "REFUND"),
        verifications: mapHistory(result.verifications, "VERIFICATION"),
        experiences: mapHistory(result.experiences, "EXPERIENCE"),
        productPurchases: mapHistory(result.productPurchases, "PRODUCT_PURCHASE"),
        notes, originalNotes: notes
      });
      this.syncHistory();
      void this.loadMessages({ reset: true });
    } catch (error) {
      if (epoch === this._profileEpoch) {
        this.setData({ message: error.message || "客户主页读取失败", error: true });
      }
    } finally {
      if (epoch === this._profileEpoch) this.setData({ loading: false });
    }
  },

  async loadPhoto() {
    if (!this.data.customerCode) return;
    const epoch = Number(this._photoEpoch || 0) + 1;
    this._photoEpoch = epoch;
    this.setData({ photoLoading: true, photoUrl: "", photoMessage: "正在读取客户照片…", photoError: false });
    try {
      const result = await callFace("getCustomerPhotoUrl", { customerCode: this.data.customerCode });
      if (epoch !== this._photoEpoch) return;
      if (!/^https:\/\//i.test(String(result.photoUrl || ""))) throw new Error("服务端未返回有效的照片临时地址");
      this.setData({ photoUrl: result.photoUrl, photoMessage: "", photoError: false });
    } catch (error) {
      if (epoch === this._photoEpoch) {
        this.setData({ photoUrl: "", photoMessage: error.message || "客户照片暂时无法显示", photoError: true });
      }
    } finally {
      if (epoch === this._photoEpoch) this.setData({ photoLoading: false });
    }
  },
  photoFailed() {
    this.setData({
      photoUrl: "",
      photoMessage: "客户照片暂时无法显示，请稍后重新进入客户主页。",
      photoError: true
    });
  },
  previewPhoto() {
    if (this.data.photoUrl) wx.previewImage({ current: this.data.photoUrl, urls: [this.data.photoUrl] });
  },

  startEditNotes() {
    if (!this.data.canEditNotes || this.data.savingNotes) return;
    this.setData({
      notes: this.data.originalNotes, notesEditing: true, notesChanged: false,
      notesMessage: "", notesError: false
    });
  },
  inputNotes(event) {
    const notes = String(event.detail.value || "");
    this.setData({ notes, notesChanged: notes !== this.data.originalNotes, notesMessage: "", notesError: false });
  },
  cancelEditNotes() {
    if (this.data.savingNotes) return;
    this.setData({
      notes: this.data.originalNotes, notesEditing: false, notesChanged: false,
      notesMessage: "", notesError: false
    });
  },
  async saveNotes() {
    if (!this.data.canEditNotes || !this.data.notesEditing || this.data.savingNotes) return;
    const notes = String(this.data.notes || "").replace(/\r\n?/g, "\n").trim();
    if (notes.length > 5000) {
      this.setData({ notesMessage: "客户备注不能超过 5000 个字符", notesError: true });
      return;
    }
    this.setData({ savingNotes: true, notesMessage: "正在保存备注…", notesError: false });
    try {
      const result = await callFace("updateCustomerNotes", {
        customerCode: this.data.customerCode,
        expectedNotes: this.data.originalNotes,
        notes
      });
      const saved = String(result.customer?.notes ?? notes);
      this.setData({
        profile: { ...this.data.profile, notes: saved },
        notes: saved, originalNotes: saved, notesEditing: false, notesChanged: false,
        notesMessage: "备注已保存", notesError: false
      });
    } catch (error) {
      this.setData({ notesMessage: error.message || "备注保存失败", notesError: true });
    } finally { this.setData({ savingNotes: false }); }
  },

  changeHistory(event) {
    const type = clean(event.currentTarget.dataset.type).toUpperCase();
    if (!HISTORY_FIELDS[type]) return;
    this.setData({ historyType: type, historyScrollLeft: 0 });
    this.syncHistory();
  },
  rememberHistoryScroll(event) {
    const scrollLeft = Number(event.detail && event.detail.scrollLeft);
    if (Number.isFinite(scrollLeft) && scrollLeft >= 0) this.data.historyScrollLeft = scrollLeft;
  },
  syncHistory() {
    const type = this.data.historyType;
    const field = HISTORY_FIELDS[type] || HISTORY_FIELDS.RECHARGE;
    const state = this._historyState?.[type] || freshHistoryState()[type];
    this.setData({
      visibleHistory: this.data[field] || [],
      historyHasMore: state.hasMore === true,
      historyLoading: state.loading === true,
      historyMessage: state.message || "",
      historyError: state.error === true
    });
  },
  async loadMoreHistory() {
    const type = this.data.historyType;
    const field = HISTORY_FIELDS[type];
    const state = this._historyState?.[type];
    if (!field || !state?.hasMore || !state.nextCursor || state.loading) return;
    const profileEpoch = this._profileEpoch;
    state.loading = true;
    state.message = "正在加载更多记录…";
    state.error = false;
    this.syncHistory();
    try {
      const result = await callFace("getCustomerProfile", {
        customerCode: this.data.customerCode,
        historyType: type,
        historyLimit: HISTORY_LIMIT,
        cursorSubmittedAt: state.nextCursor.submittedAt,
        cursorId: state.nextCursor.id
      });
      if (profileEpoch !== this._profileEpoch) return;
      const incoming = mapHistory(result[field], type);
      const known = new Set((this.data[field] || []).map((row) => row.id));
      const combined = [...(this.data[field] || []), ...incoming.filter((row) => !known.has(row.id))];
      const page = result.history?.[field] || {};
      state.hasMore = page.hasMore === true;
      state.nextCursor = page.nextCursor || null;
      state.message = incoming.length ? `已加载 ${incoming.length} 条记录` : "没有更多记录";
      state.error = false;
      this.setData({ [field]: combined });
    } catch (error) {
      state.message = error.message || "历史记录加载失败，请重试";
      state.error = true;
    } finally {
      state.loading = false;
      this.syncHistory();
    }
  },
  openOrder(event) {
    const id = clean(event.currentTarget.dataset.id);
    if (!id) return;
    const code = clean(event.currentTarget.dataset.code);
    const historyType = clean(this.data.historyType || "RECHARGE").toUpperCase();
    if (historyType === "PRODUCT_PURCHASE") {
      if (this.data.session.role !== "hq") return;
      wx.navigateTo({ url: `/pages/product-purchase-detail/index?recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}` });
      return;
    }
    const originalType = clean(event.currentTarget.dataset.originalType).toUpperCase();
    const category = ["RECHARGE", "REFUND"].includes(historyType)
      ? (originalType === "REFUND" ? "REFUND" : originalType === "VOID" ? "VOID" : "RECHARGE")
      : (originalType === "EXPERIENCE" ? "EXPERIENCE" : originalType === "SUPPLEMENT" ? "SUPPLEMENT" : "VERIFICATION");
    const baseType = ["RECHARGE", "REFUND", "VOID"].includes(category) ? "recharge" : "verification";
    wx.navigateTo({
      url: `/pages/order-detail/index?type=${baseType}&category=${category}&recordId=${encodeURIComponent(id)}&recordCode=${encodeURIComponent(code)}`
    });
  },

  async loadMessages({ reset = false } = {}) {
    if (!this.data.customerCode || (this.data.messagesLoading && !reset)) return;
    if (!reset && (!this.data.messageHasMore || !this._messageCursor)) return;
    const epoch = Number(this._messageEpoch || 0) + 1;
    this._messageEpoch = epoch;
    const cursor = reset ? null : this._messageCursor;
    if (reset) this._messageCursor = null;
    this.setData({
      messagesLoading: true,
      messages: reset ? [] : this.data.messages,
      messageTotal: reset ? 0 : this.data.messageTotal,
      messageHasMore: reset ? false : this.data.messageHasMore,
      messageMessage: reset ? "正在读取留言…" : "正在读取更早留言…",
      messageError: false
    });
    try {
      const payload = { customerCode: this.data.customerCode, messageLimit: MESSAGE_LIMIT };
      if (cursor) {
        payload.cursorCreatedAt = cursor.createdAt;
        payload.cursorMessageId = cursor.id;
      }
      const result = await callFace("listCustomerMessages", payload);
      if (epoch !== this._messageEpoch) return;
      const incoming = mapMessages(result.messages);
      const currentMessages = reset ? [] : this.data.messages;
      const known = new Set(currentMessages.map((item) => item.id));
      const messages = [...currentMessages, ...incoming.filter((item) => !known.has(item.id))];
      this._messageCursor = result.page?.nextCursor || null;
      this.setData({
        messages,
        messageTotal: Number(result.totalCount || 0),
        messageHasMore: result.page?.hasMore === true,
        messageMessage: "", messageError: false
      });
    } catch (error) {
      if (epoch === this._messageEpoch) {
        this.setData({ messageMessage: error.message || "客户留言读取失败，请重试", messageError: true });
      }
    } finally {
      if (epoch === this._messageEpoch) this.setData({ messagesLoading: false });
    }
  },
  loadMoreMessages() { void this.loadMessages(); },
  retryMessages() { void this.loadMessages({ reset: true }); },
  inputMessage(event) {
    const parts = Array.from(String(event.detail.value || ""));
    const messageText = parts.slice(0, 100).join("");
    this.setData({
      messageText, messageLength: Array.from(messageText).length,
      messageMessage: "", messageError: false
    });
    return messageText;
  },
  async submitMessage() {
    if (this.data.messageSubmitting) return;
    const content = String(this.data.messageText || "").replace(/\r\n?/g, "\n").trim();
    const length = Array.from(content).length;
    if (!length || length > 100) {
      this.setData({
        messageMessage: length ? "单条留言不能超过 100 字" : "请输入留言内容",
        messageError: true
      });
      return;
    }
    this.setData({ messageSubmitting: true, messageMessage: "正在提交留言…", messageError: false });
    try {
      const result = await callFace("addCustomerMessage", { customerCode: this.data.customerCode, content });
      const saved = mapMessages(result.message ? [result.message] : []);
      const known = new Set(this.data.messages.map((item) => item.id));
      const messages = saved.length && !known.has(saved[0].id)
        ? [saved[0], ...this.data.messages]
        : this.data.messages;
      this.setData({
        messages,
        messageTotal: Number(result.totalCount || messages.length),
        messageText: "", messageLength: 0,
        messageMessage: "留言已保存", messageError: false
      });
    } catch (error) {
      this.setData({ messageMessage: error.message || "客户留言提交失败，请重试", messageError: true });
    } finally { this.setData({ messageSubmitting: false }); }
  },

  toggleCustomerStatus() {
    if (!this.data.canManageStatus || !this.data.profile || this.data.statusUpdating) return;
    const currentStatus = this.data.profile.customerStatus;
    const restoring = currentStatus === "ARCHIVED";
    const targetStatus = restoring ? "ACTIVE" : "ARCHIVED";
    const customerName = this.data.profile.customerName;
    wx.showModal({
      title: restoring ? "恢复为活跃" : "封存客户",
      content: restoring
        ? `确认将客户 ${customerName} 恢复为活跃？`
        : `确认封存客户 ${customerName}？历史记录会继续保留。`,
      confirmText: restoring ? "确认恢复" : "确认封存",
      confirmColor: restoring ? "#607c6a" : "#99574b",
      success: async (modal) => {
        if (!modal.confirm) return;
        this.setData({
          statusUpdating: true,
          statusMessage: `正在${restoring ? "恢复" : "封存"}客户…`,
          statusError: false
        });
        try {
          const result = await callFace("updateCustomerStatus", {
            customerCode: this.data.customerCode,
            expectedStatus: currentStatus,
            targetStatus
          });
          const savedStatus = clean(result.customer?.customerStatus).toUpperCase();
          if (savedStatus !== targetStatus) throw new Error("客户状态更新后回读不一致，请刷新重试");
          this.setData({
            profile: { ...this.data.profile, customerStatus: savedStatus },
            statusMessage: restoring ? "客户已恢复为活跃" : "客户已封存",
            statusError: false
          });
        } catch (error) {
          this.setData({ statusMessage: error.message || "客户状态更新失败", statusError: true });
        } finally { this.setData({ statusUpdating: false }); }
      }
    });
  }
});
