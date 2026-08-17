(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { stores: [], appliedPhone: "" };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizedPhone(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function storePhone(store) {
    return String(store.contact_phone || store.phone || "").trim();
  }

  function storeContact(store) {
    return String(store.contact_name || store.staff_name || "").trim();
  }

  function storeAddress(store) {
    const parts = [store.province, store.city, store.district, store.address_detail || store.address]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    return parts.filter((part, index) => index === 0 || part !== parts[index - 1]).join(" ");
  }

  function isArchived(store) {
    return String(store.store_status || store.status || "").toUpperCase() === "ARCHIVED";
  }

  function storeReference(store) {
    return String(store.auth_uid || store.id || store.store_code || "").trim();
  }

  function storeRow(store) {
    const reference = storeReference(store);
    const name = String(store.store_name || store.name || "未命名门店").trim();
    const nameMarkup = reference
      ? `<a class="record-link store-global-link" href="store-detail.html?storeId=${encodeURIComponent(reference)}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    return `<tr>
      <td>${nameMarkup}</td>
      <td>${escapeHtml(storeContact(store) || "—")}</td>
      <td class="store-phone-cell">${escapeHtml(storePhone(store) || "—")}</td>
      <td>${escapeHtml(storeAddress(store) || "—")}</td>
    </tr>`;
  }

  function renderRows(targetId, countId, stores, emptyText) {
    $(countId).textContent = `${stores.length} 家`;
    $(targetId).innerHTML = stores.length
      ? stores.map(storeRow).join("")
      : `<tr><td colspan="4" class="store-directory-empty">${escapeHtml(emptyText)}</td></tr>`;
  }

  function render() {
    const query = normalizedPhone(state.appliedPhone);
    const matching = state.stores.filter((store) => !query || normalizedPhone(storePhone(store)).includes(query));
    const active = matching.filter((store) => !isArchived(store));
    const archived = matching.filter(isArchived);
    const suffix = query ? "没有联系电话匹配的" : "暂无";
    renderRows("activeStoreRows", "activeStoreCount", active, `${suffix}活跃门店`);
    renderRows("archivedStoreRows", "archivedStoreCount", archived, `${suffix}封存门店`);
  }

  function renderLoadError(error) {
    const message = error?.message || "门店数据读取失败，请刷新页面后重试。";
    $("activeStoreCount").textContent = "读取失败";
    $("archivedStoreCount").textContent = "读取失败";
    $("activeStoreRows").innerHTML = `<tr><td colspan="4" class="store-directory-empty error-text">${escapeHtml(message)}</td></tr>`;
    $("archivedStoreRows").innerHTML = `<tr><td colspan="4" class="store-directory-empty error-text">${escapeHtml(message)}</td></tr>`;
  }

  async function loadStores() {
    if (!window.CloudBasePhoneAuth?.listStores) {
      renderLoadError(new Error("门店数据库服务尚未加载，请刷新页面后重试。"));
      return;
    }
    try {
      state.stores = await window.CloudBasePhoneAuth.listStores();
      render();
    } catch (error) {
      console.warn("门店列表读取失败", error);
      renderLoadError(error);
    }
  }

  $("searchPeople").addEventListener("click", () => {
    state.appliedPhone = $("entityPhoneSearch").value.trim();
    render();
  });
  $("entityPhoneSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("searchPeople").click();
    }
  });
  $("addEntity").addEventListener("click", () => {
    window.location.href = "store-create.html";
  });

  void loadStores();
})();
