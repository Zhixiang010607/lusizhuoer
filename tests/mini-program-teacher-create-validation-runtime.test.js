const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture() {
  let page;
  const calls = [];
  const storage = new Map();
  const wx = {
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    redirectTo() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../miniprogram-app/miniprogram/pages/teacher-create/index.js"), "utf8"), {
    Page(value) { page = value; }, wx,
    require(id) {
      if (id.endsWith("/session")) return {};
      return { async callTeacherCreate(input) {
        calls.push(input);
        return { ok: true, completed: true, uid: "fixture-teacher", teacherId: "701", proof: { complete: true, authStatus: "ACTIVE", accountStatus: "ACTIVE", teacherStatus: "ACTIVE" } };
      } };
    }
  });
  page.setData = (changes) => {
    for (const [key, value] of Object.entries(changes)) {
      if (key.startsWith("form.")) page.data.form[key.slice(5)] = value;
      else page.data[key] = value;
    }
  };
  page.data.form = { name: "示例老师", phone: "13900000007", password: "Aa1!fixture" };
  return { page, calls, storage };
}

test("teacher creation identifies the invalid field and password requirement before calling the service", async () => {
  const cases = [
    ["name", "", /请输入老师姓名/],
    ["phone", "", /请输入联系电话/],
    ["phone", "139000", /11 位中国大陆手机号/],
    ["password", "", /请输入初始登录密码/],
    ["password", "Aa1!", /当前 4 位，至少需要 8 位/],
    ["password", "Aa1" + "x".repeat(30), /不能超过 32 位/],
    ["password", "!Aa12345", /首位必须是英文字母或数字/],
    ["password", "12345678", /目前包含 1 类.*大写字母、小写字母、特殊字符.*至少 2 类/],
    ["password", "Abcdefgh", /目前包含 2 类.*数字、特殊字符.*至少 1 类/]
  ];
  for (const [field, value, expected] of cases) {
    const { page, calls, storage } = fixture();
    page.data.form[field] = value;
    const originalPassword = page.data.form.password;
    await page.submit();
    assert.equal(page.data.validationField, field);
    assert.match(page.data.message, expected);
    assert.equal(page.data.form.password, originalPassword, "validation must not erase or rewrite the input");
    assert.equal(calls.length, 0);
    assert.equal(storage.size, 0, "invalid input must not create a pending operation");
  }
});

test("teacher password visibility preserves input and editing clears only the corresponding validation error", async () => {
  const { page } = fixture();
  page.data.form.password = "Abcdefgh";
  await page.submit();
  page.togglePassword();
  assert.equal(page.data.passwordVisible, true);
  assert.equal(page.data.form.password, "Abcdefgh");
  page.togglePassword();
  assert.equal(page.data.passwordVisible, false);
  page.input({ currentTarget: { dataset: { field: "name" } }, detail: { value: "示例老师甲" } });
  assert.equal(page.data.validationField, "password");
  page.input({ currentTarget: { dataset: { field: "password" } }, detail: { value: "Abcdefgh1" } });
  assert.equal(page.data.validationField, "");
  assert.equal(page.data.message, "");
  assert.equal(page.data.form.password, "Abcdefgh1");
  page.data.locked = true;
  page.togglePassword();
  assert.equal(page.data.passwordVisible, false);
});

test("valid teacher passwords keep the existing three-category rule and are submitted unchanged", async () => {
  for (const password of ["Abcdefg1", "A123456!", "a123456!", "Abcdefg!", "Aa1" + "x".repeat(29)]) {
    const { page, calls, storage } = fixture();
    page.data.form.password = password;
    page.togglePassword();
    await page.submit();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].initialPassword, password);
    assert.equal(page.data.passwordVisible, false, "submission should mask a previously revealed password");
    assert.equal(page.data.error, false);
    assert.equal(page.data.validationField, "");
    assert.equal(storage.size, 0);
  }
});
