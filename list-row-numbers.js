(() => {
  "use strict";

  // Explicit result-list allowlist. Never loaded by business submission pages.
  const targets = {
    "index.html": ["rankingBody"],
    "customer-query.html": ["customerQueryBody"],
    "recharge-query.html": ["recordQueryBody"],
    "verification-query.html": ["recordQueryBody"],
    "store-detail.html": ["storeBusinessDetailBody", "storeActiveCustomerBody", "storeArchivedCustomerBody"],
    "teacher-work-orders.html": ["teacherOrdersBody", "teacherActiveCustomerBody", "teacherArchivedCustomerBody"],
    "recharge-review.html": ["reviewBody"],
    "refund-review.html": ["reviewBody"],
    "verification-review.html": ["reviewBody"],
    "product-purchase-review.html": ["purchaseReviewBody"],
    "store-management.html": ["searchStoreRows", "activeStoreRows", "archivedStoreRows"],
    "teacher-management.html": ["searchTeacherRows", "activeTeacherRows", "archivedTeacherRows"],
    "retail-product-management.html": ["retailProductBody"]
  };
  const route = location.pathname.split("/").pop();
  const ids = targets[route] || [];
  const operationResults = ["inactive-customers.html", "low-balance-customers.html", "rating-analysis.html"].includes(route)
    ? "#operationsResults table tbody" : "";
  const selectors = [...ids.map((id) => `#${id}`), operationResults].filter(Boolean).join(",");
  if (!selectors) return;
  const localPages = new Map();
  const localPagination = new Set(["store-management.html", "teacher-management.html", "retail-product-management.html"]);

  function localPage(body, rows) {
    if (!localPagination.has(route)) return rows;
    let state = localPages.get(body);
    if (!state) {
      state = { page: 1, first: null, nav: document.createElement("nav") };
      state.nav.className = "table-pagination list-pagination";
      state.nav.setAttribute("aria-label", "列表分页");
      localPages.set(body, state);
    }
    if (state.first !== rows[0]) { state.page = 1; state.first = rows[0]; }
    const pages = Math.max(1, Math.ceil(rows.length / 10));
    state.page = Math.min(state.page, pages);
    rows.forEach((row, index) => { row.dataset.listPageHidden = String(Math.floor(index / 10) !== state.page - 1); });
    state.nav.replaceChildren();
    const change = (value) => {
      const raw = String(value).trim();
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > pages) return;
      state.page = Number(raw); refresh();
    };
    const button = (label, value, disabled) => {
      const node = document.createElement("button");
      node.type = "button"; node.textContent = label; node.disabled = disabled;
      node.onclick = () => change(value);
      state.nav.append(node);
    };
    button("上一页", state.page - 1, state.page <= 1);
    const summary = document.createElement("span");
    summary.textContent = `第 ${state.page} / ${pages} 页 · 共 ${rows.length} 条`;
    state.nav.append(summary);
    button("下一页", state.page + 1, state.page >= pages);
    const label = document.createElement("label");
    label.className = "list-page-jump";
    label.append("跳至第 ");
    const input = document.createElement("input");
    input.type = "number"; input.min = "1"; input.max = String(pages); input.step = "1";
    input.value = String(state.page); input.setAttribute("aria-label", "跳转到第几页");
    input.onkeydown = (event) => { if (event.key === "Enter") change(input.value); };
    label.append(input, " 页"); state.nav.append(label);
    const jump = document.createElement("button");
    jump.type = "button"; jump.textContent = "跳转"; jump.onclick = () => change(input.value);
    state.nav.append(jump);
    (body.closest(".table-scroll, .teacher-directory-window, .store-directory-window") || body.closest("table")).after(state.nav);
    state.nav.hidden = !rows.length;
    return rows.filter((row) => row.dataset.listPageHidden === "false");
  }

  function cell(tag, text) {
    const node = document.createElement(tag);
    node.className = "list-row-number";
    node.textContent = text;
    if (tag === "th") node.scope = "col";
    else node.dataset.label = "序号";
    return node;
  }

  function refresh() {
    observer.disconnect();
    document.querySelectorAll(selectors).forEach((body) => {
      const table = body.closest("table");
      const head = table?.tHead?.rows[0];
      if (!head || !head.cells.length) return;
      table.classList.add("numbered-result-table");
      table.closest(".table-scroll, .operations-table-scroll, .teacher-directory-window, .store-directory-window")?.classList.add("numbered-list-scroll");
      if (!head.querySelector(".list-row-number")) head.prepend(cell("th", "序号"));
      const cols = table.querySelector("colgroup");
      if (cols && !cols.querySelector(".list-row-number")) {
        const col = document.createElement("col");
        col.className = "list-row-number";
        cols.prepend(col);
      }
      const records = [];
      Array.from(body.rows).forEach((row) => {
        const cells = Array.from(row.cells).filter((item) => !item.classList.contains("list-row-number"));
        // Loading, empty and error rows are not records and must span the new column.
        if (cells.length === 1 && !row.querySelector("a,button")) {
          cells[0].colSpan = head.cells.length;
          row.querySelector(".list-row-number")?.remove();
          return;
        }
        if (cells.length) records.push(row);
      });
      localPage(body, records).forEach((row, index) => {
        const existing = row.querySelector(".list-row-number");
        if (existing) existing.textContent = String(index + 1);
        else row.prepend(cell("td", String(index + 1)));
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const observer = new MutationObserver(refresh);
  refresh();
  window.ListRowNumbers = Object.freeze({ refresh });
})();
