"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const clientSource = read("store-create.js");
const storeHtml = read("store-create.html");
const staffSource = read("cloudfunctions/staffAccount/index.js");

function sourceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} must remain independently testable`);
  return source.slice(start, end);
}

function failed(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const clientPasswordSource = sourceBetween(
  clientSource,
  "function validateInitialPassword(value)",
  "\n\n  function pendingStoreKey",
  "store password validator"
);
const serverPasswordSource = sourceBetween(
  staffSource,
  "function validatePassword(password)",
  "\n\nfunction strictDashboardDate",
  "server password validator"
);
const dispatcherSource = sourceBetween(
  staffSource,
  "async function main(event = {}, context = {}) {",
  "\n// Keep master-data status",
  "staffAccount dispatcher"
);

function loadFunction(source, exportName, additions = {}) {
  const context = { module: { exports: {} }, ...additions };
  vm.createContext(context);
  vm.runInContext(`${source}\nmodule.exports = ${exportName};`, context);
  return context.module.exports;
}

const validateInitialPassword = loadFunction(clientPasswordSource, "validateInitialPassword");
const validatePassword = loadFunction(serverPasswordSource, "validatePassword", { fail: failed });

for (const validate of [validateInitialPassword, validatePassword]) {
  assert.equal(validate("A!bc1234"), "A!bc1234", "a compliant password remains accepted");
  assert.equal(validate("1!Abcdef"), "1!Abcdef", "a password may start with a number");
  assert.throws(
    () => validate("!Abc12345"),
    (error) => /不能以特殊字符开头/.test(error.message),
    "a leading punctuation mark must receive the Chinese policy message"
  );
  assert.throws(
    () => validate(" Abc12345"),
    (error) => /不能以特殊字符开头/.test(error.message),
    "leading whitespace must not bypass the CloudBase first-character rule"
  );
}

assert.throws(
  () => validatePassword("!Abc12345"),
  (error) => error.code === "PASSWORD_START_INVALID",
  "the server returns a stable password-policy error code"
);
assert.match(storeHtml, /首位为字母或数字/, "the form explains the first-character rule before submission");
assert.match(storeHtml, /store-create\.js\?v=0\.2\.0/, "the fixed client script is cache-busted");

function clientFormHarness() {
  const elements = {};
  const submitButton = { disabled: false };
  const element = (id) => {
    if (!elements[id]) {
      elements[id] = {
        value: "",
        innerHTML: "",
        textContent: "",
        disabled: false,
        listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        querySelector(selector) { return selector === 'button[type="submit"]' ? submitButton : null; }
      };
    }
    return elements[id];
  };
  const state = { apiCalls: 0 };
  const windowObject = {
    ChinaRegions: { 北京市: { 市辖区: ["西城区"] } },
    CloudBasePhoneAuth: {
      async createStoreWithAccount() {
        state.apiCalls += 1;
        return { store: { id: 9, code: "STR000009" } };
      }
    },
    setTimeout() {}
  };
  const context = {
    window: windowObject,
    document: { getElementById: element },
    location: { href: "" },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  };
  vm.createContext(context);
  vm.runInContext(clientSource, context, { filename: "store-create-client-runtime.js" });
  Object.assign(element("storeCreateName"), { value: "测试门店" });
  Object.assign(element("storeCreateProvince"), { value: "北京市" });
  Object.assign(element("storeCreateCity"), { value: "市辖区" });
  Object.assign(element("storeCreateDistrict"), { value: "西城区" });
  Object.assign(element("storeCreateAddress"), { value: "测试地址" });
  Object.assign(element("storeContactName"), { value: "测试联系人" });
  Object.assign(element("storeContactPhone"), { value: "13900000009" });
  Object.assign(element("storeInitialPassword"), { value: "!Abc12345" });
  return { elements, state, submitButton };
}

function dispatcherHarness() {
  const state = {
    sqlWrites: 0,
    identityWrites: 0,
    phonePreflights: 0,
    storeWrites: 0
  };
  const context = {
    module: { exports: {} },
    console: { error() {}, warn() {} },
    FUNCTION_VERSION: "test",
    TEACHER_EXPERIENCE_RESET_TIMER_TRIGGER_NAME: "test",
    ROLES: new Set(["hq", "store", "teacher"]),
    handleTrustedTeacherExperienceResetTimer: async () => null,
    handleTrustedTeacherFaceReconcileTimer: async () => null,
    currentUser: async () => ({ uid: "hq-auth", profile: { role: "hq", staffId: "1" } }),
    requireHq(caller) {
      if (caller?.profile?.role !== "hq") failed("FORBIDDEN", "FORBIDDEN");
    },
    validatePhone: (value) => String(value || ""),
    validatePassword,
    storeInputFromEvent: (event) => ({
      storeName: String(event.storeName || ""),
      province: "北京市",
      city: "市辖区",
      district: "西城区",
      addressDetail: "测试地址",
      contactName: String(event.contactName || ""),
      contactPhone: String(event.contactPhone || ""),
      existingStoreId: ""
    }),
    assertPhoneCanUseRole: async () => {
      state.phonePreflights += 1;
      return null;
    },
    createOrRecoverStore: async () => {
      state.storeWrites += 1;
      return { id: "9", code: "STR000009" };
    },
    manager: () => ({
      user: {
        createUser: async () => {
          state.identityWrites += 1;
          return { Data: { Uid: "created-user" } };
        }
      }
    }),
    executeSql: async () => {
      state.sqlWrites += 1;
      return [];
    },
    fail: failed
  };
  vm.createContext(context);
  vm.runInContext(`${dispatcherSource}\nmodule.exports = main;`, context, {
    filename: "staffAccount-store-password-runtime.js"
  });
  return { state, main: context.module.exports };
}

(async () => {
  {
    const { elements, state, submitButton } = clientFormHarness();
    await elements.storeCreateForm.listeners.submit({
      preventDefault() {},
      currentTarget: elements.storeCreateForm
    });
    assert.equal(state.apiCalls, 0, "the browser must reject a special-leading password without calling CloudBase");
    assert.equal(submitButton.disabled, false, "client validation must leave the form available for correction");
    assert.match(elements.storeCreateMessage.textContent, /不能以特殊字符开头/,
      "the form displays the Chinese password-policy message");
  }

  for (const event of [
    {
      action: "createStoreWithAccount",
      storeName: "测试门店",
      contactName: "测试联系人",
      contactPhone: "13900000009",
      initialPassword: "!Abc12345"
    },
    {
      action: "provisionStaff",
      staffName: "测试联系人",
      phone: "13900000009",
      role: "store",
      storeId: "9",
      initialPassword: "!Abc12345"
    }
  ]) {
    const { state, main } = dispatcherHarness();
    await assert.rejects(
      main(event),
      (error) => error.code === "PASSWORD_START_INVALID" && /不能以特殊字符开头/.test(error.message)
    );
    assert.deepEqual(state, {
      sqlWrites: 0,
      identityWrites: 0,
      phonePreflights: 0,
      storeWrites: 0
    }, `${event.action} must reject the password before any account or database mutation`);
  }

  console.log("store password policy contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
