(() => {
  "use strict";
  const page = location.pathname.split("/").pop() || "index.html";
  const AUTH_CHANNEL_NAME = "lusizhuoer-auth-session-v1";
  const AUTH_STATE_KEY = "lusizhuoerActiveAuth";
  const SESSION_KEYS = ["prototypeSession", "prototypeRole", "prototypeAccount", "prototypeStore", "prototypeAccessMessage"];
  const isLocalPreview = ["127.0.0.1", "localhost"].includes(location.hostname);
  const homes = { hq: "index.html", operation: "local.html", store: "store-detail.html", teacher: "teacher-work-orders.html" };
  const labels = { hq: "总部工作区", operation: "运营工作区", store: "门店工作区", teacher: "老师工作区" };
  const access = {
    hq: new Set(["index.html", "change-password.html", "store-create.html", "project-create.html", "teacher-create.html", "operation-account-create.html", "hq-account-create.html", "hq-management.html", "store-management.html", "project-management.html", "teacher-management.html", "operation-account-management.html", "staff-detail.html", "store-detail.html", "project-detail.html", "teacher-detail.html", "customer-detail.html", "customer-query.html", "recharge-query.html", "verification-query.html", "recharge-detail.html", "verification-detail.html", "recharge-review.html", "verification-review.html"]),
    operation: new Set(["local.html", "change-password.html", "customer-detail.html", "customer-query.html", "recharge-query.html", "verification-query.html", "recharge-detail.html", "verification-detail.html", "recharge-review.html", "verification-review.html"]),
    store: new Set(["store-detail.html", "change-password.html", "customer-detail.html", "customer-query.html", "customer-create.html", "recharge-create.html", "verification-create.html", "verification-supplemental.html", "recharge-query.html", "verification-query.html", "recharge-detail.html", "verification-detail.html"]),
    teacher: new Set(["teacher-work-orders.html", "change-password.html", "teacher-work-order-detail.html", "teacher-verification-create.html", "teacher-recharge-create.html"])
  };
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  const valid = session && access[session.role] && session.account && (session.role !== "store" || session.store);
  if (!valid) { location.replace(`login.html?reason=${encodeURIComponent("请先选择身份并登录")}`); return; }

  function clearWorkspaceSession() {
    SESSION_KEYS.forEach((key) => sessionStorage.removeItem(key));
  }
  function redirectForSessionChange(message) {
    if (document.documentElement.dataset.authRedirecting === "true") return;
    document.documentElement.dataset.authRedirecting = "true";
    clearWorkspaceSession();
    location.replace(`login.html?reason=${encodeURIComponent(message)}`);
  }
  function stateMatchesExpected(state) {
    if (!state || state.type !== "SIGNED_IN") return false;
    if (String(state.uid || "") !== String(session.cloudbaseUserId || "")) return false;
    if (String(state.role || "").toLowerCase() !== String(session.role || "").toLowerCase()) return false;
    return session.role !== "store" || String(state.store || "") === String(session.store || "");
  }
  function parseSharedAuthState(value) {
    try { return JSON.parse(value || "null"); } catch (_) { return null; }
  }

  if (!isLocalPreview) {
    const sharedState = parseSharedAuthState(localStorage.getItem(AUTH_STATE_KEY));
    if (sharedState?.type === "SIGNED_IN" && !stateMatchesExpected(sharedState)) {
      redirectForSessionChange("此浏览器已登录另一个账号，当前页面已退出。若需同时使用总部和门店账号，请使用不同浏览器、不同浏览器用户配置或无痕窗口。");
      return;
    }
  }

  const homeUrl = session.role === "store" ? `${homes.store}?storeId=${encodeURIComponent(session.store)}` : homes[session.role];
  if (!access[session.role].has(page)) {
    try { sessionStorage.setItem("prototypeAccessMessage", `${labels[session.role]}无权进入其他身份页面`); } catch (_) { /* ignore */ }
    location.replace(homeUrl); return;
  }

  if (session.role === "store" && ["store-detail.html", "customer-detail.html", "recharge-detail.html", "verification-detail.html"].includes(page)) {
    const params = new URLSearchParams(location.search);
    if (params.get("storeId") !== session.store) { params.set("storeId", session.store); location.replace(`${page}?${params.toString()}`); return; }
  }

  const sidebar = document.querySelector(".side-project-bar");
  const primaryNav = document.querySelector(".side-project-bar > .side-nav");
  if (primaryNav) {
    // Some management pages used to omit this static heading.  The primary
    // navigation is rebuilt after login, so keep its section title in the
    // same position on every workspace page instead of letting it disappear.
    let primarySectionTitle = Array.from(sidebar?.children || []).find((node) => node.classList?.contains("side-section-title"));
    if (!primarySectionTitle) {
      primarySectionTitle = document.createElement("p");
      primarySectionTitle.className = "side-section-title";
      primaryNav.before(primarySectionTitle);
    }
    primarySectionTitle.textContent = session.role === "hq" ? "数据看板" : "工作台";
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
  if (!isLocalPreview) {
    if (typeof window.BroadcastChannel === "function") {
      const authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
      authChannel.addEventListener("message", (event) => {
        const state = event.data;
        if (state?.type === "SIGNED_IN" && !stateMatchesExpected(state)) {
          redirectForSessionChange("此浏览器已切换到另一个账号，旧工作区已安全退出。");
        } else if (["SIGNED_OUT", "AUTH_CHANGED"].includes(state?.type)) {
          redirectForSessionChange("当前云端登录状态已变更，请重新登录。");
        }
      });
    }
    window.addEventListener("storage", (event) => {
      if (event.key !== AUTH_STATE_KEY) return;
      const state = parseSharedAuthState(event.newValue);
      if (!state) redirectForSessionChange("当前云端账号已退出，请重新登录。");
      else if (!stateMatchesExpected(state)) redirectForSessionChange("此浏览器已切换到另一个账号，旧工作区已安全退出。");
    });

    let identityCheck = null;
    let lastIdentityCheckAt = Number(session.identityVerifiedAt || 0);
    async function verifyLiveIdentity({ force = false } = {}) {
      if (document.documentElement.dataset.authRedirecting === "true") return;
      if (!force && Date.now() - lastIdentityCheckAt < 15000) return;
      if (typeof window.CloudBasePhoneAuth?.validateWorkspaceSession !== "function") return;
      if (identityCheck) return identityCheck;
      identityCheck = window.CloudBasePhoneAuth.validateWorkspaceSession(session)
        .then(() => {
          lastIdentityCheckAt = Date.now();
          session.identityVerifiedAt = lastIdentityCheckAt;
          sessionStorage.setItem("prototypeSession", JSON.stringify(session));
        })
        .catch((error) => {
          if (error?.code === "AUTH_SESSION_CHANGED") {
            redirectForSessionChange(`${error.message || "当前账号与本页面不一致"}，请重新登录。`);
            return;
          }
          // 身份服务短暂失败时不把用户误判为越权；下一次页面重新获得焦点时再核对。
          console.warn("Live identity check deferred", error);
        })
        .finally(() => { identityCheck = null; });
      return identityCheck;
    }
    window.addEventListener("focus", () => verifyLiveIdentity({ force: true }));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") verifyLiveIdentity({ force: true });
    });
    verifyLiveIdentity();
  }

  $("logoutWorkspace")?.addEventListener("click", async () => {
    const button = $("logoutWorkspace");
    if (button) button.disabled = true;
    try {
      if (!isLocalPreview && typeof window.CloudBasePhoneAuth?.signOut === "function") {
        await window.CloudBasePhoneAuth.signOut();
      } else if (!isLocalPreview) {
        localStorage.removeItem(AUTH_STATE_KEY);
        if (typeof window.BroadcastChannel === "function") {
          const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
          channel.postMessage({ type: "SIGNED_OUT", occurredAt: Date.now() });
          channel.close();
        }
      }
    } catch (error) {
      console.warn("Cloud sign-out failed", error);
    } finally {
      clearWorkspaceSession();
      location.replace("login.html");
    }
  });

  function initializeChineseBirthdayInputs() {
    const birthdayInputIds = [
      "createCustomerBirthday",
      "customerBirthday",
      "recordCustomerBirthday",
      "serviceCustomerBirthday",
      "queryCustomerBirthday",
      "teacherCustomerBirthday"
    ];
    const currentYear = new Date().getFullYear();
    const pad2 = (value) => String(value).padStart(2, "0");

    birthdayInputIds.forEach((id) => {
      const input = $(id);
      if (!input || input.dataset.chineseBirthdayReady === "true") return;

      const wasRequired = input.required;
      input.dataset.chineseBirthdayReady = "true";
      input.required = false;
      input.type = "hidden";

      const wrapper = document.createElement("div");
      wrapper.className = "chinese-birthday-input";
      wrapper.setAttribute("role", "group");
      wrapper.setAttribute("aria-label", "生日（年、月、日）");

      const createSelect = (ariaLabel) => {
        const select = document.createElement("select");
        select.setAttribute("aria-label", ariaLabel);
        if (wasRequired) select.required = true;
        select.append(new Option("", ""));
        return select;
      };
      const yearSelect = createSelect("生日年份");
      const monthSelect = createSelect("生日月份");
      const daySelect = createSelect("生日日期");

      for (let year = currentYear; year >= 1900; year -= 1) {
        yearSelect.append(new Option(String(year), String(year)));
      }
      for (let month = 1; month <= 12; month += 1) {
        monthSelect.append(new Option(pad2(month), String(month)));
      }

      const appendUnit = (unit) => {
        const span = document.createElement("span");
        span.textContent = unit;
        wrapper.append(span);
      };
      wrapper.append(yearSelect);
      appendUnit("年");
      wrapper.append(monthSelect);
      appendUnit("月");
      wrapper.append(daySelect);
      appendUnit("日");
      input.insertAdjacentElement("afterend", wrapper);

      const fillDays = (selectedDay = "") => {
        const maximum = yearSelect.value && monthSelect.value
          ? new Date(Number(yearSelect.value), Number(monthSelect.value), 0).getDate()
          : 31;
        daySelect.replaceChildren(new Option("", ""));
        for (let day = 1; day <= maximum; day += 1) {
          daySelect.append(new Option(pad2(day), String(day)));
        }
        if (selectedDay && Number(selectedDay) <= maximum) daySelect.value = String(Number(selectedDay));
      };

      const updateIsoValue = () => {
        input.value = yearSelect.value && monthSelect.value && daySelect.value
          ? `${yearSelect.value}-${pad2(monthSelect.value)}-${pad2(daySelect.value)}`
          : "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const syncFromInput = () => {
        const match = String(input.value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        yearSelect.value = match?.[1] || "";
        monthSelect.value = match ? String(Number(match[2])) : "";
        fillDays(match?.[3] || "");
      };
      input.syncChineseBirthday = syncFromInput;

      yearSelect.addEventListener("change", () => {
        const selectedDay = daySelect.value;
        fillDays(selectedDay);
        updateIsoValue();
      });
      monthSelect.addEventListener("change", () => {
        const selectedDay = daySelect.value;
        fillDays(selectedDay);
        updateIsoValue();
      });
      daySelect.addEventListener("change", updateIsoValue);
      input.form?.addEventListener("reset", () => setTimeout(syncFromInput, 0));
      syncFromInput();
    });
  }

  function initializeChineseDateInputs() {
    if (!document.body.matches("[data-query], [data-customer-query], [data-view]")) return;
    const inputs = Array.from(document.querySelectorAll('input[type="date"]'));
    if (!inputs.length) return;
    const pad2 = (value) => String(value).padStart(2, "0");
    const today = new Date();
    const currentTodayIso = () => {
      const current = new Date();
      return `${current.getFullYear()}-${pad2(current.getMonth() + 1)}-${pad2(current.getDate())}`;
    };
    const weekdayNames = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const formatVisibleDate = (value) => {
      const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return match ? `${match[1]}年${match[2]}月${match[3]}日` : "请选择日期";
    };
    const parseIsoDate = (value) => {
      const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const check = new Date(year, month - 1, day);
      return check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day
        ? { year, month, day }
        : null;
    };
    const dateIso = (year, monthIndex, day) => `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
    const inputLabel = (input) => {
      const key = String(input.id || "").toLowerCase();
      if (key.includes("start") || key.includes("from")) return "开始日期";
      if (key.includes("end") || key.includes("to")) return "结束日期";
      return "日期";
    };

    const calendar = document.createElement("section");
    calendar.id = "chineseDateCalendar";
    calendar.className = "chinese-date-calendar";
    calendar.setAttribute("role", "dialog");
    calendar.setAttribute("aria-modal", "false");
    calendar.setAttribute("aria-label", "选择日期");
    calendar.hidden = true;
    calendar.innerHTML = `
      <div class="chinese-date-calendar-header">
        <button id="chineseDatePreviousMonth" type="button" aria-label="上个月">‹</button>
        <strong id="chineseDateCalendarTitle" aria-live="polite"></strong>
        <button id="chineseDateNextMonth" type="button" aria-label="下个月">›</button>
      </div>
      <div class="chinese-date-calendar-weekdays" aria-hidden="true"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
      <div id="chineseDateCalendarDays" class="chinese-date-calendar-days" role="grid"></div>
      <div class="chinese-date-calendar-footer"><button id="chineseDateClear" type="button">清除</button><button id="chineseDateToday" type="button">今天</button></div>
    `;
    document.body.append(calendar);

    const calendarTitle = calendar.querySelector("#chineseDateCalendarTitle");
    const calendarDays = calendar.querySelector("#chineseDateCalendarDays");
    const previousMonth = calendar.querySelector("#chineseDatePreviousMonth");
    const nextMonth = calendar.querySelector("#chineseDateNextMonth");
    const clearDate = calendar.querySelector("#chineseDateClear");
    const chooseToday = calendar.querySelector("#chineseDateToday");
    let activeInput = null;
    let activeTrigger = null;
    let viewYear = today.getFullYear();
    let viewMonth = today.getMonth();

    const withinBounds = (input, iso) => (!input.min || iso >= input.min) && (!input.max || iso <= input.max);
    const closeCalendar = (restoreFocus = false) => {
      if (calendar.hidden) return;
      calendar.hidden = true;
      activeTrigger?.setAttribute("aria-expanded", "false");
      const trigger = activeTrigger;
      activeInput = null;
      activeTrigger = null;
      if (restoreFocus) trigger?.focus();
    };
    const setInputDate = (input, value) => {
      const nextValue = String(value || "");
      const changed = input.value !== nextValue;
      input.value = nextValue;
      input.syncChineseDate?.();
      if (changed) {
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closeCalendar(true);
    };
    const preferredDayButton = () => calendarDays.querySelector('[aria-selected="true"]:not(:disabled)')
      || calendarDays.querySelector('[aria-current="date"]:not(:disabled)')
      || calendarDays.querySelector("button:not(.is-outside-month):not(:disabled)")
      || calendarDays.querySelector("button:not(:disabled)");
    const setRovingFocus = (button) => {
      calendarDays.querySelectorAll("button").forEach((item) => { item.tabIndex = item === button ? 0 : -1; });
      button?.focus();
    };
    const renderCalendar = () => {
      if (!activeInput) return;
      calendarTitle.textContent = `${viewYear}年${viewMonth + 1}月`;
      calendarDays.replaceChildren();
      const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
      const selectedValue = activeInput.value;
      const todayIso = currentTodayIso();
      let row = null;
      for (let index = 0; index < 42; index += 1) {
        if (index % 7 === 0) {
          row = document.createElement("div");
          row.className = "chinese-date-calendar-row";
          row.setAttribute("role", "row");
          calendarDays.append(row);
        }
        const date = new Date(viewYear, viewMonth, index - firstWeekday + 1);
        const iso = dateIso(date.getFullYear(), date.getMonth(), date.getDate());
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chinese-date-calendar-day";
        button.textContent = String(date.getDate());
        button.dataset.date = iso;
        button.setAttribute("role", "gridcell");
        button.setAttribute("aria-label", `${formatVisibleDate(iso)} ${weekdayNames[date.getDay()]}`);
        button.setAttribute("aria-selected", iso === selectedValue ? "true" : "false");
        button.tabIndex = -1;
        if (date.getMonth() !== viewMonth) button.classList.add("is-outside-month");
        if (iso === todayIso) {
          button.classList.add("is-today");
          button.setAttribute("aria-current", "date");
        }
        if (iso === selectedValue) button.classList.add("is-selected");
        button.disabled = !withinBounds(activeInput, iso);
        button.addEventListener("click", () => setInputDate(activeInput, iso));
        row.append(button);
      }
      const preferred = preferredDayButton();
      if (preferred) preferred.tabIndex = 0;
      chooseToday.disabled = !withinBounds(activeInput, todayIso);
    };
    const positionCalendar = () => {
      if (!activeTrigger || calendar.hidden) return;
      const anchor = activeTrigger.getBoundingClientRect();
      const panelWidth = calendar.offsetWidth || 280;
      const panelHeight = calendar.offsetHeight || 330;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || window.innerWidth;
      const viewportHeight = viewport?.height || window.innerHeight;
      const left = Math.min(
        Math.max(viewportLeft + 8, anchor.left),
        Math.max(viewportLeft + 8, viewportLeft + viewportWidth - panelWidth - 8)
      );
      const below = anchor.bottom + 6;
      const top = below + panelHeight <= viewportTop + viewportHeight - 8
        ? below
        : Math.max(viewportTop + 8, anchor.top - panelHeight - 6);
      calendar.style.left = `${Math.round(left)}px`;
      calendar.style.top = `${Math.round(top)}px`;
    };
    const openCalendar = (input, trigger) => {
      if (input.disabled) return;
      const selected = parseIsoDate(input.value) || parseIsoDate(currentTodayIso());
      activeInput = input;
      activeTrigger?.setAttribute("aria-expanded", "false");
      activeTrigger = trigger;
      viewYear = selected.year;
      viewMonth = selected.month - 1;
      calendar.setAttribute("aria-label", `选择${inputLabel(input)}`);
      trigger.setAttribute("aria-expanded", "true");
      calendar.hidden = false;
      renderCalendar();
      positionCalendar();
      requestAnimationFrame(() => {
        if (!calendar.hidden) setRovingFocus(preferredDayButton());
      });
    };
    const changeMonth = (offset) => {
      const next = new Date(viewYear, viewMonth + offset, 1);
      viewYear = next.getFullYear();
      viewMonth = next.getMonth();
      renderCalendar();
    };
    const focusCalendarDate = (date) => {
      if (!activeInput) return;
      const iso = dateIso(date.getFullYear(), date.getMonth(), date.getDate());
      if (!withinBounds(activeInput, iso)) return;
      viewYear = date.getFullYear();
      viewMonth = date.getMonth();
      renderCalendar();
      requestAnimationFrame(() => {
        if (!calendar.hidden) setRovingFocus(calendarDays.querySelector(`[data-date="${iso}"]`));
      });
    };

    previousMonth.addEventListener("click", () => changeMonth(-1));
    nextMonth.addEventListener("click", () => changeMonth(1));
    clearDate.addEventListener("click", () => activeInput && setInputDate(activeInput, ""));
    chooseToday.addEventListener("click", () => activeInput && setInputDate(activeInput, currentTodayIso()));
    calendarDays.addEventListener("keydown", (event) => {
      const current = event.target.closest("button[data-date]");
      const currentDate = parseIsoDate(current?.dataset.date);
      if (!currentDate) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        current.click();
        return;
      }
      const date = new Date(currentDate.year, currentDate.month - 1, currentDate.day);
      const dayOffsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (event.key in dayOffsets) {
        date.setDate(date.getDate() + dayOffsets[event.key]);
      } else if (event.key === "Home") {
        date.setDate(date.getDate() - date.getDay());
      } else if (event.key === "End") {
        date.setDate(date.getDate() + 6 - date.getDay());
      } else if (event.key === "PageUp" || event.key === "PageDown") {
        const direction = event.key === "PageUp" ? -1 : 1;
        const monthOffset = direction * (event.shiftKey ? 12 : 1);
        const targetMonth = new Date(date.getFullYear(), date.getMonth() + monthOffset, 1);
        const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
        date.setFullYear(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(date.getDate(), lastDay));
      } else {
        return;
      }
      event.preventDefault();
      focusCalendarDate(date);
    });
    calendar.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        const focusable = Array.from(calendar.querySelectorAll("button:not(:disabled)"))
          .filter((button) => button.tabIndex >= 0);
        const atBoundary = event.shiftKey
          ? document.activeElement === focusable[0]
          : document.activeElement === focusable[focusable.length - 1];
        if (atBoundary) {
          event.preventDefault();
          closeCalendar(true);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeCalendar(true);
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!activeInput || calendar.contains(event.target) || activeTrigger?.contains(event.target)) return;
      closeCalendar(false);
    });
    document.addEventListener("focusin", (event) => {
      if (!activeInput || calendar.contains(event.target) || activeTrigger?.contains(event.target)) return;
      closeCalendar(false);
    });
    window.addEventListener("resize", positionCalendar);
    window.addEventListener("scroll", (event) => {
      if (!calendar.contains(event.target)) closeCalendar(false);
    }, true);
    window.visualViewport?.addEventListener("resize", positionCalendar);
    window.visualViewport?.addEventListener("scroll", () => closeCalendar(false));

    inputs.forEach((input) => {
      if (input.dataset.chineseDateReady === "true") return;
      input.dataset.chineseDateReady = "true";

      const wrapper = document.createElement("div");
      wrapper.className = "chinese-date-input";
      input.insertAdjacentElement("beforebegin", wrapper);
      input.type = "hidden";
      wrapper.append(input);

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "chinese-date-trigger";
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-controls", calendar.id);
      trigger.setAttribute("aria-expanded", "false");
      const visibleValue = document.createElement("span");
      visibleValue.className = "chinese-date-input-value";
      const icon = document.createElement("span");
      icon.className = "chinese-date-input-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "日";
      trigger.append(visibleValue, icon);
      wrapper.append(trigger);

      const sync = () => {
        const hasValue = /^\d{4}-\d{2}-\d{2}$/.test(String(input.value || ""));
        visibleValue.textContent = formatVisibleDate(input.value);
        wrapper.classList.toggle("is-empty", !hasValue);
        wrapper.classList.toggle("is-disabled", input.disabled);
        trigger.disabled = input.disabled;
        trigger.setAttribute("aria-label", `${inputLabel(input)}：${visibleValue.textContent}`);
        if (activeInput === input && input.disabled) closeCalendar(false);
      };
      input.syncChineseDate = sync;
      input.addEventListener("input", sync);
      input.addEventListener("change", sync);
      input.form?.addEventListener("reset", () => setTimeout(sync, 0));
      trigger.addEventListener("click", () => activeInput === input ? closeCalendar(false) : openCalendar(input, trigger));
      trigger.addEventListener("keydown", (event) => {
        if (event.altKey && event.key === "ArrowDown") {
          event.preventDefault();
          openCalendar(input, trigger);
        }
      });
      sync();
    });

    const syncAll = () => inputs.forEach((input) => input.syncChineseDate?.());
    document.addEventListener("change", () => queueMicrotask(syncAll));
    document.addEventListener("click", () => queueMicrotask(syncAll));
    window.addEventListener("pageshow", syncAll);
  }

  initializeChineseBirthdayInputs();
  initializeChineseDateInputs();
  document.documentElement.dataset.authReady = "true";

  function $(id) { return document.getElementById(id); }
})();
