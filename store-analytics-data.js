(() => {
  "use strict";

  let app = null;

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function payload(result) {
    return [result?.result, result?.data?.result, result?.data, result]
      .map(parsedObject)
      .find((candidate) => candidate && (Object.prototype.hasOwnProperty.call(candidate, "ok") || Object.prototype.hasOwnProperty.call(candidate, "code"))) || {};
  }

  function register(registerFn, componentName) {
    if (typeof registerFn !== "function") return;
    try { registerFn(window.cloudbase); }
    catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      if (!(detail.includes("duplicate component") && detail.includes(componentName))) throw error;
    }
  }

  function businessToday() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function addDays(dateText, delta) {
    const date = new Date(`${dateText}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
  }

  function periodRange(period) {
    const today = businessToday();
    if (period === "today") return { startDate: today, endDate: today };
    if (period === "last7") return { startDate: addDays(today, -6), endDate: today };
    if (period === "month") return { startDate: `${today.slice(0, 8)}01`, endDate: today };
    return null;
  }

  async function load({ storeId = "", startDate = "", endDate = "" } = {}) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("门店统计数据库组件尚未加载，请刷新页面后重试。");
    }
    register(window.registerAuth, "auth");
    register(window.registerFunctions, "functions");
    app ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    const request = { action: "getStoreBusinessAnalytics", startDate, endDate };
    if (storeId) request.storeId = String(storeId);
    const raw = await app.callFunction({ name: "faceRecognition", data: request });
    const data = payload(raw);
    if (!data.ok || !data.store || !data.dimensions) throw new Error(data.message || "门店统计接口没有返回有效数据。");
    return data;
  }

  window.StoreAnalyticsData = Object.freeze({ load, businessToday, periodRange });
})();
