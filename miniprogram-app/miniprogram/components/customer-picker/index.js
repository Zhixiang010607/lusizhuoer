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

Component({
  properties: {
    storeId: { type: String, value: "", observer() { this.reload(); } }
  },
  data: {
    mode: "select", customers: [], customerLabels: [], selectedIndex: -1,
    manualName: "", manualBirthday: "", today: businessToday(), duplicateMatches: [], candidate: null,
    photoUrl: "", photoReady: false, photoLoading: false, loading: false, message: "", error: false
  },
  lifetimes: {
    attached() { this.setData({ today: businessToday() }); this.reload(); },
    detached() {
      this._customerListStoreId = "";
      this._customerListRequestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
    }
  },
  methods: {
    async reload() {
      const storeId = String(this.properties.storeId || "");
      if (storeId && this.data.loading && this._customerListStoreId === storeId) return;
      const requestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._customerListRequestEpoch = requestEpoch;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      if (!storeId) {
        this._customerListStoreId = "";
        this.setData({ loading: false, customers: [], customerLabels: [], selectedIndex: -1, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "" });
        return;
      }
      this._customerListStoreId = storeId;
      this.setData({ loading: true, customers: [], customerLabels: [], selectedIndex: -1, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false });
      this.triggerEvent("change", { customer: null });
      try {
        const result = await callFace("listActiveStoreCustomers", { storeId, limit: 100 });
        if (requestEpoch !== this._customerListRequestEpoch || String(this.properties.storeId || "") !== storeId) return;
        const customers = (result.customers || []).map(customer).filter((item) => item.customerCode && item.customerName && item.birthDate);
        this.setData({
          customers,
          customerLabels: customers.map((item) => `${item.customerName} · ${item.birthDate} · ${item.customerCode}`),
          message: result.hasMore ? "当前先显示 100 位客户；其他客户请使用姓名＋生日精确查询" : "",
          error: false
        });
      } catch (error) {
        if (requestEpoch === this._customerListRequestEpoch && String(this.properties.storeId || "") === storeId) {
          this.setData({ message: error.message || "客户读取失败", error: true });
        }
      } finally {
        if (requestEpoch === this._customerListRequestEpoch && String(this.properties.storeId || "") === storeId) {
          this._customerListStoreId = "";
          this.setData({ loading: false });
        }
      }
    },
    changeMode(event) {
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.setData({ mode: event.currentTarget.dataset.mode, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, selectedIndex: -1, message: "", error: false });
      this.triggerEvent("change", { customer: null });
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
    async selectCustomer(event) {
      const index = Number(event.detail.value);
      const selected = this.data.customers[index];
      this.setData({ selectedIndex: index });
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
