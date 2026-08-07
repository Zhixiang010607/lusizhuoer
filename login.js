(() => {
  "use strict";
  const VERSION = "0.14.19", $ = (id) => document.getElementById(id);
  const roles = {
    store: { name: "门店", placeholder: "请输入门店登录账号", hint: "门店账号 STORE001 / 密码任意填写", target: "store-detail.html" },
    hq: { name: "总部", placeholder: "请输入总部登录账号", hint: "总部账号 HQ001 / 密码任意填写", target: "index.html" },
    operation: { name: "运营", placeholder: "请输入运营登录账号", hint: "运营账号 OP001 / 密码任意填写", target: "local.html" }
  };
  let activeRole = "hq";
  $("loginStore").innerHTML += Array.from({ length: 16 }, (_, i) => `<option value="S${String(i + 1).padStart(3, "0")}">${["悉尼", "墨尔本", "布里斯班", "珀斯"][i % 4]}门店 ${i + 1}（S${String(i + 1).padStart(3, "0")}）</option>`).join("");
  function selectRole(role) {
    activeRole = role;
    document.querySelectorAll("[data-role]").forEach((button) => { const selected = button.dataset.role === role; button.classList.toggle("active", selected); button.setAttribute("aria-selected", String(selected)); });
    $("storeField").hidden = role !== "store"; $("loginAccount").placeholder = roles[role].placeholder; $("demoHint").textContent = roles[role].hint; $("loginError").textContent = "";
  }
  document.querySelectorAll("[data-role]").forEach((button) => button.addEventListener("click", () => selectRole(button.dataset.role)));
  $("togglePassword").addEventListener("click", () => { const visible = $("loginPassword").type === "text"; $("loginPassword").type = visible ? "password" : "text"; $("togglePassword").textContent = visible ? "显示" : "隐藏"; });
  $("forgotPassword").addEventListener("click", (event) => { event.preventDefault(); window.alert("正式系统将由管理员执行密码重置；静态原型不发送验证码。"); });
  $("loginForm").addEventListener("submit", (event) => {
    event.preventDefault(); const account = $("loginAccount").value.trim(), password = $("loginPassword").value;
    if (activeRole === "store" && !$("loginStore").value) { $("loginError").textContent = "请选择所属门店"; return; }
    if (!account || !password) { $("loginError").textContent = "请输入登录账号和密码"; return; }
    $("loginError").textContent = "";
    try {
      const store = activeRole === "store" ? $("loginStore").value : "";
      ["prototypeSession", "prototypeRole", "prototypeAccount", "prototypeStore"].forEach((key) => sessionStorage.removeItem(key));
      const session = { role: activeRole, account, store, loginAt: new Date().toISOString(), sessionId: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
      sessionStorage.setItem("prototypeSession", JSON.stringify(session));
      sessionStorage.setItem("prototypeRole", activeRole); sessionStorage.setItem("prototypeAccount", account); sessionStorage.setItem("prototypeStore", store);
    } catch (_) { $("loginError").textContent = "当前浏览器禁止创建会话，请允许本地会话存储后重试"; return; }
    $("successMessage").textContent = `${roles[activeRole].name}身份验证通过。正式部署后将由后端签发安全会话并按角色加载菜单。`; $("loginSuccess").showModal();
  });
  $("enterDemo").addEventListener("click", () => {
    const suffix = activeRole === "store" ? `?storeId=${encodeURIComponent($("loginStore").value)}` : "";
    window.location.href = roles[activeRole].target + suffix;
  });
  document.documentElement.dataset.prototypeVersion = VERSION; selectRole("hq");
})();
