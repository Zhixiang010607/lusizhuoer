(() => {
  "use strict";
  const type = document.body.dataset.personCreate;
  const $ = (id) => document.getElementById(id);
  const config = type === "teacher"
    ? { prefix: "T", baseCount: 32, key: "prototypeCreatedTeachers", baseNames: Array.from({ length: 32 }, (_, index) => `业务老师 ${String(index + 1).padStart(2, "0")}`) }
    : type === "hq"
      ? { prefix: "HQ", baseCount: 1, key: "prototypeCreatedHeadquarters", baseNames: ["总部管理员"] }
      : { prefix: "OP", baseCount: 8, key: "prototypeCreatedOperations", baseNames: Array.from({ length: 8 }, (_, index) => `运营人员${index + 1}`) };

  function stored(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; }
  }

  function nextId() {
    const highest = stored(config.key).reduce((max, person) => Math.max(max, Number(String(person.id || "").replace(/\D/g, "")) || 0), config.baseCount);
    return `${config.prefix}${String(highest + 1).padStart(3, "0")}`;
  }

  function displayNameFor(name) {
    const existing = [...config.baseNames, ...stored(config.key).map((person) => person.originalName || person.name)];
    const count = existing.filter((item) => item === name).length;
    return count ? `${name}+${count}` : name;
  }

  async function submitPerson(event) {
    event.preventDefault();
    const name = $("personCreateName").value.trim();
    const phone = $("personPhone").value.trim();
    const message = $("personCreateMessage");
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');

    const initialPassword = $("personInitialPassword").value;
    const passwordGroups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(initialPassword)).length;
    if (initialPassword.length < 8 || initialPassword.length > 32 || passwordGroups < 3) {
      message.textContent = "初始密码需为 8–32 位，并包含大写、小写、数字、特殊字符中的至少三类";
      return;
    }
    submitButton.disabled = true;
    message.textContent = "正在创建真实登录账号…";
    let provisioned;
    try {
      if (!window.CloudBasePhoneAuth?.provisionStaff) throw new Error("账号服务未加载，请刷新页面后重试");
      provisioned = await window.CloudBasePhoneAuth.provisionStaff({
        staffName: name,
        phone,
        role: type === "teacher" ? "teacher" : type === "hq" ? "hq" : "operation",
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
      id, name: displayName, originalName: name, displayName, phone,
      account: `staff_${phone}`, authUid: provisioned.uid, status: "活跃",
      createdAt: new Date().toISOString(),
      createdBy: { account: session?.account || "HQ001", name: session?.name || "总部管理员" }
    });
    sessionStorage.setItem(config.key, JSON.stringify(people));
    const recovered = provisioned.authAccount === "recovered";
    message.textContent = recovered
      ? `业务账号已恢复并绑定：登录手机号 ${phone}。原有登录密码未被覆盖。`
      : `创建成功：登录手机号 ${phone}。账号已自动绑定，初始密码请安全交给本人。`;
    if (provisioned.warning) message.textContent += ` ${provisioned.warning}`;
    event.currentTarget.reset();
    submitButton.disabled = false;
  }

  $("generatedPersonCode").textContent = `编号 ${nextId()}（自动生成）`;
  $("personCreateForm").addEventListener("submit", submitPerson);
})();
