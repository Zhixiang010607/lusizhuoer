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
      form.reset();
      message.textContent = "密码已修改。下次登录请使用新密码。";
    } catch (error) {
      message.textContent = error?.message || "密码修改失败，请稍后重试。";
    } finally {
      button.disabled = false;
    }
  });
})();
