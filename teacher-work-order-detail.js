(() => {
  "use strict";
  const VERSION = "0.15.1";
  const params = new URLSearchParams(location.search);
  const type = String(params.get("type") || "").trim().toLowerCase();
  const recordId = String(params.get("recordId") || "").trim();
  const recordCode = String(params.get("recordCode") || "").trim();
  if (!["recharge", "verification"].includes(type) || !/^\d+$/.test(recordId)) {
    location.replace("teacher-work-orders.html");
    return;
  }
  const target = new URLSearchParams({ recordId, source: "teacher" });
  if (recordCode) target.set("recordCode", recordCode);
  location.replace(`${type}-detail.html?${target.toString()}`);
  document.documentElement.dataset.prototypeVersion = VERSION;
})();
