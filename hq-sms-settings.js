(() => {
  "use strict";
  if (document.body.dataset.management !== "hq") return;
  const panel = document.getElementById("hqSmsSettings");
  const form = document.getElementById("hqSmsForm");
  const title = document.getElementById("hqSmsTarget");
  const phone = document.getElementById("hqSmsPhone");
  const keys = ["purchase", "recharge", "refund", "verification"];
  const inputs = keys.map(key => document.getElementById(`hqSms-${key}`));
  const save = document.getElementById("hqSmsSave");
  const status = document.getElementById("hqSmsStatus");
  let generation = 0, targetId = "", active = false, busy = false, loaded = false;
  const controls = () => { inputs.forEach(input => { input.disabled = busy || !loaded || (!active && !input.checked); }); save.disabled = busy || !loaded; };
  function show(preference) {
    title.textContent = `${preference.name} · 审核短信`;
    phone.textContent = `接收手机号：${preference.phone}`;
    inputs.forEach((input, index) => { input.checked = preference.categories[keys[index]] === true; });
    active = preference.active === true;
    loaded = true;
  }
  async function open({ staffAccountId, name }) {
    const epoch = ++generation;
    targetId = String(staffAccountId);
    loaded = false; busy = true; controls();
    panel.hidden = false;
    title.textContent = `${name} · 审核短信`;
    phone.textContent = "正在读取接收设置…";
    status.textContent = "";
    inputs.forEach(input => { input.checked = false; });
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    try {
      const data = await window.CloudBasePhoneAuth.getHqReviewSmsPreference({ staffAccountId: targetId });
      if (epoch !== generation) return;
      show(data.preference);
    } catch (error) {
      if (epoch === generation) status.textContent = error.message || "读取失败，请重新点击短信设置";
    } finally {
      if (epoch === generation) { busy = false; controls(); }
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !loaded) return;
    const epoch = generation, id = targetId;
    busy = true; controls(); status.textContent = "正在保存…";
    try {
      const data = await window.CloudBasePhoneAuth.setHqReviewSmsPreference({ staffAccountId: id, categories: Object.fromEntries(keys.map((key, index) => [key, inputs[index].checked])) });
      if (epoch !== generation) return;
      show(data.preference);
      status.textContent = "设置已保存";
    } catch (error) {
      if (epoch === generation) {
        // A lost write receipt is not proof of failure; require a fresh read.
        loaded = false;
        status.textContent = `${error.message || "保存结果未确认"}；请重新点击短信设置核对。`;
      }
    } finally {
      if (epoch === generation) { busy = false; controls(); }
    }
  });
  document.getElementById("hqSmsClose").addEventListener("click", () => { ++generation; panel.hidden = true; });
  document.getElementById("entityInfo").addEventListener("click", (event) => {
    const button = event.target.closest("[data-hq-sms-id]");
    if (button) open({ staffAccountId: button.dataset.hqSmsId, name: button.dataset.hqSmsName });
  });
  window.HqSmsSettings = Object.freeze({ open });
})();
