(() => {
  "use strict";

  const VERSION = "0.16.0";
  const $ = (id) => document.getElementById(id);
  const roles = {
    hq: { name: "总部", target: "index.html" },
    operation: { name: "运营", target: "local.html" },
    store: { name: "门店", target: "store-detail.html" },
    teacher: { name: "老师", target: "teacher-work-orders.html" }
  };
  let loginMode = "password";
  let activeSession = null;
  const bootstrapMode = new URLSearchParams(location.search).get("bootstrap") === "1";

  function setError(message = "") { $("loginError").textContent = message; }
  function setBusy(button, busy, normalText) {
    button.disabled = busy;
    button.textContent = busy ? "处理中…" : normalText;
  }
  function selectLoginMode(mode) {
    loginMode = mode;
    const password = mode === "password";
    $("passwordLoginMode").classList.toggle("active", password);
    $("smsLoginMode").classList.toggle("active", !password);
    $("passwordLoginMode").setAttribute("aria-selected", String(password));
    $("smsLoginMode").setAttribute("aria-selected", String(!password));
    $("passwordLoginField").hidden = !password;
    $("smsLoginField").hidden = password;
    setError();
  }
  function refreshSmsButton() {
    const button = $("sendSmsCode");
    if (!button || loginMode !== "sms") return;
    let remaining = 0;
    try { remaining = window.CloudBasePhoneAuth?.smsCooldownRemaining?.($("loginPhone").value) || 0; } catch (_) { remaining = 0; }
    button.disabled = remaining > 0;
    button.textContent = remaining > 0 ? `${remaining}秒后重发` : "获取验证码";
  }
  function createSession(identity, staff) {
    const profile = staff.profile;
    const session = {
      role: profile.role,
      phone: $("loginPhone").value.trim(),
      account: $("loginPhone").value.trim(),
      store: profile.storeId || "",
      staffName: profile.staffName || "",
      cloudbaseUserId: staff.uid || identity?.user?.id || identity?.user?.uid || "",
      loginAt: new Date().toISOString(),
      sessionId: `${Date.now()}-${Math.random().toString(36).slice(2)}`
    };
    ["prototypeSession", "prototypeRole", "prototypeAccount", "prototypeStore"].forEach((key) => sessionStorage.removeItem(key));
    sessionStorage.setItem("prototypeSession", JSON.stringify(session));
    sessionStorage.setItem("prototypeRole", session.role);
    sessionStorage.setItem("prototypeAccount", session.account);
    sessionStorage.setItem("prototypeStore", session.store);
    return session;
  }

  function enterWorkspace(session) {
    const target = roles[session?.role]?.target || "login.html";
    const suffix = session?.role === "store" && session.store ? `?storeId=${encodeURIComponent(session.store)}` : "";
    window.location.replace(target + suffix);
  }

  $("passwordLoginMode").addEventListener("click", () => selectLoginMode("password"));
  $("smsLoginMode").addEventListener("click", () => { selectLoginMode("sms"); refreshSmsButton(); });
  $("loginPhone").addEventListener("input", refreshSmsButton);
  $("togglePassword").addEventListener("click", () => {
    const visible = $("loginPassword").type === "text";
    $("loginPassword").type = visible ? "password" : "text";
    $("togglePassword").textContent = visible ? "显示" : "隐藏";
  });
  $("forgotPassword").addEventListener("click", (event) => {
    event.preventDefault();
    window.alert("请联系总部管理员重置密码。正式版将要求手机号短信验证后才能修改密码，并留下操作记录。");
  });
  $("sendSmsCode").addEventListener("click", async () => {
    const button = $("sendSmsCode");
    try {
      setError(); setBusy(button, true, "获取验证码");
      await window.CloudBasePhoneAuth.sendCode($("loginPhone").value);
      setError("验证码已发送。60 秒内不可重发；请尽快完成登录。");
      refreshSmsButton();
    } catch (error) {
      setError(error.message || "验证码发送失败，请稍后重试");
    } finally { setBusy(button, false, "获取验证码"); }
  });
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const phone = $("loginPhone").value.trim();
    const password = $("loginPassword").value;
    const code = $("loginSmsCode").value;
    const submit = event.currentTarget.querySelector('[type="submit"]');
    if (!phone) return setError("请输入中国大陆手机号");
    if (loginMode === "password" && !password) return setError("请输入登录密码");
    if (loginMode === "sms" && !code) return setError("请输入短信验证码");
    try {
      setError(); setBusy(submit, true, "登录系统");
      const identity = loginMode === "password"
        ? await window.CloudBasePhoneAuth.signInWithPassword(phone, password)
        : await window.CloudBasePhoneAuth.signInWithCode(code);
      if (bootstrapMode) await window.CloudBasePhoneAuth.bootstrapHq();
      const staff = await window.CloudBasePhoneAuth.getStaffSession();
      activeSession = createSession(identity, staff);
      enterWorkspace(activeSession);
    } catch (error) {
      setError(error.message || "登录失败，请检查手机号、密码或验证码");
    } finally { setBusy(submit, false, "登录系统"); }
  });
  document.documentElement.dataset.prototypeVersion = VERSION;
  selectLoginMode("password");
  window.setInterval(refreshSmsButton, 1000);
})();
