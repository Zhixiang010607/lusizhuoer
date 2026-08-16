(() => {
  "use strict";
  const form = document.getElementById("changePasswordForm");
  const message = document.getElementById("changePasswordMessage");
  const password = document.getElementById("newPassword");
  const confirmation = document.getElementById("confirmPassword");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = password.value;
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(value)).length;
    if (value.length < 8 || value.length > 32 || groups < 3) {
      message.textContent = "新密码不符合安全规则。";
      return;
    }
    if (value !== confirmation.value) {
      message.textContent = "两次输入的密码不一致。";
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    message.textContent = "正在保存…";
    try {
      if (!window.CloudBasePhoneAuth?.changeOwnPassword) throw new Error("账号服务未加载，请刷新后重试");
      await window.CloudBasePhoneAuth.changeOwnPassword(value);
      try {
        const session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null");
        if (session) {
          session.passwordChangeRequired = false;
          sessionStorage.setItem("prototypeSession", JSON.stringify(session));
        }
      } catch (_) { /* keep the completed password change even if local state is unavailable */ }
      form.reset();
      message.textContent = "密码已修改。下次登录请使用新密码。";
      window.setTimeout(() => {
        let session = null;
        try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
        const homes = { hq: "index.html", operation: "local.html", store: "store-detail.html", teacher: "teacher-work-orders.html" };
        const target = homes[session?.role] || "login.html";
        const suffix = session?.role === "store" && session.store ? `?storeId=${encodeURIComponent(session.store)}` : "";
        location.replace(target + suffix);
      }, 700);
    } catch (error) {
      message.textContent = error?.message || "密码修改失败，请稍后重试。";
    } finally {
      button.disabled = false;
    }
  });
})();
