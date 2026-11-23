"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const test = require("node:test");
const root = path.resolve(__dirname, "..");
const client = fs.readFileSync(path.join(root, "miniprogram-app/miniprogram/services/ble-verification.js"), "utf8");
const server = fs.readFileSync(path.join(root, "cloudfunctions/faceRecognition/index.js"), "utf8");
const ble = require(path.join(root, "miniprogram-app/miniprogram/services/ble-verification.js"));
const baseline = require("./fixtures/ble-existing-three-wire-v145.json");
const nonce = "00112233445566778899aabbccddeeff";
const signature = "41638537597196183052aecgeigdifkh";
const serial = "LA001122334455";
const originalTypes = Object.keys(baseline.normalizedWireAndServerCallSha256);
const futureTypes = ["ceshixiangmu", "xinxiangmu2", "fifthproject", "sixthproject2027"];

function declaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const from = source.slice(start - 6, start) === "async " ? start - 6 : start;
  return source.slice(from, source.indexOf("\n}", from) + 2);
}
function classification(source) {
  return new Function(`${declaration(source, "isHc08CompactDeviceType")}\n${declaration(source, "isAutomaticHc08DeviceType")}\nreturn { original: isHc08CompactDeviceType, automatic: isAutomaticHc08DeviceType };`)();
}
const clientTypes = classification(client);
const serverTypes = classification(server);
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };

test("original fixed group is unchanged; future names select the independent automatic group", () => {
  for (const type of originalTypes) {
    assert.equal(clientTypes.original(type), true);
    assert.equal(clientTypes.automatic(type), false);
    assert.equal(serverTypes.automatic(type), false);
  }
  for (const type of futureTypes.concat(Array.from({ length: 25 }, (_, i) => `futureproject${i}`))) {
    assert.equal(clientTypes.original(type), false);
    assert.equal(clientTypes.automatic(type), true);
    assert.equal(serverTypes.automatic(type), true);
    assert.equal(ble.BLE_GATT_PROFILES[type.toUpperCase()], undefined, "no per-project registration");
  }
  for (const type of ["", " ", "other-device", "项目", "a".repeat(129), "a/b", "a\nb"]) {
    assert.equal(clientTypes.automatic(type), false);
    assert.equal(serverTypes.automatic(type), false);
  }
});

// Reuse the existing end-to-end wire simulator. The golden digest was captured
// from v145 before this change, including actual 20-byte fragments and calls.
const replaySource = fs.readFileSync(path.join(root, "tests/ble-three-project-profiles.test.js"), "utf8");
const replay = new Function("assert", "fs", "path", "root", "vm", "nonce", "signature", "serial",
  `${declaration(replaySource, "replayWireProtocol")}\nreturn replayWireProtocol;`
)(assert, fs, path, root, vm, nonce, signature, serial);

test("all original three retain their pre-change wire bytes and authorization/finalization calls", async () => {
  for (const type of originalTypes) {
    const digest = crypto.createHash("sha256").update(await replay(type)).digest("hex");
    assert.equal(digest, baseline.normalizedWireAndServerCallSha256[type], type);
  }
});

test("four arbitrary future projects reproduce the exact same wire and single finalization", async () => {
  for (const type of futureTypes) {
    const digest = crypto.createHash("sha256").update(await replay(type)).digest("hex");
    assert.equal(digest, baseline.normalizedWireAndServerCallSha256["LASER-BLE"], type);
  }
});

test("future project retains fixed UUID selection despite unrelated writable services", async t => {
  const oldWx = global.wx;
  const queried = [];
  global.wx = {
    getBLEDeviceServices({ success }) { success({ services: [{ uuid: "OTHER" }, { uuid: "0000FFE0-0000-1000-8000-00805F9B34FB" }] }); },
    getBLEDeviceCharacteristics({ serviceId, success }) {
      queried.push(serviceId);
      success({ characteristics: [{ uuid: "0000FFE1-0000-1000-8000-00805F9B34FB", properties: { write: true, writeNoResponse: true, notify: true } }] });
    },
    onBLECharacteristicValueChange() {},
    notifyBLECharacteristicValueChange({ success }) { success({}); }
  };
  t.after(() => { global.wx = oldWx; });
  const session = new ble.BleVerificationSession({ qualification: { expectedDeviceType: futureTypes[0] } });
  session.deviceId = "isolated-device";
  await session.discoverProtocol();
  assert.deepEqual(queried, ["0000FFE0-0000-1000-8000-00805F9B34FB"]);
  assert.equal(session.writeType, "writeNoResponse");
});

