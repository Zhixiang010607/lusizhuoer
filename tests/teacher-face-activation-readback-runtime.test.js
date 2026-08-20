"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "cloudfunctions", "staffAccount", "index.js"),
  "utf8"
);

function between(first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing source region ${first}`);
  return source.slice(start, end);
}

const activationSource = between(
  "async function activatePersistedTeacherFaceProfile",
  "\n\nasync function provisionTeacherWithFace"
);

function runtime(readRows) {
  const calls = [];
  const context = {
    module: { exports: {} },
    numericId(value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("bad id");
      return parsed;
    },
    sqlText(value) {
      return `'${String(value).replace(/'/g, "''")}'`;
    },
    async executeSql(sql) {
      calls.push(sql);
      // Reproduce the production platform: UPDATE commits but its writable
      // response contains no Rows. Only the following SELECT exposes state.
      return calls.length === 1 ? [] : readRows;
    }
  };
  vm.createContext(context);
  vm.runInContext(
    `${activationSource}\nmodule.exports = activatePersistedTeacherFaceProfile;`,
    context,
    { filename: "staffAccount-teacher-face-activation-readback.js" }
  );
  return { calls, activate: context.module.exports };
}

(async () => {
  const durable = {
    id: 7,
    teacher_code: "TCHF412",
    teacher_name: "乐玉琴",
    teacher_status: "ACTIVE",
    face_enrollment_status: "ENROLLED",
    face_enrolled_at: "2026-08-20T10:00:00Z",
    profile_photo_file_id: "teachers/7/profile.jpg"
  };

  {
    const subject = runtime([durable]);
    const result = await subject.activate({
      staffId: 412,
      teacherId: 7,
      personId: "teacher_person_abc",
      teacherName: "乐玉琴"
    });
    assert.equal(result, durable);
    assert.equal(subject.calls.length, 2);
    assert.match(subject.calls[0], /^UPDATE public\.teachers/);
    assert.doesNotMatch(subject.calls[0], /RETURNING/i,
      "activation must not depend on writable RETURNING rows");
    assert.match(subject.calls[1], /^SELECT teacher\.id/);
    assert.match(subject.calls[1], /teacher\.face_person_id = 'teacher_person_abc'/);
    assert.match(subject.calls[1], /teacher\.face_enrollment_status = 'ENROLLED'/);
    assert.match(subject.calls[1], /teacher\.profile_photo_file_id/);
    assert.match(subject.calls[1], /account\.account_status = 'ACTIVE'/);
  }

  {
    const subject = runtime([]);
    const result = await subject.activate({
      staffId: 412,
      teacherId: 7,
      personId: "teacher_person_abc"
    });
    assert.equal(result, null,
      "an empty durable readback must never be treated as an activated teacher");
  }

  console.log("teacher face activation readback runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
