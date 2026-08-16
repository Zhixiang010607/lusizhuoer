(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let status = "pending";

  function renderStatus() {
    const approved = status === "approved";
    const rejected = status === "rejected";
    const text = approved ? "已通过" : rejected ? "已驳回" : "待审核";
    const hint = approved ? "已写入审核轨迹（演示）" : rejected ? "申请已退回发起方（演示）" : "等待总部审核决定";
    const statusNode = $("demoRechargeStatus");
    statusNode.textContent = text;
    statusNode.className = approved ? "approved" : rejected ? "rejected" : "pending";
    $("demoRechargeStatusHint").textContent = hint;
    $("demoApproveRecharge").disabled = status !== "pending";
    $("demoRejectRecharge").disabled = status !== "pending";
  }

  function decide(nextStatus) {
    if (status !== "pending") return;
    status = nextStatus;
    renderStatus();
  }

  $("demoApproveRecharge").addEventListener("click", () => decide("approved"));
  $("demoRejectRecharge").addEventListener("click", () => decide("rejected"));
  renderStatus();
})();
