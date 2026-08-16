(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const regions = window.ChinaRegions || {};

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function options(values, placeholder) {
    return `<option value="">${escapeHtml(placeholder)}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  }

  function populateProvinces() {
    $("storeCreateProvince").innerHTML = options(Object.keys(regions), "请选择省");
  }

  function populateCities() {
    const province = $("storeCreateProvince").value;
    const cities = province ? Object.keys(regions[province] || {}) : [];
    const select = $("storeCreateCity");
    select.innerHTML = options(cities, province ? "请选择城市" : "请先选择省");
    select.disabled = !province;
    populateDistricts();
  }

  function populateDistricts() {
    const province = $("storeCreateProvince").value;
    const city = $("storeCreateCity").value;
    const districts = province && city ? (regions[province]?.[city] || []) : [];
    const select = $("storeCreateDistrict");
    select.innerHTML = options(districts, city ? "请选择区" : "请先选择城市");
    select.disabled = !city;
  }

  function normalizedPhone(value) {
    const phone = String(value || "").replace(/\D/g, "");
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error("请输入有效的中国大陆手机号");
    return phone;
  }

  function validateInitialPassword(value) {
    const password = String(value || "");
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(password)).length;
    if (password.length < 8 || password.length > 32 || groups < 3) {
      throw new Error("初始密码需为 8–32 位，并包含大写、小写、数字、特殊字符中的至少三类");
    }
    return password;
  }

  function pendingStoreKey(phone) {
    return `lusizhuoerPendingStoreProvision:${phone}`;
  }

  function readPendingStoreId(phone) {
    try {
      const item = JSON.parse(sessionStorage.getItem(pendingStoreKey(phone)) || "{}");
      return String(item?.storeId || "");
    } catch (_) {
      return "";
    }
  }

  function rememberPendingStore(phone, error) {
    if (!error?.storeId) return;
    try {
      sessionStorage.setItem(pendingStoreKey(phone), JSON.stringify({
        storeId: String(error.storeId),
        storeCode: String(error.storeCode || "")
      }));
    } catch (_) {
      // A retry is still possible; only the browser convenience state is lost.
    }
  }

  function clearPendingStore(phone) {
    try { sessionStorage.removeItem(pendingStoreKey(phone)); } catch (_) { /* ignore */ }
  }

  function storePayload() {
    const storeName = $("storeCreateName").value.trim();
    const province = $("storeCreateProvince").value;
    const city = $("storeCreateCity").value;
    const district = $("storeCreateDistrict").value;
    const address = $("storeCreateAddress").value.trim();
    const contactName = $("storeContactName").value.trim();
    const contactPhone = normalizedPhone($("storeContactPhone").value);
    const initialPassword = validateInitialPassword($("storeInitialPassword").value);

    if (!storeName || !province || !city || !district || !address || !contactName) {
      throw new Error("请完整填写门店资料和唯一登录联系人资料");
    }

    return {
      storeName,
      province,
      city,
      district,
      // addressDetail is the persisted database field; address keeps the
      // client payload compatible with older deployments during rollout.
      addressDetail: address,
      address,
      contactName,
      contactPhone,
      initialPassword,
      existingStoreId: readPendingStoreId(contactPhone)
    };
  }

  async function submitStore(event) {
    event.preventDefault();
    const message = $("storeCreateMessage");
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    let payload;
    try {
      payload = storePayload();
    } catch (error) {
      message.textContent = error?.message || "请检查填写内容";
      return;
    }

    if (!window.CloudBasePhoneAuth?.createStoreWithAccount) {
      message.textContent = "门店账号服务未加载，请刷新页面后重试";
      return;
    }

    submitButton.disabled = true;
    message.textContent = "正在创建门店资料与登录账号…";
    try {
      const result = await window.CloudBasePhoneAuth.createStoreWithAccount(payload);
      const store = result?.store || result || {};
      const storeId = store.id ?? result?.storeId;
      const storeCode = store.code || store.store_code || result?.storeCode || "";
      if (storeId === undefined || storeId === null || storeId === "") {
        throw new Error("门店已创建，但未获得门店编号；请返回门店管理核对后再试");
      }
      clearPendingStore(payload.contactPhone);
      $("generatedStoreCode").textContent = storeCode ? `编号 ${storeCode}（已创建）` : "门店已创建";
      message.textContent = "创建成功，正在跳转至门店管理…";
      window.setTimeout(() => {
        location.href = `store-management.html?created=${encodeURIComponent(String(storeId))}`;
      }, 350);
    } catch (error) {
      if (error?.storeRolledBack) clearPendingStore(payload.contactPhone);
      rememberPendingStore(payload.contactPhone, error);
      const retryHint = error?.storeId ? "门店资料已保留；请使用同一资料再次提交以恢复账号绑定。" : "";
      message.textContent = `${error?.message || "门店与登录账号创建失败"}${retryHint}`;
      submitButton.disabled = false;
    }
  }

  populateProvinces();
  $("storeCreateProvince").addEventListener("change", populateCities);
  $("storeCreateCity").addEventListener("change", populateDistricts);
  $("storeCreateForm").addEventListener("submit", submitStore);
})();
