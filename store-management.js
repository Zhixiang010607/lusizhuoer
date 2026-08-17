(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { stores: [], searched: false, name: "", phone: "" };

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

  function storeName(store) {
    return String(store.store_name || store.name || "").trim();
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
    return String(store.id || store.store_code || store.auth_uid || "").trim();
  }

  function storeRow(store) {
    const reference = storeReference(store);
    const name = storeName(store) || "未命名门店";
    const archived = isArchived(store);
    const nameMarkup = reference
      ? `<a class="record-link store-global-link" href="store-detail.html?storeId=${encodeURIComponent(reference)}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    return `<tr>
      <td>${nameMarkup}</td>
      <td>${escapeHtml(storeContact(store) || "—")}</td>
      <td class="store-phone-cell">${escapeHtml(storePhone(store) || "—")}</td>
      <td>${escapeHtml(storeAddress(store) || "—")}</td>
      <td><span class="store-status-badge ${archived ? "archived" : "active"}">${archived ? "封存" : "活跃"}</span></td>
    </tr>`;
  }

  function renderRows(targetId, countId, stores, emptyText) {
    $(countId).textContent = `${stores.length} 家`;
    $(targetId).innerHTML = stores.length
      ? stores.map(storeRow).join("")
      : `<tr><td colspan="5" class="store-directory-empty">${escapeHtml(emptyText)}</td></tr>`;
  }

  function renderDirectories() {
    renderRows("activeStoreRows", "activeStoreCount", state.stores.filter((store) => !isArchived(store)), "暂无活跃门店");
    renderRows("archivedStoreRows", "archivedStoreCount", state.stores.filter(isArchived), "暂无封存门店");
  }

  function renderSearchResults() {
    if (!state.searched) {
      renderRows("searchStoreRows", "searchStoreCount", [], "尚未查询");
      return;
    }
    const name = state.name.toLocaleLowerCase("zh-CN");
    const phone = normalizedPhone(state.phone);
    if (!name && !phone) {
      renderRows("searchStoreRows", "searchStoreCount", [], "请输入门店名称或联系人电话后查询");
      return;
    }
    const matches = state.stores.filter((store) => {
      const matchesName = !name || storeName(store).toLocaleLowerCase("zh-CN").includes(name);
      const matchesPhone = !phone || normalizedPhone(storePhone(store)).includes(phone);
      return matchesName && matchesPhone;
    });
    renderRows("searchStoreRows", "searchStoreCount", matches, "没有符合条件的门店");
  }

  function renderLoadError(error) {
    const message = error?.message || "门店数据读取失败，请刷新页面后重试。";
    ["activeStoreCount", "archivedStoreCount", "searchStoreCount"].forEach((id) => { $(id).textContent = "读取失败"; });
    ["activeStoreRows", "archivedStoreRows", "searchStoreRows"].forEach((id) => {
      $(id).innerHTML = `<tr><td colspan="5" class="store-directory-empty error-text">${escapeHtml(message)}</td></tr>`;
    });
  }

  async function loadStores() {
    if (!window.CloudBasePhoneAuth?.listStores) {
      renderLoadError(new Error("门店数据库服务尚未加载，请刷新页面后重试。"));
      return;
    }
    try {
      const records = await window.CloudBasePhoneAuth.listStores();
      state.stores = Array.isArray(records) ? records : [];
      renderDirectories();
      renderSearchResults();
    } catch (error) {
      console.warn("门店列表读取失败", error);
      renderLoadError(error);
    }
  }

  function search() {
    state.name = $("entityNameSearch").value.trim();
    state.phone = $("entityPhoneSearch").value.trim();
    state.searched = true;
    renderSearchResults();
  }

  $("searchPeople").addEventListener("click", search);
  ["entityNameSearch", "entityPhoneSearch"].forEach((id) => {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        search();
      }
    });
  });
  $("addEntity").addEventListener("click", () => {
    window.location.href = "store-create.html";
  });

  void loadStores();
})();
