(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  const key = String(params.get("submissionIntentKey") || "");
  const clientRequestId = String(params.get("clientRequestId") || "");
  if (!/^lusizhuoer:business-submission:v1:fp_[0-9a-f]{16}$/.test(key)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(clientRequestId)) return;
  try {
    const intent = JSON.parse(localStorage.getItem(key) || "null");
    if (!intent || intent.clientRequestId !== clientRequestId || intent.state !== "CONFIRMED") return;
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw new Error("submission intent acknowledgement failed");
  } catch (error) {
    console.warn("Business submission acknowledgement was not persisted; the create page will remain safely locked.", error);
  }
})();
