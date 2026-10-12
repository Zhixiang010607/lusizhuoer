const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const serviceSource = fs.readFileSync(path.join(root, "miniprogram-app/miniprogram/services/ble-verification.js"), "utf8");
const pageSource = fs.readFileSync(path.join(root, "miniprogram-app/miniprogram/pages/verification/index.js"), "utf8");

function harness(role, mode = "NORMAL") {
  const calls = [];
  const steps = [];
  const storage = new Map();
  const intent = { clientRequestId: "test-original-request", storeId: "17" };
  const qualification = { qualificationToken: "test-qualification", validSeconds: 80, unitCount: 1 };
  const session = { uid: "test-staff", role }; // Teacher deliberately has no bound store.
  const callFace = async (action, payload) => {
    calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
    if (action === "recoverVerificationBleQualification") return { found: true, ...qualification };
    if (action === "issueVerificationBleAuthorization") return { authorizationToken: "test-authorization", authCommand: { cmd: "authorize" } };
    if (action === "confirmVerificationBleWorkStarted") return { verificationId: "test-order", verificationCode: "test-code" };
    throw new Error(`unexpected action ${action}`);
  };
  const module = { exports: {} };
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key)
  };
  vm.runInNewContext(serviceSource, {
    module, require: (id) => id === "./api" ? { callFace } : { readSession: () => session },
    wx, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, console
  });
  const service = module.exports;
  let page;
  vm.runInNewContext(pageSource, {
    Page: (definition) => { page = definition; },
    require: (id) => {
      if (id.endsWith("/api")) return { callFace };
      if (id.endsWith("/session")) return { requireSession: () => session };
      if (id.endsWith("/ble-verification")) return service;
      if (id.endsWith("/submission")) return { read: () => intent, confirm: () => intent };
      throw new Error(id);
    }, wx, clearInterval, setInterval
  });
  page.data = { ...page.data, session, experience: mode === "EXPERIENCE", qualification, qualificationActive: true, qualificationSeconds: 80, unitCount: 1, store: { id: "999" } };
  page.setData = (data) => Object.assign(page.data, data);
  page.activateQualification = () => {};
  page.showRecovered = (result) => { page.recovered = result; };
  page.openSubmittedOrder = () => {};
  page.syncReady = () => {};
  const prototype = service.BleVerificationSession.prototype;
  prototype.scanQr = async () => { steps.push("scan"); return { sn: "test-serial", code: "test-qr" }; };
  for (const method of ["openAdapter", "discover", "connect", "discoverProtocol"]) {
    prototype[method] = async () => { steps.push(method); return {}; };
  }
  prototype.readInfo = async () => { steps.push("readInfo"); return { status: 0, device_id: "TEST-DEVICE", device_type: "LASER-BLE", nonce: "test-nonce" }; };
  prototype.validateInfo = (_qr, info) => info;
  prototype.waitFor = async () => ({ cmd: "auth_result", seq: 2, ok: true, status: 2 });
  prototype.write = async (command) => steps.push(command.cmd);
  prototype.closeConnection = async () => { steps.push("closeConnection"); };
  return { calls, steps, intent, qualification, service, page, storage };
}

