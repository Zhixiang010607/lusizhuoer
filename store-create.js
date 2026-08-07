(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let contactSequence = 0;
  const regions = window.ChinaRegions || {};

  function storedStores() {
    try { return JSON.parse(sessionStorage.getItem("prototypeCreatedStores") || "[]"); } catch (_) { return []; }
  }

  function nextStoreId() {
    const highest = storedStores().reduce((max, store) => Math.max(max, Number(String(store.id || "").replace(/\D/g, "")) || 0), 16);
    return `S${String(highest + 1).padStart(3, "0")}`;
  }

  function refreshCode() { $("generatedStoreCode").textContent = `编号 ${nextStoreId()}（自动生成）`; }

  function options(values, placeholder) { return `<option value="">${placeholder}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`; }
  function populateProvinces() { $("storeCreateProvince").innerHTML = options(Object.keys(regions), "请选择省"); }
  function populateCities() {
    const province = $("storeCreateProvince").value, cities = province ? Object.keys(regions[province]) : [];
    $("storeCreateCity").innerHTML = options(cities, province ? "请选择城市" : "请先选择省");
    $("storeCreateCity").disabled = !province;
    populateDistricts();
  }
  function populateDistricts() {
    const province = $("storeCreateProvince").value, city = $("storeCreateCity").value;
    const districts = province && city ? regions[province][city] : [];
    $("storeCreateDistrict").innerHTML = options(districts, city ? "请选择区" : "请先选择城市");
    $("storeCreateDistrict").disabled = !city;
  }

  function addContact(value = {}) {
    contactSequence += 1;
    const row = document.createElement("div");
    row.className = "store-contact-row";
    row.dataset.contactRow = String(contactSequence);
    row.innerHTML = `<label>联系人姓名<input name="contactName" required maxlength="40" value="${escapeHtml(value.name || "")}" placeholder="请输入联系人姓名"></label><label>联系电话<input name="contactPhone" type="tel" required maxlength="30" value="${escapeHtml(value.phone || "")}" placeholder="请输入联系电话"></label><button class="remove-contact-button danger-button" type="button">删除</button>`;
    row.querySelector(".remove-contact-button").addEventListener("click", () => {
      if ($("storeContactList").children.length > 1) row.remove();
    });
    $("storeContactList").appendChild(row);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function submitStore(event) {
    event.preventDefault();
    const contacts = [...document.querySelectorAll(".store-contact-row")].map((row) => ({ name: row.querySelector('[name="contactName"]').value.trim(), phone: row.querySelector('[name="contactPhone"]').value.trim() }));
    if (!contacts.length || contacts.some((contact) => !contact.name || !contact.phone)) return;
    const created = storedStores(), id = nextStoreId();
    let session = null;
    try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
    created.push({ id, name: $("storeCreateName").value.trim(), province: $("storeCreateProvince").value.trim(), city: $("storeCreateCity").value.trim(), district: $("storeCreateDistrict").value.trim(), address: $("storeCreateAddress").value.trim(), contacts, account: `STORE${id.slice(1)}`, password: randomPassword(), status: "正常", createdAt: new Date().toISOString(), createdBy: { account: session?.account || "HQ001", name: session?.name || "总部管理员" } });
    sessionStorage.setItem("prototypeCreatedStores", JSON.stringify(created));
    location.href = `store-management.html?created=${encodeURIComponent(id)}`;
  }
  function randomPassword() { return Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join(""); }

  refreshCode(); populateProvinces(); addContact();
  $("storeCreateProvince").addEventListener("change", populateCities);
  $("storeCreateCity").addEventListener("change", populateDistricts);
  $("addStoreContact").addEventListener("click", () => addContact());
  $("storeCreateForm").addEventListener("submit", submitStore);
})();
