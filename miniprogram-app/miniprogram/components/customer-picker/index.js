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
    storeId: { type: String, value: "", observer() { this.scheduleReload(); } }
  },
  data: {
    mode: "select", customers: [], customerLabels: ["请选择现有客户"], customerPickerIndex: 0,
    selectedCustomerCode: "", listLoading: false, listMessage: "", listError: false,
    manualName: "", manualBirthday: "", today: businessToday(), duplicateMatches: [], candidate: null,
    photoUrl: "", photoReady: false, photoLoading: false, loading: false, message: "", error: false
  },
  lifetimes: {
    attached() {
      this._detached = false;
      this.setData({ today: businessToday() });
      this.scheduleReload();
    },
    detached() {
      this._detached = true;
      this._customerListPromise = null;
      this._customerListStoreId = "";
      this._customerListRequestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
    }
  },
  methods: {
    scheduleReload() {
      if (this._reloadScheduled || this._detached) return;
      this._reloadScheduled = true;
      Promise.resolve().then(() => {
        this._reloadScheduled = false;
        if (!this._detached) this.reload();
      });
    },
    resetPhotoRetry() {
      this._photoRetryCustomerCode = "";
      this._photoRetryCount = 0;
    },
    async reload() {
      const storeId = String(this.properties.storeId || "");
      if (storeId && this.data.mode === "select" && this._customerListPromise && this._customerListStoreId === storeId) {
        return this._customerListPromise;
      }
      const requestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._customerListRequestEpoch = requestEpoch;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.resetPhotoRetry();
      const reset = {
        loading: false, listLoading: false, listMessage: "", listError: false,
        customers: [], customerLabels: ["请选择现有客户"], customerPickerIndex: 0, selectedCustomerCode: "",
        duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false,
        manualName: "", manualBirthday: "", message: "", error: false
      };
      if (!storeId) {
        this._customerListPromise = null;
        this._customerListStoreId = "";
        this.setData(reset);
        this.triggerEvent("change", { customer: null });
        return;
      }
      this._customerListStoreId = storeId;
      this.setData(reset);
      this.triggerEvent("change", { customer: null });
      if (this.data.mode !== "select") return;
      const promise = this.loadAllCustomers({ storeId, requestEpoch });
      this._customerListPromise = promise;
      try {
        return await promise;
      } finally {
        if (this._customerListPromise === promise) {
          this._customerListPromise = null;
          this._customerListStoreId = "";
        }
      }
    },
    async loadAllCustomers(request) {
      const storeId = String(request.storeId || "");
      const requestEpoch = Number(request.requestEpoch || 0);
      if (!storeId) return;
      const seenCursors = new Set();
      let cursor = null;
      let customers = [];
      this.setData({ listLoading: true, listMessage: "正在读取本门店全部活跃客户…", listError: false });
      try {
        while (true) {
          const payload = { storeId, limit: 100 };
          if (cursor) payload.cursor = { ...cursor };
          const result = await callFace("listActiveStoreCustomers", payload);
          if (!this.isCurrentListRequest({ storeId, requestEpoch })) return;
          customers = mergeCustomers(customers, result.customers || []);
          const selectedCustomerCode = String(this.data.selectedCustomerCode || "");
          const selectedIndex = customers.findIndex((item) => item.customerCode === selectedCustomerCode);
          this.setData({
            customers,
            customerLabels: [
              customers.length ? `请选择现有客户（已读取 ${customers.length} 位）` : "本门店暂无活跃客户",
              ...customers.map((item) => `${item.customerName} · ${item.birthDate}`)
            ],
            customerPickerIndex: selectedIndex >= 0 ? selectedIndex + 1 : 0,
            selectedCustomerCode: selectedIndex >= 0 ? selectedCustomerCode : "",
            listMessage: result.hasMore === true
              ? `已读取 ${customers.length} 位客户，可立即选择；其余客户仍在后台读取…`
              : "",
            listError: false
          });
          if (result.hasMore !== true) break;
          const nextCursor = customerCursor(result.nextCursor);
          const nextCursorKey = cursorKey(nextCursor);
          if (!nextCursorKey || nextCursorKey === cursorKey(cursor) || seenCursors.has(nextCursorKey)) {
            throw new Error("客户分页信息无效，无法确认已读取全部客户，请重新进入页面后重试");
          }
          seenCursors.add(nextCursorKey);
          cursor = nextCursor;
        }
        if (!this.isCurrentListRequest({ storeId, requestEpoch })) return;
        const selectedCustomerCode = String(this.data.selectedCustomerCode || "");
        const selectedIndex = customers.findIndex((item) => item.customerCode === selectedCustomerCode);
        this.setData({
          customers,
          customerLabels: [
            customers.length ? `请选择现有客户（共 ${customers.length} 位）` : "本门店暂无活跃客户",
            ...customers.map((item) => `${item.customerName} · ${item.birthDate}`)
          ],
          customerPickerIndex: selectedIndex >= 0 ? selectedIndex + 1 : 0,
          selectedCustomerCode: selectedIndex >= 0 ? selectedCustomerCode : "",
          listMessage: "",
          listError: false
        });
      } catch (error) {
        if (this.isCurrentListRequest({ storeId, requestEpoch })) {
          const selectedCustomerCode = String(this.data.selectedCustomerCode || "");
          const selectedIndex = customers.findIndex((item) => item.customerCode === selectedCustomerCode);
          this.setData({
            customers,
            customerLabels: customers.length
              ? [
                `请选择现有客户（已读取 ${customers.length} 位）`,
                ...customers.map((item) => `${item.customerName} · ${item.birthDate}`)
              ]
              : ["客户数据读取失败"],
            customerPickerIndex: selectedIndex >= 0 ? selectedIndex + 1 : 0,
            selectedCustomerCode: selectedIndex >= 0 ? selectedCustomerCode : "",
            listMessage: customers.length
              ? `后续客户读取失败；已读取的 ${customers.length} 位仍可选择，也可重新读取客户列表`
              : (error.message || "客户列表读取失败，请重新读取或改用姓名／生日查询"),
            listError: true
          });
        }
      } finally {
        if (this.isCurrentListRequest({ storeId, requestEpoch })) {
          this.setData({ listLoading: false });
        }
      }
    },
    isCurrentListRequest(request) {
      return Number(request.requestEpoch || 0) === this._customerListRequestEpoch
        && String(this.properties.storeId || "") === String(request.storeId || "")
        && this.data.mode === "select";
    },
    changeMode(event) {
      const mode = String(event.currentTarget.dataset.mode || "");
      if (!['select', 'manual'].includes(mode) || mode === this.data.mode) return;
      this._customerListRequestEpoch = (this._customerListRequestEpoch || 0) + 1;
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this._customerListPromise = null;
      this._customerListStoreId = "";
      this.resetPhotoRetry();
      this.setData({
        mode, customers: [], customerLabels: ["请选择现有客户"], customerPickerIndex: 0, selectedCustomerCode: "",
        listLoading: false, listMessage: "", listError: false, loading: false,
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
      this.resetPhotoRetry();
      this.setData({ manualName: event.detail.value, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false });
      this.triggerEvent("change", { customer: null });
    },
    inputBirthday(event) {
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.resetPhotoRetry();
      this.setData({ manualBirthday: event.detail.value, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false });
      this.triggerEvent("change", { customer: null });
    },
    clearBirthday() {
      this._manualSearchRequestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.resetPhotoRetry();
      this.setData({ manualBirthday: "", duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false });
      this.triggerEvent("change", { customer: null });
    },
    async selectListedCustomer(event) {
      const pickerIndex = Math.max(0, Number(event.detail.value) || 0);
      const selected = this.data.customers[pickerIndex - 1] || null;
      this.resetPhotoRetry();
      this.setData({ customerPickerIndex: selected ? pickerIndex : 0, selectedCustomerCode: selected ? selected.customerCode : "" });
      if (selected) await this.loadCandidate(selected);
      else {
        this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
        this.setData({ duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "", error: false });
        this.triggerEvent("change", { customer: null });
      }
    },
    async manualSearch() {
      const name = String(this.data.manualName || "").trim();
      const birthDate = this.data.manualBirthday;
      if (!name && !birthDate) return this.setData({ message: "姓名或生日请至少填写一项", error: true });
      const storeId = String(this.properties.storeId || "");
      const requestEpoch = (this._manualSearchRequestEpoch || 0) + 1;
      this._manualSearchRequestEpoch = requestEpoch;
      this._candidateRequestEpoch = (this._candidateRequestEpoch || 0) + 1;
      this.resetPhotoRetry();
      this.setData({ loading: true, duplicateMatches: [], candidate: null, photoUrl: "", photoReady: false, photoLoading: false, message: "正在查询…", error: false });
      this.triggerEvent("change", { customer: null });
      try {
        const seenCursors = new Set();
        let cursor = null;
        let matches = [];
        while (true) {
          const payload = { storeId, limit: 100 };
          if (name) payload.customerName = name;
          if (birthDate) payload.birthDate = birthDate;
          if (cursor) payload.cursor = { ...cursor };
          const result = await callFace("listActiveStoreCustomers", payload);
          if (requestEpoch !== this._manualSearchRequestEpoch || String(this.properties.storeId || "") !== storeId) return;
          matches = mergeCustomers(matches, result.customers || []);
          if (result.hasMore !== true) break;
          const nextCursor = customerCursor(result.nextCursor);
          const nextCursorKey = cursorKey(nextCursor);
          if (!nextCursorKey || nextCursorKey === cursorKey(cursor) || seenCursors.has(nextCursorKey)) {
            throw new Error("客户查询分页信息无效，请重新查询");
          }
          seenCursors.add(nextCursorKey);
          cursor = nextCursor;
          this.setData({ message: `正在查询（已找到 ${matches.length} 位）…` });
        }
        if (!matches.length) throw new Error("未找到当前门店的活跃客户");
        if (matches.length > 1) {
          this.setData({ duplicateMatches: matches, message: `找到 ${matches.length} 位匹配客户，请按姓名和生日选择`, error: false });
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
      this.resetPhotoRetry();
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
      this.resetPhotoRetry();
      this.setData({ photoReady: true, message: "照片已加载，请核对后确认", error: false });
    },
    photoFailed(event) {
      const data = event.currentTarget.dataset || {};
      if (String(data.customerCode || "") !== String(this.data.candidate?.customerCode || "") || String(data.photoUrl || "") !== String(this.data.photoUrl || "")) return;
      const customerCode = String(this.data.candidate?.customerCode || "");
      if (this._photoRetryCustomerCode !== customerCode) {
        this._photoRetryCustomerCode = customerCode;
        this._photoRetryCount = 0;
      }
      if (this._photoRetryCount < 1 && this.data.candidate && !this.data.photoLoading) {
        this._photoRetryCount += 1;
        this.setData({ photoReady: false, message: "照片临时地址已失效，正在自动重读…", error: false });
        return this.loadCandidate(this.data.candidate);
      }
      this.setData({ photoReady: false, message: "客户照片加载失败，禁止继续办理；请点重读照片", error: true });
      return undefined;
    },
    retryPhoto() {
      if (this.data.candidate && !this.data.loading && !this.data.photoLoading) {
        this.resetPhotoRetry();
        return this.loadCandidate(this.data.candidate);
      }
      return undefined;
    },
    confirm() {
      if (!this.data.candidate || !this.data.photoReady) return;
      this.triggerEvent("confirm", { customer: { ...this.data.candidate }, photoUrl: this.data.photoUrl });
      this.setData({ message: `已确认 ${this.data.candidate.customerName}`, error: false });
    }
  }
});
