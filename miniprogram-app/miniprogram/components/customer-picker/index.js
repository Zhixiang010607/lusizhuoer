const { callFace } = require("../../services/api");
const { businessToday } = require("../../services/query-tools");

function customer(value) {
  return {
    customerCode: String(value.customerCode || ""),
    customerName: String(value.customerName || ""),
    birthDate: String(value.birthDate || "").slice(0, 10),
    storeId: String(value.storeId || "")
  };
}

function customerCursor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cursor = {
    customerName: String(value.customerName || "").trim(),
    birthDate: String(value.birthDate || "").slice(0, 10),
    customerCode: String(value.customerCode || "").trim()
  };
  return cursor.customerName && cursor.birthDate && cursor.customerCode ? cursor : null;
}

function cursorKey(value) {
  const cursor = customerCursor(value);
  return cursor ? `${cursor.customerName}\u0000${cursor.birthDate}\u0000${cursor.customerCode}` : "";
}

function mergeCustomers(current, incoming) {
  const rows = [];
  const codes = new Set();
  for (const item of [...(current || []), ...(incoming || [])]) {
    const normalized = customer(item);
    if (!normalized.customerCode || !normalized.customerName || !normalized.birthDate || codes.has(normalized.customerCode)) continue;
    codes.add(normalized.customerCode);
    rows.push(normalized);
  }
  return rows;
}

