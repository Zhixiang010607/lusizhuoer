"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "teacher-create.js"), "utf8");

function namedFunctionSource(name, asyncRequired = false) {
  const match = new RegExp(`${asyncRequired ? "async\\s+" : "(?:async\\s+)?"}function\\s+${name}\\s*\\(`)
    .exec(source);
  assert.ok(match, `missing function ${name}`);
  const parametersOpen = source.indexOf("(", match.index);
  let parameters = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < source.length; index += 1) {
    if (source[index] === "(") parameters += 1;
    if (source[index] === ")" && --parameters === 0) { parametersClose = index; break; }
  }
  const open = source.indexOf("{", parametersClose);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const safeSeconds = namedFunctionSource("safeProvisionRecoverySeconds");
const transient = namedFunctionSource("transientTeacherProvisionTransport");
const proof = namedFunctionSource("teacherProvisionProof");
const begin = namedFunctionSource("beginTeacherProvision", true);
const background = namedFunctionSource("provisionTeacherWithBackgroundPolling", true);

assert.match(begin, /faceImageBase64:\s*_omittedFaceImage/,
  "begin must send metadata without the raw photo");
assert.match(background, /provisionTeacherWithFace\(input\)/,
  "READY must launch the full immutable worker request");
assert.match(background, /getTeacherFaceOperationStatus\(\{ operationId, readOnly: true \}\)/,
  "resume authorization must come from read-only status");
assert.match(background, /readTeacherProvisionResult\(\{[\s\S]{0,120}\.\.\.input,[\s\S]{0,120}operationId,[\s\S]{0,120}readOnly: true/,
  "SUCCEEDED must read proof with the same full payload and operation id");

function finalProof() {
  return {
    ok: true,
    resultReadOnly: true,
    readbackConfirmed: true,
    uid: "teacher-resume-proof",
    verification: {
      personConfirmed: true,
      privatePhotoConfirmed: true,
      delegatedDatabaseConfirmed: true,
      finalDatabaseConfirmed: true,
      facePhotoReady: true,
      teacherActive: true,
      accountActive: true,
      credentialActive: true,
      complete: true
    },
    teacher: {
      teacherId: "77",
      faceEnrollmentStatus: "ENROLLED",
      facePhotoReady: true,
      teacherStatus: "ACTIVE",
      accountStatus: "ACTIVE",
      credentialStatus: "ACTIVE"
    }
  };
}

(async () => {
  const workerCalls = [];
  const statusCalls = [];
  const resultCalls = [];
  const statuses = [
    { ok: true, operationId: "77", status: "RUNNING", stage: "READY",
      workerReady: true, retrySameRequest: true, retryAfterSeconds: 0 },
    { ok: true, operationId: "77", status: "SUCCEEDED", stage: "SUCCEEDED",
      workerReady: false, retrySameRequest: false, retryAfterSeconds: 0 }
  ];
  const input = Object.freeze({
    staffName: "恢复老师",
    phone: "13900000007",
    initialPassword: "Aa1!aaaa",
    clientRequestId: "same_request_runtime_01",
    consent: true,
    faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
  });
  let now = 1_000_000;
  const sandbox = {
    module: { exports: {} },
    Date: { now: () => now },
    wait: async (milliseconds) => {
      now += Math.max(2000, Number(milliseconds) || 0);
      await Promise.resolve();
    },
    setMessage: () => {},
    setProvisionPayloadLocked: () => {},
    syncSubmit: () => {},
    showTeacherProvisionProgress: () => {},
    window: { CloudBasePhoneAuth: {
      beginTeacherProvisionWithFace: async (value) => {
        assert.equal(Object.hasOwn(value, "faceImageBase64"), false);
        return { ok: true, accepted: true, operationId: "77", status: "RUNNING",
          stage: "WORKER_RUNNING", workerReady: false, retrySameRequest: false,
          retryAfterSeconds: 1 };
      },
      provisionTeacherWithFace: (value) => {
        workerCalls.push(value);
        return new Promise(() => {});
      },
      getTeacherFaceOperationStatus: async (value) => {
        statusCalls.push(value);
        return statuses.shift();
      },
      readTeacherProvisionResult: async (value) => {
        resultCalls.push(value);
        return finalProof();
      }
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let provisionRecoveryGeneration = 0;
    let provisionRecoveryPending = false;
    let activeProvisionOperationId = "";
    const teacherProvisionWorkerDeliveryStates = new Map();
    ${safeSeconds}
    ${transient}
    ${proof}
    ${begin}
    ${background}
    module.exports = provisionTeacherWithBackgroundPolling;
  `, sandbox);

  const result = await sandbox.module.exports(input, {
    faceImageSha256: "ef".repeat(32), faceImageBytes: 4
  });
  assert.equal(result.uid, "teacher-resume-proof");
  assert.equal(workerCalls.length, 1,
    "ACTIVE must wait; the later durable READY observation authorizes exactly one worker");
  assert.equal(workerCalls[0], input,
    "the authorized worker must reuse the identical frozen request object");
  assert.equal(statusCalls.length, 2);
  assert.ok(statusCalls.every((value) => value.operationId === "77" && value.readOnly === true));
  assert.equal(resultCalls.length, 1);
  for (const key of Object.keys(input)) {
    assert.equal(resultCalls[0][key], input[key], `proof replay must preserve ${key}`);
  }
  assert.equal(resultCalls[0].operationId, "77");
  assert.equal(resultCalls[0].readOnly, true);

  console.log("teacher same-request resume runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
