(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const clean = (value) => String(value ?? "").trim();
  const statusText = { PENDING: "待审核", APPROVED: "审核通过", REJECTED: "已驳回" };
  let rows = [], stores = [], page = 1, totalPages = 1, pending = null, loading = false;
  function time(value) { return window.AppDateTime?.formatDate(value) || clean(value) || "—"; }
  function normalize(row) { return {
    id: clean(row.id), code: clean(row.purchase_code || row.purchaseCode), status: clean(row.record_status || row.recordStatus).toUpperCase(),
    storeId: clean(row.store_id || row.storeId), storeName: clean(row.store_name || row.storeName), customerCode: clean(row.customer_code || row.customerCode), customerName: clean(row.customer_name || row.customerName),
    productName: clean(row.product_name_snapshot || row.productNameSnapshot), count: Number(row.unit_count || row.unitCount || 0), teacherName: clean(row.teacher_name || row.teacherName) || "—",
    submittedAt: row.submitted_at || row.submittedAt, reviewedAt: row.reviewed_at || row.reviewedAt, message: clean(row.message) || "无"
  }; }
  function render() {
    $("purchaseReviewBody").innerHTML = rows.length ? rows.map((row) => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.storeName)}</td><td><a class="record-link" href="customer-detail.html?customerId=${encodeURIComponent(row.customerCode)}">${escapeHtml(row.customerName)}</a></td><td>${escapeHtml(row.productName)}</td><td>${row.count} 件</td><td>${escapeHtml(row.teacherName)}</td><td>${escapeHtml(time(row.submittedAt))}</td><td>${row.status === "PENDING" ? `<div class="review-actions"><button data-id="${row.id}" data-decision="APPROVED">通过</button><button class="reject" data-id="${row.id}" data-decision="REJECTED">驳回</button></div>` : escapeHtml(statusText[row.status] || row.status)}</td><td>${escapeHtml(row.reviewedAt ? time(row.reviewedAt) : "—")}</td></tr>`).join("") : `<tr><td colspan="9" class="query-empty">当前条件下没有产品购买审核记录</td></tr>`;
    $("purchaseReviewPage").textContent = `第 ${page} / ${totalPages} 页`; $("purchaseReviewPrev").disabled = page <= 1 || loading; $("purchaseReviewNext").disabled = page >= totalPages || loading;
    document.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", () => openDecision(button.dataset.id, button.dataset.decision)));
  }
  async function load(target = 1, reloadStores = false) {
    if (loading) return; loading = true; $("purchaseReviewBody").innerHTML = `<tr><td colspan="9" class="query-empty">正在读取…</td></tr>`;
    try {
      const result = await window.CloudBasePhoneAuth.listRetailProductPurchaseReviews({ purchaseCode: clean($("purchaseReviewCode").value).toUpperCase(), storeId: $("purchaseReviewStore").value, status: $("purchaseReviewStatus").value, limit: 100, pageNumber: target });
      rows = (result.orders || []).map(normalize); page = Number(result.pageNumber || 1); totalPages = Math.max(1, Number(result.totalPages || 1));
      if (reloadStores || $("purchaseReviewStore").options.length <= 1) { stores = result.stores || []; $("purchaseReviewStore").innerHTML = `<option value="">全部门店</option>${stores.map((store) => `<option value="${escapeHtml(store.store_id || store.id)}">${escapeHtml(store.store_name || store.name)}</option>`).join("")}`; }
      $("purchaseReviewMessage").textContent = `共 ${Number(result.total || 0)} 条`; render();
    } catch (error) { rows = []; $("purchaseReviewMessage").textContent = error.message || "读取失败"; render(); }
    finally { loading = false; render(); }
  }
  function openDecision(id, decision) { const row = rows.find((item) => item.id === id); if (!row) return; pending = { row, decision }; $("purchaseReviewDialogTitle").textContent = decision === "APPROVED" ? "确认通过" : "确认驳回"; $("purchaseReviewSummary").textContent = `${row.code} · ${row.customerName} · ${row.productName} · ${row.count} 件 · 申请留言：${row.message}`; $("purchaseReviewNote").value = ""; $("purchaseReviewDialog").showModal(); }
  function close() { pending = null; $("purchaseReviewDialog").close(); }
  async function decide() { if (!pending) return; const button = $("purchaseReviewConfirm"); button.disabled = true; try { await window.CloudBasePhoneAuth.reviewRetailProductPurchase({ recordId: pending.row.id, decision: pending.decision, note: $("purchaseReviewNote").value.trim() }); close(); await load(page); } catch (error) { alert(error.message || "审核失败"); } finally { button.disabled = false; } }
  $("purchaseReviewSearch").addEventListener("click", () => load(1)); $("purchaseReviewReset").addEventListener("click", () => { $("purchaseReviewStore").value = ""; $("purchaseReviewStatus").value = ""; $("purchaseReviewCode").value = ""; load(1); }); $("purchaseReviewPrev").addEventListener("click", () => page > 1 && load(page - 1)); $("purchaseReviewNext").addEventListener("click", () => page < totalPages && load(page + 1)); $("purchaseReviewClose").addEventListener("click", close); $("purchaseReviewCancel").addEventListener("click", close); $("purchaseReviewConfirm").addEventListener("click", decide); void load(1, true);
})();