test("future project retries only the same q=1 and retains identity/state/nonce boundaries", async () => {
  const session = new ble.BleVerificationSession({ qualification: { expectedDeviceType: futureTypes[0] } });
  session.infoRetryAfterMs = 5;
  session.infoTimeoutMs = 200;
  const writes = [];
  session.write = async payload => {
    writes.push(payload);
    if (writes.length === 1) { session.receivePacketCount += 1; session.receiveBuffer = '{"q":1'; }
    else {
      assert.equal(session.receiveBuffer, "");
      session.dispatch({ q: 1, c: "i", s: 1, n: nonce });
    }
  };
  const info = await session.readInfo();
  assert.deepEqual(writes, [{ q: 1 }, { q: 1 }]);
  session.connectedBleName = "LA-334455";
  assert.equal(session.validateInfo({ sn: serial }, info).device_type, futureTypes[0]);
  assert.throws(() => session.validateInfo({ sn: "NCM00112233445" }, info), { code: "BLE_DEVICE_TYPE_MISMATCH" });
  assert.throws(() => session.validateInfo({ sn: serial }, { ...info, n: "bad" }), { code: "BLE_NONCE_INVALID" });
  assert.throws(() => session.validateInfo({ sn: serial }, { ...info, s: 3 }), { code: "BLE_DEVICE_NOT_READY" });
  session.connectedBleName = "LA-000000";
  assert.throws(() => session.validateInfo({ sn: serial }, info), { code: "BLE_NAME_MISMATCH" });
  session.connectedBleName = "LA-334455";
  assert.throws(() => session.validateInfo({ sn: serial }, { device_id: serial, device_type: futureTypes[1], ble_name: "LA-334455", nonce, status: 1 }), { code: "BLE_DEVICE_TYPE_MISMATCH" });
});

test("new server group still requires the qualification's exact type, LA identity and standby state", async () => {
  const type = futureTypes[0];
  const stop = new Error("passed original guards, reached unchanged reservation path");
  const support = new Function(`${declaration(server, "isSupportedVerificationDeviceSerial")}\n${declaration(server, "verificationBleName")}\nreturn { isSupportedVerificationDeviceSerial, verificationBleName };`)();
  const issue = new Function("activeBusinessCaller", "requireVerificationBleSchema", "executeSql", "sqlText", "fail",
    "isSupportedVerificationDeviceSerial", "verificationBleName", "isHc08CompactDeviceType", "isAutomaticHc08DeviceType",
    `${declaration(server, "issueVerificationBleAuthorization")}\nreturn issueVerificationBleAuthorization;`
  )(async () => ({ storeId: "1", staffId: "2" }), async () => {}, async sql => {
    if (sql.includes("SELECT qualification.*")) return [{ id: "3", expected_device_type: type, valid_seconds: 90 }];
    throw stop;
  }, value => `'${value}'`, fail, support.isSupportedVerificationDeviceSerial, support.verificationBleName,
  serverTypes.original, serverTypes.automatic);
  const event = { qualificationToken: "a".repeat(48), qrSn: serial, qrCode: "123456",
    deviceInfo: { device_id: serial, device_type: type, ble_name: "LA-334455", nonce, status: 1 } };
  await assert.rejects(issue(event), e => e === stop);
  await assert.rejects(issue({ ...event, deviceInfo: { ...event.deviceInfo, device_type: futureTypes[1] } }), { code: "BLE_DEVICE_TYPE_MISMATCH" });
  await assert.rejects(issue({ ...event, qrSn: "NCM00112233445", deviceInfo: { ...event.deviceInfo, device_id: "NCM00112233445", ble_name: "NCM-233445" } }), { code: "BLE_DEVICE_TYPE_MISMATCH" });
  await assert.rejects(issue({ ...event, deviceInfo: { ...event.deviceInfo, status: 2 } }), { code: "BLE_DEVICE_NOT_READY" });
});
