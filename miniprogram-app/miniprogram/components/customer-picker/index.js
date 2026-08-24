const { callFace } = require("../../services/api");

function today() { return new Date().toISOString().slice(0, 10); }
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
    manualName: "", manualBirthday: "", today: today(), candidate: null,
    photoUrl: "", photoReady: false, loading: false, message: "", error: false
  },
  lifetimes: { attached() { this.reload(); } },
  methods: {
    async reload() {
      if (!this.properties.storeId || this.data.loading) return;
      this.setData({ loading: true, customers: [], customerLabels: [], selectedIndex: -1, candidate: null, photoUrl: "", photoReady: false, message: "" });
      try {
        const result = await callFace("listActiveStoreCustomers", { storeId: this.properties.storeId, limit: 100 });
        const customers = (result.customers || []).map(customer).filter((item) => item.customerCode && item.customerName && item.birthDate);
        this.setData({
          customers,
          customerLabels: customers.map((item) => `${item.customerName} · ${item.birthDate}`),
          message: result.hasMore ? "当前先显示 100 位客户；其他客户请使用姓名＋生日精确查询" : "",
          error: false
        });
      } catch (error) {
        this.setData({ message: error.message || "客户读取失败", error: true });
      } finally { this.setData({ loading: false }); }
    },
    changeMode(event) {
      this.setData({ mode: event.currentTarget.dataset.mode, candidate: null, photoUrl: "", photoReady: false, selectedIndex: -1, message: "", error: false });
      this.triggerEvent("change", { customer: null });
    },
    inputName(event) { this.setData({ manualName: event.detail.value }); },
    inputBirthday(event) { this.setData({ manualBirthday: event.detail.value }); },
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
      this.setData({ loading: true, candidate: null, photoReady: false, message: "正在查询…", error: false });
      try {
        const result = await callFace("listActiveStoreCustomers", { storeId: this.properties.storeId, customerName: name, birthDate, limit: 100 });
        const matches = (result.customers || []).map(customer);
        if (matches.length !== 1) throw new Error(matches.length ? `找到 ${matches.length} 位同名同生日客户，请改用现有客户列表按编号确认` : "未找到当前门店的活跃客户");
        await this.loadCandidate(matches[0]);
      } catch (error) { this.setData({ message: error.message || "查询失败", error: true }); }
      finally { this.setData({ loading: false }); }
    },
    async loadCandidate(selected) {
      this.setData({ candidate: selected, photoUrl: "", photoReady: false, message: "正在读取客户照片…", error: false });
      this.triggerEvent("change", { customer: null });
      try {
        const result = await callFace("getActiveStoreCustomerDetail", { storeId: this.properties.storeId, customerCode: selected.customerCode });
        const detail = customer(result.customer || selected);
        if (detail.customerCode !== selected.customerCode || !/^https:\/\//i.test(String(result.photoUrl || ""))) throw new Error("客户详情或照片临时地址无效");
        this.setData({ candidate: detail, photoUrl: result.photoUrl, message: "请核对照片与现场客户", error: false });
      } catch (error) { this.setData({ candidate: null, photoUrl: "", message: error.message || "客户照片读取失败", error: true }); }
    },
    photoLoaded() { this.setData({ photoReady: true, message: "照片已加载，请核对后确认", error: false }); },
    photoFailed() { this.setData({ photoReady: false, message: "客户照片加载失败，禁止继续办理", error: true }); },
    retryPhoto() { if (this.data.candidate && !this.data.loading) this.loadCandidate(this.data.candidate); },
    confirm() {
      if (!this.data.candidate || !this.data.photoReady) return;
      this.triggerEvent("confirm", { customer: { ...this.data.candidate }, photoUrl: this.data.photoUrl });
      this.setData({ message: `已确认 ${this.data.candidate.customerName}`, error: false });
    }
  }
});
