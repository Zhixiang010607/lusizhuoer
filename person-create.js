(() => {
  "use strict";
  const type = document.body.dataset.personCreate;
  const $ = (id) => document.getElementById(id);
  const config = type === "teacher"
    ? { prefix: "T", baseCount: 32, key: "prototypeCreatedTeachers", returnPage: "teacher-management.html", baseNames: Array.from({ length: 32 }, (_, i) => `业务老师 ${String(i + 1).padStart(2, "0")}`) }
    : { prefix: "OP", baseCount: 8, key: "prototypeCreatedOperations", returnPage: "operation-account-management.html", baseNames: Array.from({ length: 8 }, (_, i) => `运营人员${i + 1}`) };

  function stored(key) { try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; } }
  function nextId() {
    const highest = stored(config.key).reduce((max, person) => Math.max(max, Number(String(person.id || "").replace(/\D/g, "")) || 0), config.baseCount);
    return `${config.prefix}${String(highest + 1).padStart(3, "0")}`;
  }
  function allIdentityNumbers() {
    const seededTeachers = Array.from({ length: 32 }, (_, i) => `1101011990${String(i + 1).padStart(8, "0")}`);
    const seededOperations = Array.from({ length: 8 }, (_, i) => `1101011988${String(i + 1).padStart(8, "0")}`);
    return new Set([...seededTeachers, ...seededOperations, ...stored("prototypeCreatedTeachers"), ...stored("prototypeCreatedOperations")].map((person) => typeof person === "string" ? person : String(person.identityNumber || "").trim().toUpperCase()).filter(Boolean));
  }
  function displayNameFor(name) {
    const existing = [...config.baseNames, ...stored(config.key).map((person) => person.originalName || person.name)];
    const count = existing.filter((item) => item === name).length;
    return count ? `${name}+${count}` : name;
  }
  function submitPerson(event) {
    event.preventDefault();
    const name = $("personCreateName").value.trim(), identityNumber = $("personIdentityNumber").value.trim().toUpperCase(), phone = $("personPhone").value.trim();
    if (allIdentityNumbers().has(identityNumber)) {
      $("personIdentityNumber").setCustomValidity("身份证号码不可重复");
      $("personIdentityNumber").reportValidity();
      $("personCreateMessage").textContent = "身份证号码已存在";
      return;
    }
    $("personIdentityNumber").setCustomValidity("");
    let session = null;
    try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
    const people = stored(config.key), id = nextId();
    const displayName = displayNameFor(name);
    people.push({ id, name: displayName, originalName: name, displayName, identityNumber, phone, account: type === "operation" ? id : "", password: type === "operation" ? randomPassword() : "", status: "正常", createdAt: new Date().toISOString(), createdBy: { account: session?.account || "HQ001", name: session?.name || "总部管理员" } });
    sessionStorage.setItem(config.key, JSON.stringify(people));
    location.href = `${config.returnPage}?created=${encodeURIComponent(id)}`;
  }
  function randomPassword() { return Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join(""); }
  $("personIdentityNumber").addEventListener("input", () => { $("personIdentityNumber").setCustomValidity(""); $("personCreateMessage").textContent = ""; });
  $("generatedPersonCode").textContent = `编号 ${nextId()}（自动生成）`;
  $("personCreateForm").addEventListener("submit", submitPerson);
})();