test("store normal, teacher normal and teacher experience use identical BLE core and original store", async () => {
  const results = [];
  for (const [role, mode] of [["store", "NORMAL"], ["teacher", "NORMAL"], ["teacher", "EXPERIENCE"]]) {
    const h = harness(role, mode);
    await h.page.refreshQualificationForBle();
    await h.page.startBleVerification();
    assert.equal(h.page.data.error, false);
    assert.deepEqual(h.calls.map((call) => call.action), ["recoverVerificationBleQualification", "issueVerificationBleAuthorization", "confirmVerificationBleWorkStarted"]);
    assert.ok(h.calls.every((call) => call.payload.storeId === "17"));
    assert.equal(h.service.readProgress(), null); // Cleared only after confirmed order.
    results.push({ calls: h.calls, steps: h.steps });
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test("cold recovery uses original intent store, not the currently selected store", async () => {
  const h = harness("teacher", "EXPERIENCE");
  h.service.saveProgress({ authorizationToken: "test-authorization", deviceResult: { status: 2 } }); // Legacy receipt.
  await h.page.recoverPending();
  assert.equal(h.calls[0].action, "confirmVerificationBleWorkStarted");
  assert.equal(h.calls[0].payload.storeId, "17");
  assert.equal(h.page.recovered.verificationId, "test-order");
});

test("missing or conflicting store context never scans, authorizes or confirms", async () => {
  const h = harness("teacher");
  h.intent.storeId = "";
  await assert.rejects(h.page.refreshQualificationForBle(), { code: "BLE_STORE_CONTEXT_MISSING" });
  assert.equal(h.calls.length, 0);
  await assert.rejects(new h.service.BleVerificationSession({ qualification: {}, clientRequestId: "test" }).run(), { code: "BLE_STORE_CONTEXT_MISSING" });
  assert.ok(!h.steps.includes("scan"));
  await assert.rejects(h.service.retryFinalization({ storeId: "18", authorizationToken: "test", deviceResult: { status: 2 } }, "17"), { code: "BLE_STORE_CONTEXT_MISMATCH" });
  assert.equal(h.calls.length, 0);
});

test("store snapshot persists with authorization and cannot be changed mid-session", async () => {
  const h = harness("teacher");
  const session = new h.service.BleVerificationSession({ qualification: h.qualification, clientRequestId: h.intent.clientRequestId, storeId: h.intent.storeId });
  assert.equal(Reflect.set(session, "storeId", "999"), false);
  await session.finalize("test-authorization", { status: 2 });
  assert.equal(h.calls[0].payload.storeId, "17");
  assert.equal(h.service.readProgress().storeId, "17");
});

test("scan action has exactly two centered nonwrapping lines and keeps existing state bindings", () => {
  const wxml = fs.readFileSync(path.join(root, "miniprogram-app/miniprogram/pages/verification/index.wxml"), "utf8");
  const css = fs.readFileSync(path.join(root, "miniprogram-app/miniprogram/pages/verification/index.wxss"), "utf8");
  assert.match(wxml, /class="ble-start-label"><text>扫码设备二维码<\/text><text>开启蓝牙<\/text>/);
  assert.match(wxml, /bindtap="startBleVerification" loading="\{\{bleRunning\}\}" disabled=/);
  assert.match(css, /\.ble-start-label \{[^}]*flex-direction: column;[^}]*align-items: center;[^}]*justify-content: center/);
  assert.match(css, /\.ble-start-label text \{[^}]*white-space: nowrap/);
});

test("existing server reproduces the teacher-only missing-store failure and retains store-account isolation", async () => {
  const source = fs.readFileSync(path.join(root, "cloudfunctions/faceRecognition/index.js"), "utf8");
  const caller = source.slice(source.indexOf("async function activeBusinessCaller("), source.indexOf("async function activeCustomerCreationCaller("));
  const idHelper = source.slice(source.indexOf("function positiveDatabaseId("), source.indexOf("function rechargeSubmissionKey("));
  let role = "teacher";
  let storeActive = true;
  const context = {
    app: () => ({ auth: () => ({ getUserInfo: () => ({ uid: "test-staff" }) }) }),
    sqlText: (value) => `'${value}'`,
    fail: (message, code) => { throw Object.assign(new Error(message), { code }); },
    activeStoreCaller: async () => ({ storeId: 17, staffId: 4 }),
    executeSql: async (sql) => sql.includes("public.staff_accounts")
      ? [{ staff_id: 4, role_code: role, account_status: "ACTIVE", teacher_id: 5, teacher_status: "ACTIVE" }]
      : (storeActive ? [{ id: 17, store_status: "ACTIVE" }] : [])
  };
  vm.createContext(context);
  vm.runInContext(`${idHelper}\n${caller}`, context);
  await assert.rejects(context.activeBusinessCaller({}), { code: "BAD_REQUEST", message: "必须选择有效的门店。" });
  assert.equal((await context.activeBusinessCaller({ storeId: "17" })).storeId, 17);
  storeActive = false;
  await assert.rejects(context.activeBusinessCaller({ storeId: "17" }), { code: "STORE_NOT_ACTIVE" });
  role = "store";
  assert.equal((await context.activeBusinessCaller({})).storeId, 17);
  await assert.rejects(context.activeBusinessCaller({ storeId: "18" }), { code: "FORBIDDEN" });
});
