const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const { displayDateTime } = require("../../services/query-tools");

function text(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item).trim());
  return String(value || "").trim();
}

function field(row, snake, camel) { return row?.[snake] ?? row?.[camel] ?? ""; }

function normalize(row = {}) {
  const status = text(field(row, "record_status", "recordStatus")).toUpperCase();
  return {
    id: text(row.id), code: text(field(row, "purchase_code", "purchaseCode")),
    status, statusLabel: ({ PENDING: "待审核", APPROVED: "审核通过", REJECTED: "已驳回" })[status] || "未记录",
    storeName: text(field(row, "store_name", "storeName")) || "—",
    customerName: text(field(row, "customer_name", "customerName")) || "—",
    productName: text(field(row, "product_name_snapshot", "productNameSnapshot")) || "—",
    teacherName: text(field(row, "teacher_name", "teacherName")) || "未指定",
    unitCount: Number(field(row, "unit_count", "unitCount")) || 0,
    submittedAt: displayDateTime(field(row, "submitted_at", "submittedAt")),
    reviewedAt: status === "PENDING" ? "—" : displayDateTime(field(row, "reviewed_at", "reviewedAt")),
    submittedBy: text(field(row, "submitted_by_name", "submittedByName")) || "—",
    reviewedBy: status === "PENDING" ? "—" : text(field(row, "reviewed_by_name", "reviewedByName")) || "—",
    message: text(row.message) || "无",
    reviewNote: status === "PENDING" ? "尚未审核" : text(field(row, "review_note", "reviewNote")) || "无"
  };
}

Page({
  data: { loading: true, message: "", recordId: "", recordCode: "", order: null },
  async onLoad(options) {
    const session = requireSession(["hq"]);
    if (!session) return;
    const recordId = text(options.recordId);
    const recordCode = text(options.recordCode).toUpperCase();
    if (!/^\d+$/.test(recordId) || !/^PP\d{14}$/.test(recordCode)) {
      this.setData({ loading: false, message: "产品购买工单参数无效" });
      return;
    }
    this.setData({ recordId, recordCode });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    await this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onUnload() { this._requestEpoch = Number(this._requestEpoch || 0) + 1; },
  async load() {
    const epoch = Number(this._requestEpoch || 0) + 1;
    this._requestEpoch = epoch;
    this.setData({ loading: true, message: "" });
    try {
      const result = await callStaff("listRetailProductPurchaseReviews", { purchaseCode: this.data.recordCode, limit: 1, pageNumber: 1 });
      if (epoch !== this._requestEpoch) return;
      const source = (result.orders || []).find((row) => text(row.id) === this.data.recordId && text(field(row, "purchase_code", "purchaseCode")) === this.data.recordCode);
      if (!source) throw new Error("未找到该产品购买工单");
      this.setData({ order: normalize(source) });
    } catch (error) {
      if (epoch === this._requestEpoch) this.setData({ order: null, message: error.message || "产品购买工单读取失败" });
    } finally {
      if (epoch === this._requestEpoch) this.setData({ loading: false });
    }
  }
});
