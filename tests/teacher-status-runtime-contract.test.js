"use strict";

// Execute the real setStaffStatus dispatcher with in-memory CloudBase and SQL
// doubles.  This is intentionally behavioural coverage: source matching could
// not have caught the old catch-brace bug which turned an ARCHIVED credential
// warning into an AUTH_ACTIVATION_FAILED error after PostgreSQL had succeeded.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const staffSource = fs.readFileSync(path.join(root, "cloudfunctions", "staffAccount", "index.js"), "utf8");
const findStaffProfileSource = staffSource.slice(
  staffSource.indexOf("async function findStaffProfile"),
  staffSource.indexOf("\nasync function recoverStaffProfileByVerifiedPhone", staffSource.indexOf("async function findStaffProfile"))
);
assert.ok(findStaffProfileSource.startsWith("async function findStaffProfile"), "findStaffProfile must remain independently executable");

function mainSource(source) {
  const start = source.indexOf("async function main(event = {}, context = {}) {");
  const end = source.indexOf("\n// Keep master-data status", start);
  assert.ok(start >= 0 && end > start, "staffAccount main dispatcher must remain independently executable");
  return source.slice(start, end);
}

function failed(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stageFailed(stage, message, code, cause) {
  const error = new Error(message);
  error.code = code;
  error.stage = stage;
  error.cause = cause;
  throw error;
}

function harnessFor(options = {}) {
  const state = {
    accountStatus: options.accountStatus || "ACTIVE",
    teacherStatus: options.teacherStatus || options.accountStatus || "ACTIVE",
    hasTeacherProfile: options.hasTeacherProfile !== false,
    authMode: options.authMode || "success",
    profileRepairFails: options.profileRepairFails === true,
    order: [],
    authCalls: [],
    sqlCalls: 0,
    genericProvisionPreflights: 0,
    genericProvisionCreates: 0
  };
  const harness = {
    module: { exports: {} },
    console: { error() {}, warn() {} },
    handleTrustedTeacherExperienceResetTimer: async () => null,
    currentUser: async () => ({ uid: "hq-auth", profile: { role: "hq", staffId: "900" } }),
    requireHq(caller) {
      if (caller?.profile?.role !== "hq") failed("FORBIDDEN", "FORBIDDEN");
    },
    ROLES: new Set(["hq", "store", "teacher"]),
    validatePhone: (value) => String(value || ""),
    validatePassword: (value) => String(value || ""),
    assertPhoneCanUseRole: async () => {
      state.genericProvisionPreflights += 1;
      return null;
    },
    requireTeacherOptionalFaceActivationSchema: async () => { state.order.push("schema:optional-face"); },
    ensureTeacherDatabaseProfile: async () => {
      state.order.push("repair:teacher-profile");
      if (state.profileRepairFails) failed("老师资料无法补全", "TEACHER_PROFILE_MISSING");
      state.hasTeacherProfile = true;
      return {
        id: 7,
        teacher_status: state.teacherStatus,
        face_person_id: null,
        face_enrollment_status: "PENDING"
      };
    },
    persistStaffStatusAndMaster: async (staff, status) => {
      state.order.push(`database:${status}`);
      state.accountStatus = status;
      state.teacherStatus = status;
      staff.teacher_id ||= 7;
    },
    archiveTeacherProvisioning: async () => {
      state.order.push("compensate:database-archived");
      state.accountStatus = "ARCHIVED";
      state.teacherStatus = "ARCHIVED";
    },
    archiveStoreProvisioning: async () => { state.order.push("compensate:store-archived"); },
    missingCloudBaseCredential: (error) => error?.kind === "missing",
    asDatabaseError: (error, action) => failed(`${action}:${error?.message || "database"}`, "DATABASE_ERROR"),
    sqlText: (value) => `'${String(value)}'`,
    fail: failed,
    stageFail: stageFailed,
    manager: () => ({
      user: {
        createUser: async () => {
          state.genericProvisionCreates += 1;
          return { Data: { Uid: "would-have-created" } };
        },
        modifyUser: async ({ uid, userStatus }) => {
          state.order.push(`identity:${userStatus}`);
          state.authCalls.push({ uid, userStatus });
          if (state.authMode === "missing") {
            const error = new Error("user not found");
            error.kind = "missing";
            throw error;
          }
          if (state.authMode === "generic") throw new Error("identity service unavailable");
        }
      }
    }),
    executeSql: async (sql) => {
      state.sqlCalls += 1;
      if (sql.includes("FROM public.staff_accounts a") && sql.includes("LEFT JOIN public.teachers t")) {
        return [{
          id: 41,
          auth_uid: options.noAuthUid ? "" : "teacher-auth-41",
          phone: "13900000041",
          role_code: "teacher",
          account_status: state.accountStatus,
          teacher_id: state.hasTeacherProfile ? 7 : null,
          teacher_status: state.hasTeacherProfile ? state.teacherStatus : null,
          face_enrollment_status: "PENDING",
          face_person_id: null
        }];
      }
      if (sql.includes("SELECT account.account_status, teacher.teacher_status")) {
        return [{ account_status: state.accountStatus, teacher_status: state.teacherStatus }];
      }
      throw new Error(`Unexpected SQL in setStaffStatus runtime harness: ${sql.slice(0, 100)}`);
    }
  };
  vm.createContext(harness);
  vm.runInContext(`${mainSource(staffSource)}\nmodule.exports = main;`, harness, {
    filename: "staffAccount-set-status-runtime.js"
  });
  return { state, main: harness.module.exports };
}

async function setTeacherStatus(main, status, noAuthUid = false) {
  return main({
    action: "setStaffStatus",
    ...(noAuthUid ? { phone: "13900000041" } : { uid: "teacher-auth-41" }),
    status
  });
}

async function readLegacyTeacherProfile({ repairFails = false } = {}) {
  const state = { schemaChecks: 0, repairCalls: 0 };
  const harness = {
    module: { exports: {} },
    ROLES: new Set(["hq", "store", "teacher"]),
    getStoreBindingLayout: async () => "stores",
    requireTeacherOptionalFaceActivationSchema: async () => { state.schemaChecks += 1; },
    ensureTeacherDatabaseProfile: async () => {
      state.repairCalls += 1;
      if (repairFails) failed("老师主档仍缺失", "TEACHER_PROFILE_MISSING");
      return { id: 7, teacher_status: "ACTIVE", face_person_id: null, face_enrollment_status: "PENDING" };
    },
    sqlText: (value) => `'${String(value)}'`,
    executeSql: async () => [{
      id: 41, phone: "13900000041", staff_name: "历史老师", role_code: "teacher", account_status: "ACTIVE",
      password_initialized_at: null, password_changed_at: null, password_change_required: false,
      store_id: null, store_code: null, store_name: null, store_status: null,
      teacher_id: null, teacher_status: null, face_person_id: null, face_enrollment_status: null
    }],
    fail: failed,
    asDatabaseError: (error, action) => failed(`${action}:${error?.message || "database"}`, "DATABASE_ERROR")
  };
  vm.createContext(harness);
  vm.runInContext(`${findStaffProfileSource}\nmodule.exports = findStaffProfile;`, harness, {
    filename: "staffAccount-find-profile-runtime.js"
  });
  return { state, profile: await harness.module.exports("teacher-auth") };
}

(async () => {
  // Login reads can safely repair legacy stress rows that have a teacher
  // account but no master record.  PENDING/no-face remains active; only a
  // failed repair reports TEACHER_PROFILE_MISSING.
  {
    const { state, profile } = await readLegacyTeacherProfile();
    assert.equal(profile.role, "teacher");
    assert.equal(profile.teacherId, "7");
    assert.equal(profile.teacherStatus, "ACTIVE");
    assert.equal(profile.faceEnrollmentStatus, "PENDING");
    assert.deepEqual(state, { schemaChecks: 1, repairCalls: 1 });
  }
  await assert.rejects(readLegacyTeacherProfile({ repairFails: true }),
    (error) => error.code === "TEACHER_PROFILE_MISSING");

  // ACTIVE succeeds without a face and flips PostgreSQL before CloudBase.
  {
    const { state, main } = harnessFor({ accountStatus: "ARCHIVED", teacherStatus: "ARCHIVED" });
    const result = await setTeacherStatus(main, "ACTIVE");
    assert.equal(result.ok, true);
    assert.equal(result.accountStatus, "ACTIVE");
    assert.equal(result.teacherStatus, "ACTIVE");
    assert.equal(result.credentialStatus, "ACTIVE");
    assert.deepEqual(state.order, ["schema:optional-face", "database:ACTIVE", "identity:ACTIVE"],
      "no-face activation updates the business master before enabling the credential");
    assert.equal(state.authCalls[0].userStatus, "ACTIVE");
  }

  // ARCHIVED succeeds and makes both database identities unavailable before
  // reporting CloudBase BLOCKED as the secondary credential action.
  {
    const { state, main } = harnessFor();
    const result = await setTeacherStatus(main, "ARCHIVED");
    assert.equal(result.ok, true);
    assert.equal(result.accountStatus, "ARCHIVED");
    assert.equal(result.teacherStatus, "ARCHIVED");
    assert.equal(result.credentialStatus, "BLOCKED");
    assert.equal(result.warning, undefined);
    assert.deepEqual(state.order, ["schema:optional-face", "database:ARCHIVED", "identity:BLOCKED"]);
  }

  // A missing historical CloudBase user does not undo a confirmed archive or
  // make the UI falsely tell headquarters that the archive failed.
  {
    const { state, main } = harnessFor({ authMode: "missing" });
    const result = await setTeacherStatus(main, "ARCHIVED");
    assert.equal(result.ok, true);
    assert.equal(result.accountStatus, "ARCHIVED");
    assert.equal(result.teacherStatus, "ARCHIVED");
    assert.equal(result.credentialStatus, "MISSING");
    assert.equal(result.warningCode, "AUTH_CREDENTIAL_MISSING");
    assert.match(result.warning, /已封存/);
    assert.deepEqual(state.order, ["schema:optional-face", "database:ARCHIVED", "identity:BLOCKED"]);
  }

  // A generic CloudBase BLOCKED error is similarly only a warning: database
  // authorization is already ARCHIVED, so the teacher cannot log into or be
  // chosen for any business action even while Tencent repair is pending.
  {
    const { state, main } = harnessFor({ authMode: "generic" });
    const result = await setTeacherStatus(main, "ARCHIVED");
    assert.equal(result.ok, true);
    assert.equal(result.accountStatus, "ARCHIVED");
    assert.equal(result.teacherStatus, "ARCHIVED");
    assert.equal(result.credentialStatus, "BLOCK_FAILED");
    assert.equal(result.warningCode, "AUTH_BLOCK_FAILED");
    assert.match(result.warning, /CloudBase/);
    assert.deepEqual(state.order, ["schema:optional-face", "database:ARCHIVED", "identity:BLOCKED"]);
  }

  // The inverse direction is fail-closed.  If CloudBase activation fails, the
  // service compensates back to ARCHIVED and returns a definite error rather
  // than leaving a selectable active master without a usable login.
  {
    const { state, main } = harnessFor({ accountStatus: "ARCHIVED", teacherStatus: "ARCHIVED", authMode: "generic" });
    await assert.rejects(setTeacherStatus(main, "ACTIVE"), (error) => error.code === "AUTH_ACTIVATION_FAILED");
    assert.equal(state.accountStatus, "ARCHIVED");
    assert.equal(state.teacherStatus, "ARCHIVED");
    assert.deepEqual(state.order, [
      "schema:optional-face", "database:ACTIVE", "identity:ACTIVE", "compensate:database-archived"
    ]);
  }

  // A legacy teacher missing the master row is repaired before any external
  // credential write.  If repair itself fails, TEACHER_PROFILE_MISSING leaves
  // both current statuses untouched and no CloudBase mutation is attempted.
  {
    const { state, main } = harnessFor({ hasTeacherProfile: false });
    const result = await setTeacherStatus(main, "ARCHIVED");
    assert.equal(result.ok, true);
    assert.deepEqual(state.order, [
      "schema:optional-face", "repair:teacher-profile", "database:ARCHIVED", "identity:BLOCKED"
    ]);
  }
  {
    const { state, main } = harnessFor({ hasTeacherProfile: false, profileRepairFails: true });
    await assert.rejects(setTeacherStatus(main, "ARCHIVED"), (error) => error.code === "TEACHER_PROFILE_MISSING");
    assert.deepEqual(state.order, ["schema:optional-face", "repair:teacher-profile"],
      "a missing teacher master must never block the credential before profile repair succeeds");
    assert.equal(state.authCalls.length, 0);
    assert.equal(state.accountStatus, "ACTIVE");
    assert.equal(state.teacherStatus, "ACTIVE");
  }

  // An ACTIVE request without any recoverable CloudBase UID also restores the
  // database archive state; it is not permitted to yield an active no-login
  // teacher row.
  {
    const { state, main } = harnessFor({ accountStatus: "ARCHIVED", teacherStatus: "ARCHIVED", noAuthUid: true });
    await assert.rejects(setTeacherStatus(main, "ACTIVE", true), (error) => error.code === "AUTH_CREDENTIAL_MISSING");
    assert.equal(state.accountStatus, "ARCHIVED");
    assert.equal(state.teacherStatus, "ARCHIVED");
    assert.deepEqual(state.order, ["schema:optional-face", "database:ACTIVE", "compensate:database-archived"]);
  }

  // The generic staff endpoint is a hard server-side boundary as well as a
  // UI rule.  A crafted request for role=teacher is rejected before phone
  // lookup, CloudBase identity creation, or any SQL write; the only allowed
  // new-teacher route is the independent teacherCreate service.
  {
    const { state, main } = harnessFor();
    await assert.rejects(
      main({
        action: "provisionStaff", staffName: "必须人脸", phone: "13900000051",
        role: "teacher", initialPassword: "Abc!12345"
      }),
      (error) => error.code === "TEACHER_CREATE_SERVICE_REQUIRED"
    );
    assert.equal(state.genericProvisionPreflights, 0);
    assert.equal(state.genericProvisionCreates, 0);
    assert.equal(state.sqlCalls, 0);
    assert.equal(state.authCalls.length, 0);
  }

  console.log("teacher status runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
