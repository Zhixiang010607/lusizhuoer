(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const isLocalPreview = ["127.0.0.1", "localhost"].includes(location.hostname);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }

  function operationCode(profile = {}) {
    if (profile.staffCode) return String(profile.staffCode);
    const id = profile.staffId;
    return id === null || id === undefined || id === "" ? "—" : `OP${String(id).padStart(3, "0")}`;
  }

  function setText(id, value, fallback = "—") {
    const node = $(id);
    if (node) node.textContent = value === null || value === undefined || value === "" ? fallback : String(value);
  }

  function setStatus(message, error = false) {
    const node = $("operationProfileStatus");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("error", error);
  }

  function renderProfile({ profile, phone, status, loginAt }) {
    const current = profile || {};
    setText("operationStaffCode", operationCode(current));
    setText("operationStaffName", current.staffName);
    setText("operationPhone", phone);
    setText("operationRole", "运营");
    setText("operationAccountStatus", status);
    setText("operationLoginAt", window.AppDateTime?.format(loginAt, "—") || "—");
  }

  function constrainOperationNavigation() {
    document.querySelectorAll(".side-project-bar > .side-menu-group").forEach((group) => {
      if (group.dataset.menu !== "review") group.remove();
    });
    const homeLink = document.querySelector(".side-project-bar > .side-nav a");
    if (homeLink) {
      homeLink.classList.add("active");
      homeLink.href = "local.html";
      const icon = homeLink.querySelector(".nav-icon");
      const label = homeLink.querySelector("span:last-child");
      if (icon) icon.textContent = "全";
      if (label) label.textContent = "全局视图";
    }
    const reviewMenu = document.querySelector('[data-menu="review"]');
    if (reviewMenu) {
      reviewMenu.hidden = false;
      reviewMenu.open = true;
    }
  }

  async function loadProfile() {
    constrainOperationNavigation();
    if (!session || session.role !== "operation") {
      setStatus("当前登录信息不完整，请重新登录。", true);
      return;
    }

    if (isLocalPreview) {
      renderProfile({
        profile: session,
        phone: session.phone || session.account,
        status: "本地演示",
        loginAt: session.loginAt
      });
      setStatus("已显示当前登录的本地运营演示账号。");
      return;
    }

    if (typeof window.CloudBasePhoneAuth?.validateWorkspaceSession !== "function") {
      setStatus("云端身份服务未加载，请刷新后重试。", true);
      return;
    }

    try {
      const data = await window.CloudBasePhoneAuth.validateWorkspaceSession(session);
      const profile = data?.profile || {};
      renderProfile({
        profile,
        phone: profile.phone || session.phone || session.account,
        status: profile.accountStatus === "ACTIVE" ? "活跃" : profile.accountStatus || "—",
        loginAt: session.loginAt
      });
      setStatus("已从数据库读取并核对当前运营账号的本人资料。");
    } catch (error) {
      renderProfile({ profile: {}, phone: session.phone || session.account, status: "读取失败", loginAt: session.loginAt });
      setStatus(error?.message || "运营账号资料读取失败，请刷新后重试。", true);
    }
  }

  void loadProfile();
})();
