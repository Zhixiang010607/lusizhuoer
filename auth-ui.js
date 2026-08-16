(() => {
  "use strict";
  const page = location.pathname.split("/").pop() || "index.html";
  const homes = { hq: "index.html", operation: "local.html", store: "store-detail.html", teacher: "teacher-work-orders.html" };
  const labels = { hq: "总部工作区", operation: "运营工作区", store: "门店工作区", teacher: "老师工作区" };
  const access = {
    hq: new Set(["index.html", "change-password.html", "store-create.html", "project-create.html", "teacher-create.html", "operation-account-create.html", "hq-account-create.html", "hq-management.html", "store-management.html", "project-management.html", "teacher-management.html", "operation-account-management.html", "staff-detail.html", "store-detail.html", "project-detail.html", "teacher-detail.html", "customer-detail.html", "customer-query.html", "recharge-query.html", "verification-query.html", "recharge-detail.html", "verification-detail.html", "recharge-review.html", "verification-review.html", "recharge-demo.html", "verification-demo.html", "store-work-order-demo.html", "store-verification-work-order-demo.html", "customer-profile-demo.html"]),
    operation: new Set(["local.html", "change-password.html", "customer-detail.html", "customer-query.html", "recharge-query.html", "verification-query.html", "recharge-detail.html", "verification-detail.html", "recharge-review.html", "verification-review.html"]),
    store: new Set(["store-detail.html", "change-password.html", "customer-detail.html", "customer-query.html", "customer-create.html", "recharge-create.html", "verification-create.html", "verification-supplemental.html", "recharge-query.html", "verification-query.html", "recharge-detail.html", "verification-detail.html"]),
    teacher: new Set(["teacher-work-orders.html", "change-password.html", "teacher-work-order-detail.html", "teacher-verification-create.html", "teacher-recharge-create.html"])
  };
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  const valid = session && access[session.role] && session.account && (session.role !== "store" || session.store);
  if (!valid) { location.replace(`login.html?reason=${encodeURIComponent("请先选择身份并登录")}`); return; }

  const homeUrl = session.role === "store" ? `${homes.store}?storeId=${encodeURIComponent(session.store)}` : homes[session.role];
  if (!access[session.role].has(page)) {
    try { sessionStorage.setItem("prototypeAccessMessage", `${labels[session.role]}无权进入其他身份页面`); } catch (_) { /* ignore */ }
    location.replace(homeUrl); return;
  }

  if (session.role === "store" && ["store-detail.html", "customer-detail.html", "recharge-detail.html", "verification-detail.html"].includes(page)) {
    const params = new URLSearchParams(location.search);
    if (params.get("storeId") !== session.store) { params.set("storeId", session.store); location.replace(`${page}?${params.toString()}`); return; }
  }

  const primaryNav = document.querySelector(".side-project-bar > .side-nav");
  if (primaryNav) {
    const navLabel = session.role === "hq" ? "全局视图" : session.role === "operation" ? "运营分析" : session.role === "teacher" ? "我的工作台" : "门店首页";
    const navIcon = session.role === "hq" ? "总" : session.role === "operation" ? "运" : session.role === "teacher" ? "师" : "店";
    primaryNav.innerHTML = `<a class="active" href="${homeUrl}"><span class="nav-icon">${navIcon}</span><span>${navLabel}</span></a>`;
    if (session.role === "store") {
      document.querySelectorAll(".side-project-bar > .side-menu-group").forEach((group) => { group.hidden = true; });
      const businessLinks = [["customer-create.html", "客户建立"], ["recharge-create.html", "办卡充值"], ["verification-create.html", "核销办理"], ["verification-supplemental.html", "补录核销"]];
      primaryNav.insertAdjacentHTML("afterend", `<details class="side-menu-group" open data-menu="store-business"><summary><span class="nav-icon">办</span><span>业务办理</span></summary><nav>${businessLinks.map(([href, text]) => `<a class="${page === href ? "active" : ""}" href="${href}">${text}</a>`).join("")}</nav></details>`);
      const queryLinks = [["customer-query.html", "客户查询"], ["recharge-query.html", "充值查询"], ["verification-query.html", "核销查询"]];
      document.querySelector('[data-menu="store-business"]')?.insertAdjacentHTML("afterend", `<details class="side-menu-group" open data-menu="store-query"><summary><span class="nav-icon">查</span><span>查询</span></summary><nav>${queryLinks.map(([href, text]) => `<a class="${page === href ? "active" : ""}" href="${href}">${text}</a>`).join("")}</nav></details>`);
    } else if (session.role === "teacher") {
      const businessLinks = [["teacher-verification-create.html", "办理核销"], ["teacher-recharge-create.html", "办理充值"]];
      primaryNav.insertAdjacentHTML("afterend", `<details class="side-menu-group" open data-menu="teacher-business"><summary><span class="nav-icon">办</span><span>业务办理</span></summary><nav>${businessLinks.map(([href, text]) => `<a class="${page === href ? "active" : ""}" href="${href}">${text}</a>`).join("")}</nav></details>`);
    } else {
      const queryLinks = [["customer-query.html", "客户查询"], ["recharge-query.html", "充值查询"], ["verification-query.html", "核销查询"]];
      document.querySelectorAll(".side-project-bar > .side-menu-group").forEach((group) => {
        if (group.querySelector("summary")?.textContent.includes("查询")) group.hidden = true;
      });
      primaryNav.insertAdjacentHTML("afterend", `<details class="side-menu-group" open data-menu="shared-query"><summary><span class="nav-icon">查</span><span>查询</span></summary><nav>${queryLinks.map(([href, text]) => `<a class="${page === href ? "active" : ""}" href="${href}">${text}</a>`).join("")}</nav></details>`);
      if (session.role === "hq") {
        document.querySelectorAll(".side-project-bar > .side-menu-group").forEach((group) => {
          if (group.querySelector("summary")?.textContent.includes("管理")) group.hidden = true;
        });
        const managementLinks = [["store-management.html", "门店管理"], ["project-management.html", "产品管理"], ["teacher-management.html", "老师管理"], ["operation-account-management.html", "运营管理"], ["hq-management.html", "总部管理"]];
        document.querySelector('[data-menu="shared-query"]')?.insertAdjacentHTML("afterend", `<details class="side-menu-group" open data-menu="hq-management"><summary><span class="nav-icon">管</span><span>管理</span></summary><nav>${managementLinks.map(([href, text]) => `<a class="${page === href ? "active" : ""}" href="${href}">${text}</a>`).join("")}</nav></details>`);
      }
    }
  }

  if (["hq", "operation"].includes(session.role)) {
    let reviewMenu = document.querySelector('[data-menu="review"]');
    if (!reviewMenu) {
      const anchor = (session.role === "hq" ? document.querySelector('[data-menu="hq-management"]') : null) || document.querySelector('[data-menu="shared-query"]') || primaryNav;
      anchor?.insertAdjacentHTML("afterend", `<details class="side-menu-group" open data-menu="review"><summary><span class="nav-icon">审</span><span>审核</span></summary><nav><a class="${page === "recharge-review.html" ? "active" : ""}" href="recharge-review.html">充值审核</a><a class="${page === "verification-review.html" ? "active" : ""}" href="verification-review.html">核销审核</a></nav></details>`);
      reviewMenu = document.querySelector('[data-menu="review"]');
    }
    if (reviewMenu) { reviewMenu.hidden = false; reviewMenu.open = true; }
    if (session.role === "hq") {
      let demoMenu = document.querySelector('[data-menu="demo"]');
      if (!demoMenu) {
        reviewMenu?.insertAdjacentHTML("afterend", `<details class="side-menu-group" open data-menu="demo"><summary><span class="nav-icon">单</span><span>工单</span></summary><nav><a class="${page === "recharge-demo.html" ? "active" : ""}" href="recharge-demo.html">充值工单</a><a class="${page === "verification-demo.html" ? "active" : ""}" href="verification-demo.html">核销工单</a><a class="${page === "store-work-order-demo.html" ? "active" : ""}" href="store-work-order-demo.html">门店充值工单</a><a class="${page === "store-verification-work-order-demo.html" ? "active" : ""}" href="store-verification-work-order-demo.html">门店核销工单</a><a class="${page === "customer-profile-demo.html" ? "active" : ""}" href="customer-profile-demo.html">客户主页</a></nav></details>`);
        demoMenu = document.querySelector('[data-menu="demo"]');
      }
      if (demoMenu) { demoMenu.hidden = false; demoMenu.open = true; }
    }
  }

  document.querySelectorAll("a[href]").forEach((link) => {
    const target = link.getAttribute("href").split(/[?#]/)[0];
    if (target.endsWith(".html") && target !== "login.html" && !access[session.role].has(target)) link.hidden = true;
  });
  document.querySelectorAll(".side-menu-group").forEach((group) => {
    if (![...group.querySelectorAll("a")].some((link) => !link.hidden)) group.hidden = true;
  });

  document.querySelectorAll(".side-brand strong").forEach((node) => { node.textContent = labels[session.role]; });
  const footer = document.querySelector(".side-footer");
  if (footer) footer.innerHTML = `<span>${session.account}${session.store ? ` · ${session.store}` : ""}</span><button id="logoutWorkspace" type="button">退出登录</button>`;
  let message = "";
  try { message = sessionStorage.getItem("prototypeAccessMessage") || ""; if (message) sessionStorage.removeItem("prototypeAccessMessage"); } catch (_) { message = ""; }
  if (message) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="access-notice" role="status">${message}</div>`);
    window.setTimeout(() => document.querySelector(".access-notice")?.remove(), 4200);
  }
  if (window.matchMedia("(min-width: 761px) and (max-width: 1100px)").matches) {
    document.querySelectorAll(".side-menu-group[open]").forEach((group) => group.removeAttribute("open"));
  }
  $("logoutWorkspace")?.addEventListener("click", () => {
    ["prototypeSession", "prototypeRole", "prototypeAccount", "prototypeStore", "prototypeAccessMessage"].forEach((key) => sessionStorage.removeItem(key));
    location.replace("login.html");
  });
  document.documentElement.dataset.authReady = "true";

  function $(id) { return document.getElementById(id); }
})();
