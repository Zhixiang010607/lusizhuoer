"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "teacher-create.js"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `missing function ${name}`);
  const parametersOpen = source.indexOf("(", match.index);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] === ")" && --parameterDepth === 0) { parametersClose = index; break; }
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

const statusValue = functionSource("statusValue");
const textValue = functionSource("textValue");
const completed = functionSource("completedTeacherCreation");

for (const legacy of [
  "beginTeacherProvisionWithFace", "provisionTeacherWithFace", "getTeacherFaceOperationStatus",
  "readTeacherProvisionResult", "teacherProvisionWorkerDeliveryStates", "activeProvisionOperationId"
]) {
  assert.equal(source.includes(legacy), false, `one-call page must not retain ${legacy}`);
}
assert.doesNotMatch(source, /\bwhile\s*\(|setInterval\s*\(/,
  "teacher creation must not contain a polling loop");

const sandbox = { module: { exports: {} } };
vm.createContext(sandbox);
vm.runInContext(`${statusValue}\n${textValue}\n${completed}\nmodule.exports = completedTeacherCreation;`, sandbox);
const prove = sandbox.module.exports;

function validProof() {
  return {
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
  };
}

const valid = prove(validProof());
assert.equal(valid.uid, "teacher-auth-13900000007");
assert.equal(valid.teacherId, "77");
assert.equal(valid.faceId, "face-77");
assert.equal(valid.personId, "T-777777777777777777777777777777777777777777777777");
assert.equal(valid.photoSha256, "ab".repeat(32));
assert.equal(valid.photoBytes, 6);

for (const mutation of [
  (value) => { value.ok = false; },
  (value) => { value.completed = false; },
  (value) => { value.proof.complete = false; },
  (value) => { value.proof.teacherStatus = "ARCHIVED"; },
  (value) => { value.proof.accountStatus = "ARCHIVED"; },
  (value) => { value.proof.authStatus = "BLOCKED"; },
  (value) => { value.proof.faceStatus = "PENDING"; },
  (value) => { value.proof.faceId = ""; },
  (value) => { value.proof.personId = ""; },
  (value) => { value.proof.photoRef = ""; },
  (value) => { value.proof.photoSha256 = ""; },
  (value) => { value.proof.photoSha256 = "abc"; },
  (value) => { value.proof.photoBytes = 0; },
  (value) => { value.uid = ""; },
  (value) => { value.teacherId = ""; }
]) {
  const incomplete = validProof();
  mutation(incomplete);
  assert.equal(prove(incomplete), null, "every omitted or inactive proof component must fail closed");
}

assert.match(source,
  /CLIENT_REQUEST_TIMEOUT[\s\S]{0,160}outcomeUncertain = true[\s\S]{0,420}不会允许当前页面再次提交[\s\S]{0,220}返回老师管理确认/,
  "a lost browser response must freeze the page and require an authoritative directory check");
assert.match(source, /const ready = !submitting && !creationCompleted && !outcomeUncertain/,
  "an uncertain outcome must remain outside the submit-ready state");
assert.match(source, /if \(!succeeded\) setFormLocked\(outcomeUncertain\)/,
  "finally must keep every identity/photo control locked after transport uncertainty");

console.log("teacher one-call proof runtime contract: PASS");
