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
  const localDemoAccounts = {
    "13900000001": { password: "Demo@HQ2026", role: "hq", staffName: "本地总部演示", uid: "local-demo-hq" },
    "13900000002": { password: "Demo@OP2026", role: "operation", staffName: "本地运营演示", uid: "local-demo-operation" },
    "13900000003": { password: "Demo@ST2026", role: "store", storeId: "S001", staffName: "本地门店演示", uid: "local-demo-store" },
    "13900000004": { password: "Demo@TC2026", role: "teacher", staffName: "本地老师演示", uid: "local-demo-teacher" }
  };
  const isLocalPreview = ["127.0.0.1", "localhost"].includes(location.hostname);
  let loginMode = "password";
  let activeSession = null;
  let passwordResetCodeSent = false;
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
  function setResetError(message = "") { $("passwordResetMessage").textContent = message; }
  function showPasswordReset(show) {
    $("loginForm").hidden = show;
    $("passwordResetForm").hidden = !show;
    setError();
    setResetError();
    if (show) $("resetPhone").focus();
  }
  function validPassword(value) {
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(value)).length;
    return value.length >= 8 && value.length <= 32 && groups >= 3;
  }
  function refreshResetSmsButton() {
    const button = $("sendResetSms");
    let remaining = 0;
    try { remaining = window.CloudBasePhoneAuth?.smsCooldownRemaining?.($("resetPhone").value) || 0; } catch (_) { remaining = 0; }
    button.disabled = remaining > 0;
    button.textContent = remaining > 0 ? `${remaining}秒后重发` : "获取验证码";
  }
  function createSession(identity, staff) {
    const profile = staff.profile;
    const staffCodePrefix = profile.role === "hq" ? "HQ" : profile.role === "operation" ? "OP" : profile.role === "teacher" ? "TCH" : "S";
    const session = {
      role: profile.role,
      phone: $("loginPhone").value.trim(),
      account: $("loginPhone").value.trim(),
      store: profile.storeId || "",
      staffName: profile.staffName || "",
      staffId: profile.staffId || "",
      staffCode: profile.staffCode || (profile.staffId ? `${staffCodePrefix}${String(profile.staffId).padStart(3, "0")}` : ""),
      passwordChangeRequired: Boolean(profile.passwordChangeRequired),
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
    showPasswordReset(true);
  });
  $("backToLogin").addEventListener("click", (event) => { event.preventDefault(); showPasswordReset(false); });
  $("resetPhone").addEventListener("input", refreshResetSmsButton);
  $("sendResetSms").addEventListener("click", async () => {
    if (isLocalPreview) return setResetError("本地演示账号不发送真实短信，请使用正式 CloudBase 网站测试。");
    const button = $("sendResetSms");
    try {
      setResetError(); setBusy(button, true, "获取验证码");
      await window.CloudBasePhoneAuth.sendCode($("resetPhone").value);
      passwordResetCodeSent = true;
      setResetError("验证码已发送。60 秒内不能重复发送，请尽快完成修改。");
    } catch (error) {
      setResetError(error?.message || "验证码发送失败，请稍后重试。");
    } finally { refreshResetSmsButton(); }
  });
  $("passwordResetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("resetSmsCode").value.trim();
    const password = $("resetNewPassword").value;
    const confirmation = $("resetConfirmPassword").value;
    if (isLocalPreview) return setResetError("本地演示不能修改真实 CloudBase 密码。");
    if (!passwordResetCodeSent) return setResetError("请先获取短信验证码。");
    if (!code) return setResetError("请输入短信验证码。");
    if (!validPassword(password)) return setResetError("新密码需为 8–32 位，且至少包含三类字符。");
    if (password !== confirmation) return setResetError("两次输入的新密码不一致。");
    const button = event.currentTarget.querySelector('[type="submit"]');
    try {
      setResetError(); setBusy(button, true, "验证并修改密码");
      await window.CloudBasePhoneAuth.signInWithCode(code);
      await window.CloudBasePhoneAuth.changeOwnPassword(password);
      event.currentTarget.reset();
      passwordResetCodeSent = false;
      window.setTimeout(() => { showPasswordReset(false); setError("密码已修改，请使用新密码登录。"); }, 700);
    } catch (error) {
      setResetError(error?.message || "密码修改失败，请检查验证码或联系总部。");
    } finally { setBusy(button, false, "验证并修改密码"); }
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
    const localDemo = isLocalPreview ? localDemoAccounts[phone] : null;
    if (localDemo) {
      if (loginMode !== "password") return setError("本地演示账号请使用密码登录");
      if (password !== localDemo.password) return setError("本地演示账号密码不正确");
      activeSession = createSession({ user: { id: localDemo.uid } }, { uid: localDemo.uid, profile: localDemo });
      enterWorkspace(activeSession);
      return;
    }
    try {
      setError(); setBusy(submit, true, "登录系统");
      const identity = loginMode === "password"
        ? await window.CloudBasePhoneAuth.signInWithPassword(phone, password)
        : await window.CloudBasePhoneAuth.signInWithCode(code);
      if (bootstrapMode) await window.CloudBasePhoneAuth.bootstrapHq();
      const staff = await window.CloudBasePhoneAuth.getStaffSession(phone);
      activeSession = createSession(identity, staff);
      enterWorkspace(activeSession);
    } catch (error) {
      setError(error.message || "登录失败，请检查手机号、密码或验证码");
    } finally { setBusy(submit, false, "登录系统"); }
  });
  document.documentElement.dataset.prototypeVersion = VERSION;
  if (isLocalPreview) {
    $("demoHint").innerHTML = "<b>仅本地演示：</b>总部 13900000001 / Demo@HQ2026；运营 13900000002 / Demo@OP2026；门店 13900000003 / Demo@ST2026；老师 13900000004 / Demo@TC2026。请使用密码登录。";
  }
  selectLoginMode("password");
  window.setInterval(() => { refreshSmsButton(); refreshResetSmsButton(); }, 1000);
  showPasswordReset(new URLSearchParams(location.search).get("mode") === "reset");
})();
