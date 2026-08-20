"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const wrapper = fs.readFileSync(path.join(root, "cloudbase-phone-auth.js"), "utf8");
const page = fs.readFileSync(path.join(root, "teacher-create.js"), "utf8");

assert.match(wrapper, /const TEACHER_CREATE_WATCHDOG_MS = 135 \* 1000/,
  "the browser observer must outlive the cloud function's 120-second ceiling");
assert.match(wrapper,
  /async createTeacherWithFace\(\{[\s\S]{0,320}const request = callTeacherCreate\([\s\S]{0,360}action: "createTeacher"[\s\S]{0,600}promiseWithWatchdog\(request/,
  "the wrapper must issue one teacherCreate/createTeacher request and only observe that promise");
assert.match(wrapper, /getApp\(\)\.callFunction\(\{ name: "teacherCreate", data \}\)/,
  "teacher creation must target the dedicated small cloud function");

for (const source of [page, wrapper.slice(
  wrapper.indexOf("async createTeacherWithFace"),
  wrapper.indexOf("async upsertTeacherFace")
)]) {
  for (const legacy of [
    "beginTeacherProvisionWithFace", "provisionTeacherWithFace", "getTeacherFaceOperationStatus",
    "readTeacherProvisionResult", "operationId", "teacherProvisionStatusFlights",
    "teacherProvisionResultFlights"
  ]) {
    assert.equal(source.includes(legacy), false, `active create path must not retain ${legacy}`);
  }
  assert.doesNotMatch(source, /\bwhile\s*\(|setInterval\s*\(|\.callFunction\([\s\S]{0,120}staffAccount/,
    "active create path must not poll, run a worker or invoke staffAccount");
}

const requests = [];
const sandbox = {
  window: {
    setTimeout,
    clearTimeout,
    CloudBaseAuthConfig: { env: "test" },
    registerAuth: () => {},
    registerFunctions: () => {},
    cloudbase: {
      init: () => ({
        callFunction: async (request) => {
          requests.push(request);
          return {
            result: {
              ok: true,
              completed: true,
              uid: "teacher-auth-13900000007",
              teacherId: "77",
              proof: {
                complete: true,
                teacherStatus: "ACTIVE",
                accountStatus: "ACTIVE",
                authStatus: "ACTIVE",
                faceStatus: "ENROLLED",
                faceId: "face-77",
                personId: "T-777777777777777777777777777777777777777777777777",
                photoRef: "pg://private/teachers/77/profile/original.jpg",
                photoSha256: "ab".repeat(32),
                photoBytes: 6
              }
            }
          };
        }
      })
    }
  },
  setTimeout,
  clearTimeout,
  console
};
vm.createContext(sandbox);
vm.runInContext(wrapper, sandbox, { filename: "cloudbase-phone-auth-one-call.js" });

(async () => {
  const payload = {
    staffName: "单调用老师",
    phone: "13900000007",
    initialPassword: "Aa1!aaaa",
    faceImageBase64: "data:image/jpeg;base64,/9j/2Q==",
    clientRequestId: "teacher_create_one_call_0001",
    consent: true
  };
  async function wrapperFailure(callFunction) {
    const subject = {
      window: {
        setTimeout,
        clearTimeout,
        CloudBaseAuthConfig: { env: "test" },
        registerAuth: () => {},
        registerFunctions: () => {},
        cloudbase: { init: () => ({ callFunction }) }
      },
      setTimeout,
      clearTimeout,
      console
    };
    vm.createContext(subject);
    vm.runInContext(wrapper, subject, { filename: "cloudbase-phone-auth-failure-contract.js" });
    try {
      await subject.window.CloudBasePhoneAuth.createTeacherWithFace(payload);
    } catch (error) {
      return error;
    }
    throw new Error("expected wrapper failure");
  }

  const rawFailure = await wrapperFailure(async () => {
    throw Object.assign(new Error("connection reset"), { code: "FUNCTIONS_INVOCATION_FAILED" });
  });
  assert.equal(rawFailure.transportUncertain, true,
    "a rejected SDK promise has no authoritative function outcome");

  const gatewayFailure = await wrapperFailure(async () => ({
    errMsg: "gateway returned an invalid envelope", requestId: "gateway-1"
  }));
  assert.equal(gatewayFailure.transportUncertain, true,
    "a gateway envelope without explicit function ok=false remains uncertain");

  const badRequest = await wrapperFailure(async () => ({
    result: { ok: false, code: "BAD_REQUEST", message: "invalid teacher name" }
  }));
  assert.equal(badRequest.transportUncertain, false,
    "an explicit ordinary function failure is authoritative and may be corrected");

  const cleanupIncomplete = await wrapperFailure(async () => ({
    result: {
      ok: false,
      code: "TEACHER_CREATE_CLEANUP_INCOMPLETE",
      message: "cleanup incomplete"
    }
  }));
  assert.equal(cleanupIncomplete.transportUncertain, true,
    "cleanup-incomplete must lock the page because a partial identity may remain");

  const result = await sandbox.window.CloudBasePhoneAuth.createTeacherWithFace(payload);
  assert.equal(result.completed, true);
  assert.equal(requests.length, 1, "one click must produce exactly one cloud invocation");
  assert.equal(requests[0].name, "teacherCreate");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].data)), {
    action: "createTeacher",
    staffName: payload.staffName,
    phone: payload.phone,
    initialPassword: payload.initialPassword,
    imageBase64: payload.faceImageBase64,
    clientRequestId: payload.clientRequestId,
    consent: true
  });

  async function pageFailureScenario({ callFunction, uuid, phone }) {
    let calls = 0;
    const nodes = new Map();
    function node(id) {
      if (nodes.has(id)) return nodes.get(id);
      const value = {
        id,
        value: "",
        checked: false,
        disabled: false,
        hidden: false,
        textContent: "",
        className: "",
        width: 0,
        height: 0,
        srcObject: null,
        videoWidth: id === "teacherFaceCamera" ? 600 : 0,
        videoHeight: id === "teacherFaceCamera" ? 800 : 0,
        attributes: {},
        listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
        setAttribute(name, content) { this.attributes[name] = String(content); },
        removeAttribute(name) { delete this.attributes[name]; },
        getContext() { return { drawImage: () => {} }; },
        toDataURL() { return "data:image/jpeg;base64,/9j/2Q=="; },
        play: async () => {}
      };
      nodes.set(id, value);
      return value;
    }
    const stream = { getTracks: () => [{ stop: () => {} }] };
    const uncertainWindow = {
      setTimeout,
      clearTimeout,
      crypto: { randomUUID: () => uuid },
      location: { assign: () => { throw new Error("failed request must not redirect"); } },
      addEventListener: () => {},
      CloudBaseAuthConfig: { env: "test" },
      registerAuth: () => {},
      registerFunctions: () => {},
      cloudbase: {
        init: () => ({
          callFunction: async () => {
            calls += 1;
            return callFunction();
          }
        })
      }
    };
    const uncertainSandbox = {
      window: uncertainWindow,
      document: {
        getElementById: node,
        createElement: () => node(`generated-${nodes.size}`)
      },
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
      setTimeout,
      clearTimeout,
      console
    };
    vm.createContext(uncertainSandbox);
    vm.runInContext(wrapper, uncertainSandbox, { filename: "cloudbase-phone-auth-uncertain.js" });
    vm.runInContext(page, uncertainSandbox, { filename: "teacher-create-uncertain.js" });

    node("personCreateName").value = "失败合同老师";
    node("personPhone").value = phone;
    node("personInitialPassword").value = "Aa1!aaaa";
    node("teacherFaceConsent").checked = true;
    node("openTeacherFaceCamera").listeners.click();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    node("captureTeacherFace").listeners.click();
    const submitEvent = { preventDefault: () => {}, currentTarget: node("personCreateForm") };
    await node("personCreateForm").listeners.submit(submitEvent);
    return {
      calls: () => calls,
      node,
      submitAgain: () => node("personCreateForm").listeners.submit(submitEvent)
    };
  }

  // A raw SDK rejection has no status row to poll. It is still an ambiguous
  // transport outcome: the wrapper must mark it, and the page must remain
  // locked so Enter/programmatic submit cannot start a concurrent create.
  {
    const rawTransport = Object.assign(new Error("functions invocation connection reset"), {
      code: "FUNCTIONS_INVOCATION_FAILED",
      requestId: "transport-raw-1"
    });
    const scenario = await pageFailureScenario({
      callFunction: async () => { throw rawTransport; },
      uuid: "00000000-0000-4000-8000-000000000001",
      phone: "13900000008"
    });

    assert.equal(scenario.calls(), 1);
    for (const id of [
      "personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent",
      "openTeacherFaceCamera", "captureTeacherFace", "retakeTeacherFace"
    ]) {
      assert.equal(scenario.node(id).disabled, true, `${id} must stay locked after ambiguous transport failure`);
    }
    assert.equal(scenario.node("createTeacherSubmit").disabled, true);
    assert.match(scenario.node("personCreateMessage").textContent, /不会允许当前页面再次提交[\s\S]*老师管理确认/);

    await scenario.submitAgain();
    assert.equal(scenario.calls(), 1,
      "a second form-submit event must not issue another request after an uncertain outcome");
  }

  // An explicit ordinary function rejection is authoritative: the page may
  // unlock the retained data/photo and let the operator correct and resubmit.
  {
    const scenario = await pageFailureScenario({
      callFunction: async () => ({
        result: { ok: false, code: "BAD_REQUEST", message: "请修正老师姓名" }
      }),
      uuid: "00000000-0000-4000-8000-000000000002",
      phone: "13900000009"
    });
    assert.equal(scenario.calls(), 1);
    for (const id of ["personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent"]) {
      assert.equal(scenario.node(id).disabled, false, `${id} must unlock after an authoritative failure`);
    }
    assert.equal(scenario.node("createTeacherSubmit").disabled, false,
      "the retained valid form may be resubmitted after an authoritative failure");
    assert.match(scenario.node("teacherFaceEnrollmentState").textContent, /可修正后重试/);
    assert.match(scenario.node("personCreateMessage").textContent, /请修正老师姓名/);

    await scenario.submitAgain();
    assert.equal(scenario.calls(), 2,
      "an authoritative BAD_REQUEST must not permanently lock a corrected retry");
  }

  // A function that reports incomplete cleanup is authoritative about the
  // failure but not about residual identity state, so it must remain locked.
  {
    const scenario = await pageFailureScenario({
      callFunction: async () => ({
        result: {
          ok: false,
          code: "TEACHER_CREATE_CLEANUP_INCOMPLETE",
          message: "部分身份清理未完成"
        }
      }),
      uuid: "00000000-0000-4000-8000-000000000003",
      phone: "13900000010"
    });
    assert.equal(scenario.calls(), 1);
    for (const id of [
      "personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent",
      "openTeacherFaceCamera", "captureTeacherFace", "retakeTeacherFace"
    ]) {
      assert.equal(scenario.node(id).disabled, true, `${id} must stay locked while cleanup is uncertain`);
    }
    assert.equal(scenario.node("createTeacherSubmit").disabled, true);
    assert.match(scenario.node("personCreateMessage").textContent, /部分身份清理未完成[\s\S]*不会允许当前页面再次提交/);

    await scenario.submitAgain();
    assert.equal(scenario.calls(), 1,
      "cleanup-incomplete must not permit a second request from the current page");
  }

  console.log("teacher dedicated one-call wrapper contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
