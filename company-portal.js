(() => {
  "use strict";
  const sections = [...document.querySelectorAll("[data-company-section]")];
  const links = [...document.querySelectorAll("[data-company-nav]")];
  function showSection() {
    const params = new URLSearchParams(location.search);
    const requested = location.hash.slice(1) || (params.has("reason") || params.get("mode") === "reset" ? "login" : "overview");
    const selected = sections.some((section) => section.dataset.companySection === requested) ? requested : "overview";
    sections.forEach((section) => { section.hidden = section.dataset.companySection !== selected; });
    links.forEach((link) => {
      if (link.dataset.companyNav === selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.title = selected === "login" ? "系统登录 · 露思卓儿" : "广州露思卓儿科技有限公司";
  }
  window.addEventListener("hashchange", showSection);
  showSection();
})();
