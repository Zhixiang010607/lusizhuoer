"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const staffSource = fs.readFileSync(
  path.join(root, "cloudfunctions", "staffAccount", "index.js"),
  "utf8"
);

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing source region ${first}`);
  return source.slice(start, end);
}

const ensureTeacherSource = between(
  staffSource,
  "async function ensureTeacherDatabaseProfile",
  "\n\nasync function createStaffDatabaseProfile"
);

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function harness(selectRows) {
  const calls = [];
  const context = {
    module: { exports: {} },
    numericId(value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) fail("invalid staff id", "BAD_REQUEST");
      return parsed;
    },
    fail,
    asDatabaseError(error, action) {
      if (error) fail(`${action}失败`, "DATABASE_ERROR");
    },
    async executeSql(sql) {
      calls.push(sql);
      // Reproduce CloudBase executePGSql: the INSERT commits successfully but
      // the writable response exposes no Rows/RETURNING payload.
      if (calls.length === 1) return [];
      return selectRows;
    }
  };
  vm.createContext(context);
  vm.runInContext(
    `${ensureTeacherSource}\nmodule.exports = ensureTeacherDatabaseProfile;`,
    context,
    { filename: "staffAccount-teacher-profile-readback.js" }
  );
  return { calls, ensureTeacherDatabaseProfile: context.module.exports };
}

(async () => {
  const durableTeacher = {
    id: 72,
    teacher_code: "TCHF41",
    teacher_name: "老师四十一",
    teacher_status: "ARCHIVED",
    face_person_id: null,
    face_enrollment_status: "PENDING",
    face_enrolled_at: null
  };

  {
    const runtime = harness([durableTeacher]);
    const result = await runtime.ensureTeacherDatabaseProfile(41);

    assert.equal(result, durableTeacher,
      "a committed write with an empty writable response must return the durable SELECT row");
    assert.equal(runtime.calls.length, 2,
      "profile repair must issue one write followed by one readback");
    assert.match(runtime.calls[0], /^INSERT INTO public\.teachers/,
      "the first statement must remain the idempotent teacher upsert");
    assert.doesNotMatch(runtime.calls[0], /RETURNING/i,
      "teacher repair must not depend on writable RETURNING rows");
    assert.match(runtime.calls[1], /^SELECT teacher\.id/,
      "the second statement must be a plain durable readback");
    assert.match(runtime.calls[1], /teacher\.staff_account_id = 41/,
      "the readback must target the exact staff account");
    assert.match(runtime.calls[1], /account\.role_code = 'teacher'/,
      "the readback must reject a non-teacher business account");
  }

  {
    const runtime = harness([]);
    await assert.rejects(
      runtime.ensureTeacherDatabaseProfile(41),
      (error) => error.code === "TEACHER_PROFILE_MISSING",
      "only a still-empty durable readback may report TEACHER_PROFILE_MISSING"
    );
    assert.equal(runtime.calls.length, 2,
      "a truly missing teacher must still be checked after the committed write response is empty");
  }

  console.log("teacher profile readback runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
