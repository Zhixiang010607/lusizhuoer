(() => {
  "use strict";

  const VERSION = "0.1.1";
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get("token") || "";
  const scores = { storeEnvironmentScore: 0, teacherServiceScore: 0, overallExperienceScore: 0 };
  let ratingContext = null;
  let cloudApp = null;
  let callableSessionPromise = null;

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function registerCloudBaseComponent(register, componentName) {
    if (typeof register !== "function") return;
    try { register(window.cloudbase); }
    catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      if (!(detail.includes("duplicate component") && detail.includes(componentName))) throw error;
    }
  }

  async function callRating(action, data = {}) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerAuth || !window.registerFunctions) {
      throw new Error("评价服务加载失败，请刷新页面重试。");
    }
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    cloudApp ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    callableSessionPromise ||= (async () => {
      const auth = cloudApp.auth();
      const current = await auth.getLoginState();
      if (!current) await auth.anonymousAuthProvider().signIn();
    })();
    try { await callableSessionPromise; }
    catch (error) {
      callableSessionPromise = null;
      throw error;
    }
    const raw = await cloudApp.callFunction({ name: "customerRating", data: { action, ...data } });
    const payload = [raw?.result, raw?.data?.result, raw?.data, raw]
      .map(parsedObject)
      .find((candidate) => candidate && Object.prototype.hasOwnProperty.call(candidate, "success"));
    if (!payload?.success) {
      const error = new Error(payload?.error?.message || "评价服务暂不可用，请稍后重试。");
      error.code = payload?.error?.code || "RATING_SERVICE_FAILED";
      throw error;
    }
    return payload.data || {};
  }

  function starText(score) {
    const value = Math.max(0, Math.min(5, Number(score) || 0));
    return `${"★".repeat(value)}${"☆".repeat(5 - value)}`;
  }

  function selectScore(group, score) {
    scores[group] = score;
    const fieldset = document.querySelector(`[data-rating-group="${group}"]`);
    fieldset?.querySelectorAll(".star-button").forEach((button) => {
      const active = Number(button.dataset.score) <= score;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(Number(button.dataset.score) === score));
    });
    const output = fieldset?.querySelector("output");
    if (output) output.value = `${score} 星 · ${starText(score)}`;
  }

  function buildStarPickers() {
    document.querySelectorAll("[data-rating-group]").forEach((fieldset) => {
      const group = fieldset.dataset.ratingGroup;
      const picker = fieldset.querySelector(".star-picker");
      for (let score = 1; score <= 5; score += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "star-button";
        button.dataset.score = String(score);
        button.textContent = "★";
        button.setAttribute("role", "radio");
        button.setAttribute("aria-label", `${score} 星`);
        button.setAttribute("aria-checked", "false");
        button.addEventListener("click", () => selectScore(group, score));
        picker.append(button);
      }
    });
  }

  function renderComplete(data) {
    $("ratingLoading").hidden = true;
    $("ratingForm").hidden = true;
    $("ratingComplete").hidden = false;
    const rows = [
      ["门店环境", data.storeEnvironmentScore],
      ...(data.requiresTeacherScore ? [["老师服务", data.teacherServiceScore]] : []),
      ["整体体验", data.overallExperienceScore]
    ];
    const scoreList = $("ratingCompleteScores");
    scoreList.replaceChildren(...rows.map(([label, score]) => {
      const row = document.createElement("div");
      const name = document.createElement("span");
      const stars = document.createElement("b");
      name.textContent = label;
      stars.textContent = `${starText(score)}  ${Number(score)} 星`;
      row.append(name, stars);
      return row;
    }));
    const comment = $("ratingCompleteComment");
    comment.hidden = !data.customerComment;
    comment.textContent = data.customerComment || "";
  }

  function renderContext(data) {
    ratingContext = data;
    $("ratingStoreName").textContent = data.storeName || "服务门店";
    $("ratingTeacherName").textContent = data.teacherName || "未指定";
    $("ratingProjectName").textContent = data.projectName || "服务项目";
    $("ratingServiceTime").textContent = data.serviceTime || "—";
    $("ratingTeacherContext").hidden = !data.requiresTeacherScore;
    $("teacherRatingQuestion").hidden = !data.requiresTeacherScore;
    $("ratingContext").hidden = false;
    $("ratingLoading").hidden = true;
    if (data.submitted || data.ratingStatus === "SUBMITTED") renderComplete(data);
    else $("ratingForm").hidden = false;
  }

  function showError(message) {
    $("ratingLoading").hidden = true;
    $("ratingForm").hidden = true;
    $("ratingComplete").hidden = true;
    $("ratingError").hidden = false;
    $("ratingError").textContent = message;
  }

  async function initialize() {
    if (!/^\d{1,20}\.\d{1,9}\.[A-Za-z0-9_-]{43}$/.test(token)) {
      showError("评价链接无效，请使用门店发送的最新二维码重新进入。");
      return;
    }
    try { renderContext(await callRating("getPublic", { token })); }
    catch (error) { showError(error?.message || "评价信息读取失败，请稍后重试。"); }
  }

  $("ratingComment").addEventListener("input", (event) => {
    $("ratingCommentCount").textContent = String(event.currentTarget.value.length);
  });

  $("ratingForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const requiredGroups = ["storeEnvironmentScore", "overallExperienceScore"];
    if (ratingContext?.requiresTeacherScore) requiredGroups.splice(1, 0, "teacherServiceScore");
    const missing = requiredGroups.find((group) => !scores[group]);
    if (missing) {
      const labels = { storeEnvironmentScore: "门店环境", teacherServiceScore: "老师服务", overallExperienceScore: "整体体验" };
      $("ratingFormMessage").textContent = `请为${labels[missing]}选择 1 至 5 星。`;
      document.querySelector(`[data-rating-group="${missing}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const button = $("submitRating");
    button.disabled = true;
    button.textContent = "正在提交…";
    $("ratingFormMessage").textContent = "";
    try {
      const result = await callRating("submitPublic", {
        token,
        storeEnvironmentScore: scores.storeEnvironmentScore,
        teacherServiceScore: ratingContext?.requiresTeacherScore ? scores.teacherServiceScore : null,
        overallExperienceScore: scores.overallExperienceScore,
        customerComment: $("ratingComment").value.trim()
      });
      renderComplete(result);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      $("ratingFormMessage").textContent = error?.message || "评价提交失败，请稍后重试。";
    } finally {
      button.disabled = false;
      button.textContent = "提交评价";
    }
  });

  buildStarPickers();
  initialize();
  document.documentElement.dataset.prototypeVersion = VERSION;
})();
