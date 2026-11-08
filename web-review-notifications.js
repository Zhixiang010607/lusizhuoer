(() => {
  "use strict";
  const KEYS = ["purchase", "recharge", "refund", "verification"];
  const INTERVAL_MS = 30000;
  function decode(value) {
    const counts = {};
    for (const key of KEYS) {
      const n = Number(value?.counts?.[key]);
      if (!Number.isSafeInteger(n) || n < 0) throw Error("审核数量读取不完整");
      counts[key] = n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(total) || Number(value.total) !== total || !value.revision) throw Error("审核数量读取不完整");
    return { counts, total, revision: String(value.revision) };
  }
  // Web-native lifecycle; no Mini Program session or platform code is imported.
  function createController({ owner, visible, read, render, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let account = "", generation = 0, running = null, timer = null, forbidden = false, stopped = false;
    const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
    const valid = () => !stopped && Boolean(account) && owner() === account && visible();
    function refresh(force = false) {
      if (stopped) return Promise.resolve();
      const current = owner();
      if (current !== account) { account = current; generation++; forbidden = false; clear(); render(null); }
      if (!valid()) { clear(); return Promise.resolve(); }
      clear();
      if (force || !running) generation++;
      if (force) render(null);
      if (running) return running;
      const task = (async () => {
        while (valid()) {
          const requested = generation, expectedOwner = account;
          try {
            const result = decode(await read());
            if (requested !== generation || expectedOwner !== account) continue;
            if (valid()) { forbidden = false; render(result); }
            return;
          } catch (error) {
            if (requested !== generation || expectedOwner !== account) continue;
            if (!valid()) return;
            forbidden = ["FORBIDDEN", "UNAUTHENTICATED", "UNASSIGNED_IDENTITY", "ACCOUNT_ARCHIVED", "AUTH_SESSION_CHANGED"].includes(String(error?.code || ""));
            render(null, "待审核数量更新失败，点击重试");
            return;
          }
        }
      })();
      running = task;
      task.finally(() => {
        if (running === task) running = null;
        if (valid() && !forbidden) timer = setTimer(() => { timer = null; void refresh(); }, INTERVAL_MS);
      });
      return task;
    }
    function pause() { generation++; clear(); render(null); }
    function stop() { stopped = true; pause(); }
    return { refresh, pause, stop };
  }
  function start() {
    if (window.WebReviewNotifications.controller) return;
    function owner() {
      if (document.documentElement.dataset.authRedirecting === "true") return "";
      try { const s = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); return s?.role === "hq" ? String(s.cloudbaseUserId || s.account || "") : ""; } catch (_) { return ""; }
    }
    const controller = createController({
      owner, visible: () => document.visibilityState === "visible",
      read: () => window.CloudBasePhoneAuth.getPendingReviewCounts(),
      render: (data, error = "") => {
        document.querySelectorAll("[data-review-badge]").forEach((badge) => {
          const count = data ? Number(badge.dataset.reviewBadge === "total" ? data.total : data.counts[badge.dataset.reviewBadge]) : 0;
          badge.hidden = !error && count === 0;
          badge.textContent = error ? "!" : count > 99 ? "99+" : String(count);
          badge.title = error || `${count} 条待审核`;
          badge.setAttribute("aria-label", badge.title);
          badge.dataset.retry = error ? "true" : "false";
        });
      }
    });
    window.WebReviewNotifications.controller = controller;
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" ? controller.refresh(true) : controller.pause());
    window.addEventListener("focus", () => controller.refresh(true));
    window.addEventListener("pageshow", () => controller.refresh(true));
    window.addEventListener("pagehide", () => controller.pause());
    window.addEventListener("workspace-review-completed", () => controller.refresh(true));
    window.addEventListener("storage", (event) => { if (event.key === "lusizhuoerActiveAuth") controller.refresh(true); });
    document.addEventListener("click", (event) => {
      if (event.target.closest?.('[data-review-badge][data-retry="true"]')) void controller.refresh(true);
    });
    void controller.refresh(true);
  }
  window.WebReviewNotifications = { start, createController, decode };
})();