Component({
  properties: {
    storeId: { type: String, value: "", observer() { this.reload(); } }
  },
  data: {
    mode: "select", customers: [], selectedCustomerCode: "", nextCursor: null, hasMore: false,
    listLoading: false, listLoadingMore: false, listMessage: "", listError: false,
    manualName: "", manualBirthday: "", today: businessToday(), duplicateMatches: [], candidate: null,
    photoUrl: "", photoReady: false, photoLoading: false, loading: false, message: "", error: false
  },
  lifetimes: {
    attached() { this.setData({ today: businessToday() }); this.reload(); },
    detached() {
      this._customerListStoreId = "";
      this._customerPageRequestKey = "";
      this._customerListRequestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
    }
  },
  methods: {
    async reload() {
      const storeId = String(this.properties.storeId || "");
      if (storeId && this.data.mode === "select" && this.data.listLoading && this._customerListStoreId === storeId) {
        return this._customerListPromise;
      }
      const requestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._customerListRequestEpoch = requestEpoch;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this._customerPageRequestKey = "";
      const reset = {
        loading: false, listLoading: false, listLoadingMore: false, listMessage: "", listError: false,
        customers: [], selectedCustomerCode: "", nextCursor: null, hasMore: false,
        duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false,
        manualName: "", manualBirthday: "", message: "", error: false
      };
      if (!storeId) {
        this._customerListStoreId = "";
        this.setData(reset);
        this.triggerEvent("change", { customer: null });
        return;
      }
      this._customerListStoreId = storeId;
      this.setData(reset);
      this.triggerEvent("change", { customer: null });
      if (this.data.mode !== "select") return;
      const request = {
        storeId,
        cursor: null,
        append: false,
        requestEpoch
      };
      this._customerListPromise = this.loadCustomerPage(request);
      return this._customerListPromise;
    },
    async loadCustomerPage(request) {
      const storeId = String(request.storeId || "");
      const requestEpoch = Number(request.requestEpoch || 0);
      const append = request.append === true;
      const cursor = customerCursor(request.cursor);
      const requestKey = `${requestEpoch}:${storeId}:${cursorKey(cursor)}`;
      if (!storeId || this._customerPageRequestKey === requestKey) return;
      this._customerPageRequestKey = requestKey;
      this.setData(append ? { listLoadingMore: true } : { listLoading: true });
      try {
        const payload = { storeId, limit: 100 };
        if (cursor) payload.cursor = { ...cursor };
        const result = await callFace("listActiveStoreCustomers", payload);
        if (!this.isCurrentListRequest({ storeId, requestEpoch })) return;
        const incoming = mergeCustomers([], result.customers || []);
        const customers = mergeCustomers(append ? this.data.customers : [], incoming);
        const nextCursor = customerCursor(result.nextCursor);
        const validProgress = !nextCursor || cursorKey(nextCursor) !== cursorKey(cursor);
        const hasMore = Boolean(result.hasMore && nextCursor && validProgress);
        this.setData({
          customers,
          nextCursor: hasMore ? nextCursor : null,
          hasMore,
          listMessage: result.hasMore && !hasMore ? "客户分页信息无效，已停止继续加载，请重试" : "",
          listError: Boolean(result.hasMore && !hasMore)
        });
      } catch (error) {
        if (this.isCurrentListRequest({ storeId, requestEpoch })) {
          this.setData({
            ...(append ? {} : { customers: [], nextCursor: null, hasMore: false, selectedCustomerCode: "" }),
            listMessage: error.message || (append ? "继续加载客户失败，请再次滑到底部重试" : "客户读取失败"),
            listError: true
          });
        }
      } finally {
        if (this._customerPageRequestKey === requestKey) this._customerPageRequestKey = "";
        if (this.isCurrentListRequest({ storeId, requestEpoch })) {
          if (!append) this._customerListStoreId = "";
          this.setData(append ? { listLoadingMore: false } : { listLoading: false });
        }
      }
    },
    isCurrentListRequest(request) {
      return Number(request.requestEpoch || 0) === this._customerListRequestEpoch
        && String(this.properties.storeId || "") === String(request.storeId || "")
        && this.data.mode === "select";
    },
    loadMoreCustomers() {
      const storeId = String(this.properties.storeId || "");
      const cursor = customerCursor(this.data.nextCursor);
      if (this.data.mode !== "select" || !storeId || this.data.listLoading || this.data.listLoadingMore || !this.data.hasMore || !cursor) return undefined;
      return this.loadCustomerPage({
        storeId,
        cursor: { ...cursor },
        append: true,
        requestEpoch: this._customerListRequestEpoch
      });
    },
    changeMode(event) {
      const mode = String(event.currentTarget.dataset.mode || "");
      if (!['select', 'manual'].includes(mode) || mode === this.data.mode) return;
      this._customerListRequestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this._customerPageRequestKey = "";
      this._customerListStoreId = "";
      this.setData({
        mode, customers: [], selectedCustomerCode: "", nextCursor: null, hasMore: false,
        listLoading: false, listLoadingMore: false, listMessage: "", listError: false, loading: false,
        manualName: "", manualBirthday: "", duplicateMatches: [], candidate: null,
        photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false
      });
      this.triggerEvent("change", { customer: null });
      if (mode === "select") return this.reload();
      return undefined;
    },
    inputName(event) {
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.setData({ manualName: event.detail.value, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false });
      this.triggerEvent("change", { customer: null });
    },
    inputBirthday(event) {
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.setData({ manualBirthday: event.detail.value, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false });
      this.triggerEvent("change", { customer: null });
    },
    async selectListedCustomer(event) {
      const code = String(event.currentTarget.dataset.code || "");
      const selected = this.data.customers.find((item) => item.customerCode === code);
      this.setData({ selectedCustomerCode: selected ? code : "" });
      if (selected) await this.loadCandidate(selected);
    },
    async manualSearch() {
      const name = String(this.data.manualName || "").trim();
      const birthDate = this.data.manualBirthday;
      if (!name || !birthDate) return this.setData({ message: "姓名和生日都必须填写", error: true });
      const storeId = String(this.properties.storeId || "");
      const requestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._manualSearchRequestEpoch = requestEpoch;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.setData({ loading: true, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "正在查询…", error: false });
      this.triggerEvent("change", { customer: null });
      try {
        const result = await callFace("listActiveStoreCustomers", { storeId, customerName: name, birthDate, limit: 100 });
        if (requestEpoch !== this._manualSearchRequestEpoch || String(this.properties.storeId || "") !== storeId) return;
        const matches = (result.customers || []).map(customer).filter((item) => item.customerCode && item.customerName && item.birthDate);
        if (!matches.length) throw new Error("未找到当前门店的活跃客户");
        if (matches.length > 1) {
          this.setData({ duplicateMatches: matches, message: `找到 ${matches.length} 位同名同生日客户，请按客户编号选择`, error: false });
          return;
        }
        await this.loadCandidate(matches[0]);
      } catch (error) {
        if (requestEpoch === this._manualSearchRequestEpoch && String(this.properties.storeId || "") === storeId) {
          this.setData({ message: error.message || "查询失败", error: true });
        }
      } finally {
        if (requestEpoch === this._manualSearchRequestEpoch && String(this.properties.storeId || "") === storeId) this.setData({ loading: false });
      }
    },
    async chooseDuplicate(event) {
      const code = String(event.currentTarget.dataset.code || "");
      const selected = this.data.duplicateMatches.find((item) => item.customerCode === code);
      if (!selected) return;
      this.setData({ duplicateMatches: [] });
      await this.loadCandidate(selected);
    },
    async loadCandidate(selected) {
      const storeId = String(this.properties.storeId || "");
      const selectedCustomer = customer(selected || {});
      if (!storeId || !selectedCustomer.customerCode) return;
      const requestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = requestEpoch;
      this.setData({ duplicateMatches: [], candidate: selectedCustomer, photoUrl: "", photoReady: false, photoLoading: true, message: "正在读取客户照片…", error: false });
      this.triggerEvent("change", { customer: null });
      try {
        const result = await callFace("getActiveStoreCustomerDetail", { storeId, customerCode: selectedCustomer.customerCode });
        if (requestEpoch !== this._candidateRequestEpoch || String(this.properties.storeId || "") !== storeId || String(this.data.candidate?.customerCode || "") !== selectedCustomer.customerCode) return;
        const detail = customer(result.customer || selectedCustomer);
        if (detail.customerCode !== selectedCustomer.customerCode || !/^https:\/\//i.test(String(result.photoUrl || ""))) throw new Error("客户详情或照片临时地址无效");
        this.setData({ candidate: detail, photoUrl: result.photoUrl, message: "请核对照片与现场客户", error: false });
      } catch (error) {
        if (requestEpoch === this._candidateRequestEpoch && String(this.properties.storeId || "") === storeId && String(this.data.candidate?.customerCode || "") === selectedCustomer.customerCode) {
          this.setData({ candidate: selectedCustomer, photoUrl: "", photoReady: false, message: error.message || "客户照片读取失败，可单独重读", error: true });
        }
      } finally {
        if (requestEpoch === this._candidateRequestEpoch && String(this.properties.storeId || "") === storeId && String(this.data.candidate?.customerCode || "") === selectedCustomer.customerCode) {
          this.setData({ photoLoading: false });
        }
      }
    },
    photoLoaded(event) {
      const data = event.currentTarget.dataset || {};
      if (String(data.customerCode || "") !== String(this.data.candidate?.customerCode || "") || String(data.photoUrl || "") !== String(this.data.photoUrl || "")) return;
      this.setData({ photoReady: true, message: "照片已加载，请核对后确认", error: false });
    },
    photoFailed(event) {
      const data = event.currentTarget.dataset || {};
      if (String(data.customerCode || "") !== String(this.data.candidate?.customerCode || "") || String(data.photoUrl || "") !== String(this.data.photoUrl || "")) return;
      this.setData({ photoReady: false, message: "客户照片加载失败，禁止继续办理；可单独重读", error: true });
    },
    retryPhoto() {
      if (this.data.candidate && !this.data.loading && !this.data.photoLoading) return this.loadCandidate(this.data.candidate);
      return undefined;
    },
    confirm() {
      if (!this.data.candidate || !this.data.photoReady) return;
      this.triggerEvent("confirm", { customer: { ...this.data.candidate }, photoUrl: this.data.photoUrl });
      this.setData({ message: `已确认 ${this.data.candidate.customerName}`, error: false });
    }
  }
});
