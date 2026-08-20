"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "teacher-create.js"), "utf8");

function between(text, first, last) {
  const start = text.indexOf(first);
  const end = text.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing source region ${first}`);
  return text.slice(start, end);
}

(async () => {
  const waits = [];
  const messages = [];
  const payloadLocks = [];
  const retake = { disabled: false };
  const calls = [];
  let behavior = null;
  const sandbox = {
    module: { exports: {} },
    window: {
      CloudBasePhoneAuth: {
        provisionTeacherWithFace: async (input) => {
          calls.push(input);
          return behavior(input);
        }
      }
    },
    $: (id) => {
      assert.equal(id, "retakeTeacherFace");
      return retake;
    },
    syncSubmit: () => {},
    setProvisionPayloadLocked: (locked) => { payloadLocks.push(locked === true); },
    setMessage: (message) => { messages.push(message); },
    wait: async (milliseconds) => { waits.push(milliseconds); },
    console
  };
  vm.createContext(sandbox);
  const recoverySource = between(
    source,
    "function safeProvisionRecoverySeconds",
    "\n\n  function dataUrlBytes"
  );
  vm.runInContext(`let provisionRecoveryPending = false;
    ${recoverySource}
    module.exports = {
      ambiguousTeacherProvisionTransport,
      provisionTeacherWithAutomaticResume
    };`, sandbox);

  const input = Object.freeze({
    clientRequestId: "same_request_runtime_01",
    phone: "13900000007",
    faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
  });
  const hardKill = Object.assign(new Error("cloud function exceeded its time limit"), {
    code: "FUNCTIONS_TIME_LIMIT"
  });
  behavior = async () => { throw hardKill; };
  await assert.rejects(
    sandbox.module.exports.provisionTeacherWithAutomaticResume(input),
    (error) => error === hardKill && error.sameRequestResumeDeferred === true
  );
  assert.equal(calls.length, 1,
    "an ambiguous hard kill must not automatically start a second cloud-function invocation");
  assert.equal(waits.length, 0,
    "the client must return control immediately while the ACTIVE invocation may still be alive");
  assert.deepEqual(payloadLocks, [true],
    "a hard-kill ambiguity must lock the retained request, photo and HMAC-bound fields");

  calls.length = 0;
  waits.length = 0;
  messages.length = 0;
  payloadLocks.length = 0;
  let attempt = 0;
  behavior = async () => {
    attempt += 1;
    if (attempt === 1) {
      const ready = new Error("server stopped at the Auth boundary");
      ready.code = "TEACHER_AUTH_CREATE_RETRY_SAME_REQUEST";
      ready.retrySameRequest = true;
      ready.retryAfterSeconds = 2;
      throw ready;
    }
    return { ok: true, resumed: true };
  };
  const result = await sandbox.module.exports.provisionTeacherWithAutomaticResume(input);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, resumed: true });
  assert.equal(calls.length, 2,
    "a server-published READY response may authorize exactly one automatic resume attempt here");
  assert.equal(calls[0], input);
  assert.equal(calls[1], input,
    "the authorized resume must reuse the identical request object and clientRequestId");
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(payloadLocks, [true],
    "a READY retry must keep the payload locked while making the authorized second call");
  assert.ok(messages.some((message) => message.includes("同一个请求编号")));

  console.log("teacher same-request resume runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
