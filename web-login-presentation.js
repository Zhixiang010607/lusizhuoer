(() => {
  "use strict";
  const login = document.querySelector('[data-company-section="login"]');
  if (!login) return;
  const update = () => document.body.classList.toggle("company-login-view", !login.hidden);
  new MutationObserver(update).observe(login, { attributes: true, attributeFilter: ["hidden"] });
  update();
})();
