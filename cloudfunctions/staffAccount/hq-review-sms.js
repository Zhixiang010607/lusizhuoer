"use strict";

// Preparation only: no SMS SDK, credentials, message send or business hooks.
exports.createHqReviewSms = ({ executeSql, requireHq, numericId, sqlText, fail }) => ({
  async run(caller, event, write = false) {
    requireHq(caller);
    const id = numericId(event.staffAccountId, "总部人员");
    const keys = ["purchase", "recharge", "refund", "verification"];
    const categories = event.categories === undefined && typeof event.enabled === "boolean"
      ? Object.fromEntries(keys.map(key => [key, event.enabled])) : event.categories;
    if (write && (!categories || Array.isArray(categories) || Object.keys(categories).length !== 4 || keys.some(key => typeof categories[key] !== "boolean"))) fail("接收状态无效", "BAD_REQUEST");
    const fn = write ? "set_hq_review_sms_categories_v95" : "get_hq_review_sms_preference_v94";
    let rows;
    try {
      rows = await executeSql(`SELECT public.${fn}(${sqlText(caller.uid)},${id}${write ? `,${keys.map(key => categories[key] ? "TRUE" : "FALSE").join(",")}` : ""}) AS preference`);
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("SMS_ONLY_ACTIVE_HQ")) fail("仅在职总部账号可以修改短信设置", "FORBIDDEN");
      if (message.includes("SMS_HQ_NOT_FOUND")) fail("未找到总部人员", "NOT_FOUND");
      if (message.includes("SMS_HQ_ARCHIVED")) fail("封存人员不能开启短信接收", "BAD_REQUEST");
      throw error;
    }
    let preference = rows?.[0]?.preference;
    if (typeof preference === "string") preference = JSON.parse(preference);
    if (!preference || String(preference.staffAccountId) !== String(id) || typeof preference.enabled !== "boolean") {
      fail(write ? "保存结果未确认，请重新读取设置核对" : "短信设置读取失败，请重试", "SMS_PREFERENCE_UNCONFIRMED");
    }
    return { ...preference, deliveryReady: false };
  }
});
