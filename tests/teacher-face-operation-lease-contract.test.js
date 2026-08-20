"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const staff = fs.readFileSync(path.join(root, "cloudfunctions", "staffAccount", "index.js"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "database", "migrations", "051_teacher_face_operation_lease.sql"), "utf8"
);
const consoleDir = path.join(root, "database", "cloudbase-console");

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing source region ${first}`);
  return source.slice(start, end);
}

assert.match(migration, /owner_token_sha256 CHAR\(64\)/);
assert.match(migration, /face_group_id VARCHAR\(64\) NOT NULL/);
assert.match(migration, /photo_bucket_id VARCHAR\(128\) NOT NULL/);
assert.doesNotMatch(migration, /\n\s*owner_token\s+(?:TEXT|VARCHAR|CHAR)/i,
  "the durable table may store only the owner-token SHA-256 digest");
assert.match(migration, /operation_status IN \('RUNNING', 'SUCCEEDED', 'CANCELLED', 'CLEANUP_PENDING'\)/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_phone/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_teacher/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_person/);
assert.match(migration,
  /IF NOT FOUND OR op\.operation_status <> p_expected_status[\s\S]*op\.lease_expires_at <= now_value THEN/,
  "an expired owner must be rejected while the transition row lock is held");
assert.match(migration,
  /operation_status = 'CLEANUP_PENDING'[\s\S]*lease_generation = target\.lease_generation \+ 1|lease_generation=x\.lease_generation\+1[\s\S]*operation_status='CLEANUP_PENDING'/,
  "expired acquisition must rotate generation and become cleanup-only");

assert.match(staff, /const ownerToken = crypto\.randomBytes\(32\)\.toString\("hex"\)/,
  "each invocation needs an unpredictable, non-idempotency-derived owner token");
assert.match(staff, /error\?\.authCreationUncertain[\s\S]*"RUNNING", "CLEANUP_PENDING"/,
  "a lost createUser response must remain an open cleanup tombstone");
assert.match(staff,
  /delegated = await finalDelegatedTeacherFaceReadback\(delegationInput, faceOperation\);[\s\S]*finalState = await authoritativeTeacherProvisioningState\([\s\S]*transitionTeacherFaceOperation\(faceOperation, "RUNNING", "SUCCEEDED"\)/,
  "success requires final remote proof followed by final DB/Auth proof before SUCCEEDED");
assert.match(staff, /TEACHER_FACE_RECONCILE_TIMER_TRIGGER_NAME = "reconcile-teacher-face-operations"/);
assert.match(staff,
  /String\(fields\.imageBytes\),\s*String\(fields\.faceGroupId\),\s*String\(fields\.photoBucketId\),\s*String\(fields\.previousPersonId/,
  "the signed group and private bucket must precede the previous-face snapshot");
assert.match(staff, /String\(person\.groupId \|\| ""\) === String\(expected\.faceGroupId\)/);
assert.match(staff, /String\(photo\.bucketId \|\| ""\) === String\(expected\.photoBucketId\)/);
assert.match(staff, /LIMIT \$\{TEACHER_FACE_RECONCILE_BATCH_SIZE\}/);
assert.match(staff, /teacherOperationOwnsAuthentication\(before, phone, operationRow\)[\s\S]*userStatus: "BLOCKED"[\s\S]*UserStatus \|\| ""\)\.toUpperCase\(\) !== "BLOCKED"/,
  "saga Auth blocking needs exact ownership before write and BLOCKED readback after it");

for (let part = 1; part <= 10; part += 1) {
  const prefix = `051-${String(part).padStart(2, "0")}-`;
  const filename = fs.readdirSync(consoleDir).find((name) => name.startsWith(prefix) && name.endsWith(".sql"));
  assert.ok(filename, `missing CloudBase console part ${prefix}`);
  const contents = fs.readFileSync(path.join(consoleDir, filename), "utf8");
  const crlfBytes = Buffer.byteLength(contents.replace(/\r?\n/g, "\r\n"), "utf8");
  assert.ok(crlfBytes <= 3500, `${filename} exceeds the CRLF-safe 3500-byte console limit`);
  assert.match(contents, /BEGIN;[\s\S]*COMMIT;/);
}
assert.ok(fs.existsSync(path.join(consoleDir, "051-readonly-verify.sql")));

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}
function numericId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("bad id");
  return number;
}
function runtimeFunction(sourceRegion, exportName, executeSql) {
  const sandbox = { module: { exports: {} }, executeSql, sqlText, numericId,
    console: { error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(`${sourceRegion}\nmodule.exports = ${exportName};`, sandbox);
  return sandbox.module.exports;
}

(async () => {
  // createUser may commit after its SDK response is lost and remain invisible
  // to the immediate read replica. The production creation flow must leave an
  // open cleanup tombstone; it may not mark the operation cleanup-complete.
  {
    const transitions = [];
    let authDeleteCalls = 0;
    const operation = {
      id: "51", ownerToken: "ab".repeat(32), ownerTokenHash: "12".repeat(32),
      leaseGeneration: 1, status: "RUNNING", imageDigest: "34".repeat(32), imageBytes: 4
    };
    const sandbox = {
      module: { exports: {} }, Buffer, TEACHER_FACE_COMPENSATION_SETTLE_MS: 0,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherProvisionAuthenticationUid: () => "teacher-auth-owned",
      teacherProvisionAuthenticationLease: () => `teacher-face-saga:51:${"ab".repeat(32)}`,
      teacherFaceImage: () => ({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q=="
      }),
      numericId,
      sqlText,
      acquireTeacherFaceOperation: async () => operation,
      executeSql: async (sql) => {
        if (sql.includes("FROM public.staff_accounts a")) return [];
        throw new Error(`unexpected SQL before Auth uncertainty: ${sql.slice(0, 80)}`);
      },
      bindTeacherFaceOperation: async () => {},
      exactAuthenticationUserByUid: async () => null,
      findAuthUserByExactPhoneReadOnly: async () => null,
      teacherSagaOwnsAuthentication: () => false,
      teacherProvisioningDelay: async () => {},
      manager: () => ({ user: {
        createUser: async () => { throw Object.assign(new Error("response lost"), { code: "TIMEOUT" }); }
      } }),
      transitionTeacherFaceOperation: async (target, expected, next, options = {}) => {
        transitions.push({ expected, next, cleanupComplete: options.cleanupComplete === true });
        target.status = next;
      },
      deleteTeacherProvisioningAuthentication: async () => { authDeleteCalls += 1; },
      fail(message, code) { const error = new Error(message); error.code = code; throw error; }
    };
    vm.createContext(sandbox);
    const provisionSource = between(
      staff, "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent"
    );
    vm.runInContext(`${provisionSource}\nmodule.exports = provisionTeacherWithFace;`, sandbox);
    await assert.rejects(
      sandbox.module.exports(
        { profile: { staffId: "900" } },
        {
          staffName: "迟到老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
          clientRequestId: "late_auth_0001", consent: true, faceImageBase64: "unused"
        }
      ),
      (error) => error.code === "TEACHER_PROVISION_COMPENSATION_PENDING"
        && error.authCreationUncertain === true
    );
    assert.deepEqual(transitions, [
      { expected: "RUNNING", next: "CLEANUP_PENDING", cleanupComplete: false }
    ]);
    assert.equal(authDeleteCalls, 0, "an unobserved late Auth commit cannot be guessed or marked deleted");
  }

  // A stale reconciler may initially see the pre-bound UID as missing and
  // then observe the delayed Auth commit after other cleanup work. The final
  // boundary must read that exact UID again and delete it only after ownership
  // is confirmed; the earlier missing read is never cleanup proof.
  {
    let exactReadCalls = 0;
    let authDeleteCalls = 0;
    const operation = {
      id: "52", ownerToken: "cd".repeat(32), ownerTokenHash: "56".repeat(32),
      leaseGeneration: 2, status: "CANCELLED", row: { operation_id: "52" }
    };
    const ownedUser = { Uid: "teacher-auth-late" };
    const sandbox = {
      module: { exports: {} },
      TEACHER_FACE_COMPENSATION_SETTLE_MS: 0,
      exactAuthenticationUserByUid: async () => {
        exactReadCalls += 1;
        return exactReadCalls === 1 ? null : ownedUser;
      },
      blockTeacherAuthentication: async () => {},
      resolveTeacherProvisioningRows: async () => null,
      teacherProvisioningDelay: async () => {},
      delegateTeacherFace: async () => { throw new Error("unexpected face rollback"); },
      deleteTeacherProvisioningDatabaseRows: async () => {},
      readTeacherFaceOperation: async () => operation.row,
      teacherOperationOwnsAuthentication: (user) => user === ownedUser,
      deleteTeacherProvisioningAuthentication: async (uid) => {
        assert.equal(uid, "teacher-auth-late");
        authDeleteCalls += 1;
      },
      transitionTeacherFaceOperation: async (target, expected, next, options = {}) => {
        assert.equal(expected, "CANCELLED");
        assert.equal(next, "CANCELLED");
        assert.equal(options.cleanupComplete, true);
        target.status = next;
      },
      archiveTeacherProvisioning: async () => {},
      cloudErrorDetails: (error) => ({ code: error?.code, message: error?.message }),
      requestIdFrom: () => "",
      console: { error() {} }
    };
    vm.createContext(sandbox);
    const compensationSource = between(
      staff, "async function compensateFailedTeacherProvision", "\n\nasync function archiveStoreProvisioning"
    );
    vm.runInContext(`${compensationSource}\nmodule.exports = compensateFailedTeacherProvision;`, sandbox);
    const result = await sandbox.module.exports({
      uid: "teacher-auth-late", phone: "13900000007", authUser: null,
      authCreated: false, faceOperation: operation, staffId: "", teacherId: "",
      actorStaffId: 900, personId: "", teacherName: "迟到老师", image: null,
      originalError: Object.assign(new Error("stale operation"), { code: "STALE_OPERATION" })
    });
    assert.equal(exactReadCalls, 2, "cleanup must re-read Auth after the earlier missing result");
    assert.equal(authDeleteCalls, 1, "the late visible, exactly owned Auth user must be deleted");
    assert.equal(result.authenticationDeleted, true);
  }

  // A row with the same phone but a different UID is not this saga's row.
  // The production discovery query must therefore return no ownership match.
  let discoverySql = "";
  const resolve = runtimeFunction(
    between(staff, "async function resolveTeacherProvisioningRows", "\n\nasync function compensateFailedTeacherProvision"),
    "resolveTeacherProvisioningRows",
    async (sql) => {
      discoverySql = sql;
      const exact = sql.includes("account.auth_uid = 'owned-uid'")
        && sql.includes("account.phone = '13900000007'")
        && sql.includes("AND account.id = 41::bigint")
        && sql.includes("AND teacher.id = 7::bigint")
        && !/account\.auth_uid[^\n]+\n\s+OR account\.phone/.test(sql);
      return exact ? [] : [{ staff_id: 41, teacher_id: 7 }];
    }
  );
  assert.equal(await resolve({
    uid: "owned-uid", phone: "13900000007", staffId: "41", teacherId: "7"
  }), null);
  assert.match(discoverySql, /account\.auth_uid = 'owned-uid'[\s\S]*AND account\.phone = '13900000007'/);

  // The destructive CTE must join the exact account tuple before deleting a
  // teacher. A same-phone/different-UID victim must remain untouched.
  let victimDeleted = false;
  let call = 0;
  const removeRows = runtimeFunction(
    between(staff, "async function deleteTeacherProvisioningDatabaseRows", "\n\nasync function deleteTeacherProvisioningAuthentication"),
    "deleteTeacherProvisioningDatabaseRows",
    async (sql) => {
      call += 1;
      if (call === 1) {
        const exact = sql.includes("USING public.staff_accounts AS account")
          && sql.includes("account.id = teacher.staff_account_id")
          && sql.includes("account.auth_uid = 'owned-uid'")
          && sql.includes("account.phone = '13900000007'")
          && sql.includes("account.role_code = 'teacher'");
        victimDeleted = !exact;
        return [];
      }
      return [];
    }
  );
  await removeRows({
    staffId: "41", teacherId: "7", uid: "owned-uid",
    phone: "13900000007", personId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  });
  assert.equal(victimDeleted, false);

  let victimArchived = false;
  const archive = runtimeFunction(
    between(staff, "async function archiveTeacherProvisioning", "\n\nfunction teacherProvisioningDelay"),
    "archiveTeacherProvisioning",
    async (sql) => {
      const exact = sql.includes("account.id = 41")
        && sql.includes("account.role_code = 'teacher'")
        && sql.includes("account.auth_uid = 'owned-uid'")
        && sql.includes("account.phone = '13900000007'");
      if (!exact) victimArchived = true;
      return [];
    }
  );
  await archive("41", { uid: "owned-uid", phone: "13900000007" });
  assert.equal(victimArchived, false,
    "cleanup-pending archival must not touch a same-phone/different-UID account");

  console.log("teacher face operation lease contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
