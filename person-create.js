(() => {
  "use strict";
  const type = document.body.dataset.personCreate;
  const $ = (id) => document.getElementById(id);
  const config = type === "teacher"
    ? { prefix: "T", baseCount: 32, key: "prototypeCreatedTeachers", baseNames: Array.from({ length: 32 }, (_, index) => `业务老师 ${String(index + 1).padStart(2, "0")}`) }
    : { prefix: "OP", baseCount: 8, key: "prototypeCreatedOperations", baseNames: Array.from({ length: 8 }, (_, index) => `运营人员${index + 1}`) };

  function stored(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; }
  }

  function nextId() {
    const highest = stored(config.key).reduce((max, person) => Math.max(max, Number(String(person.id || "").replace(/\D/g, "")) || 0), config.baseCount);
    return `${config.prefix}${String(highest + 1).padStart(3, "0")}`;
  }

  function allIdentityNumbers() {
    const seededTeachers = Array.from({ length: 32 }, (_, index) => `1101011990${String(index + 1).padStart(8, "0")}`);
    const seededOperations = Array.from({ length: 8 }, (_, index) => `1101011988${String(index + 1).padStart(8, "0")}`);
    return new Set([...seededTeachers, ...seededOperations, ...stored("prototypeCreatedTeachers"), ...stored("prototypeCreatedOperations")]
      .map((person) => typeof person === "string" ? person : String(person.identityNumber || "").trim().toUpperCase())
      .filter(Boolean));
  }

  function displayNameFor(name) {
    const existing = [...config.baseNames, ...stored(config.key).map((person) => person.originalName || person.name)];
    const count = existing.filter((item) => item === name).length;
    return count ? `${name}+${count}` : name;
  }

  function strongInitialPassword() {
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const digits = "23456789";
    const special = "!@#$%^&*";
    const pick = (source) => source[Math.floor(Math.random() * source.length)];
    const password = [pick(upper), pick(lower), pick(digits), pick(special)];
    const all = upper + lower + digits + special;
    while (password.length < 12) password.push(pick(all));
    return password.sort(() => Math.random() - 0.5).join("");
  }

  async function submitPerson(event) {
    event.preventDefault();
    const name = $("personCreateName").value.trim();
    const identityNumber = $("personIdentityNumber").value.trim().toUpperCase();
    const phone = $("personPhone").value.trim();
    const message = $("personCreateMessage");
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');

    if (allIdentityNumbers().has(identityNumber)) {
      $("personIdentityNumber").setCustomValidity("身份证号码不可重复");
      $("personIdentityNumber").reportValidity();
      message.textContent = "身份证号码已存在";
      return;
    }
    $("personIdentityNumber").setCustomValidity("");

    const initialPassword = strongInitialPassword();
    submitButton.disabled = true;
    message.textContent = "正在创建真实登录账号…";
    try {
      if (!window.CloudBasePhoneAuth?.provisionStaff) throw new Error("账号服务未加载，请刷新页面后重试");
      await window.CloudBasePhoneAuth.provisionStaff({
        staffName: name,
        phone,
        role: type === "teacher" ? "teacher" : "operation",
        initialPassword
      });
    } catch (error) {
      message.textContent = error?.message || "账号创建失败";
      submitButton.disabled = false;
      return;
    }

    let session = null;
    try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
    const people = stored(config.key);
    const id = nextId();
    const displayName = displayNameFor(name);
    people.push({
      id, name: displayName, originalName: name, displayName, identityNumber, phone,
      account: `staff_${phone}`, password: initialPassword, status: "正常",
      createdAt: new Date().toISOString(),
      createdBy: { account: session?.account || "HQ001", name: session?.name || "总部管理员" }
    });
    sessionStorage.setItem(config.key, JSON.stringify(people));
    message.textContent = `创建成功：登录手机号 ${phone}；初始密码 ${initialPassword}。请立即安全交给本人并记录。`;
    event.currentTarget.reset();
    submitButton.disabled = false;
  }

  $("personIdentityNumber").addEventListener("input", () => {
    $("personIdentityNumber").setCustomValidity("");
    $("personCreateMessage").textContent = "";
  });
  $("generatedPersonCode").textContent = `编号 ${nextId()}（自动生成）`;
  $("personCreateForm").addEventListener("submit", submitPerson);
})();
