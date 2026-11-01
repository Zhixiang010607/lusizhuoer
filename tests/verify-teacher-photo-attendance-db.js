"use strict";
// Optional integration check: pass a temporary @electric-sql/pglite module path.
// Runs genuine PostgreSQL PL/pgSQL locally; never opens a production connection.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { PGlite } = require(process.argv[2] || "@electric-sql/pglite");
const read = p => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
(async () => {
  const db = new PGlite(), passed = [];
  const exec = sql => db.exec(sql);
  const rows = async sql => (await db.query(sql)).rows;
  await exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.staff_accounts(id BIGINT PRIMARY KEY, role_code TEXT, account_status TEXT);
    CREATE TABLE public.teachers(id BIGINT PRIMARY KEY, staff_account_id BIGINT, teacher_status TEXT);
    INSERT INTO staff_accounts VALUES (1,'teacher','ACTIVE'),(2,'teacher','ACTIVE'),
      (3,'teacher','ACTIVE'),(4,'teacher','ARCHIVED'),(5,'store','ACTIVE');
    INSERT INTO teachers VALUES (1,1,'ACTIVE'),(2,2,'ACTIVE'),(3,3,'ACTIVE'),(4,4,'ACTIVE'),(5,5,'ACTIVE');
    CREATE TABLE verification_records(id INT PRIMARY KEY, sentinel TEXT);
    INSERT INTO verification_records VALUES (7,'customer verification must stay unchanged');`);
  for (const p of ["075_teacher_attendance", "078_teacher_two_punch_attendance", "081_teacher_attendance_readable_address"]) await exec(read(`database/migrations/${p}.sql`));
  await exec(`INSERT INTO teacher_attendance_face_profiles
    (teacher_id,staff_account_id,face_person_id,face_id,profile_photo_file_id,enrolled_by_account_id,consent_at)
    VALUES(1,1,'synthetic-person','face-test','pg://synthetic/profile.jpg',1,CLOCK_TIMESTAMP());
    INSERT INTO teacher_attendance_records
    (teacher_id,staff_account_id,attendance_date,latitude,longitude,accuracy_m,face_score,face_request_id,client_request_id)
    VALUES(1,1,(CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai')::date,30,120,10,98,'legacy-request','legacy-punch');`);
  for (const p of ["088_teacher_attendance_photo_evidence", "089_teacher_attendance_hd_photo"]) await exec(read(`database/migrations/${p}.sql`));
  const before = (await rows(read("database/cloudbase-console/090-preview.sql").split("SELECT tgname")[0]))[0];
  const protectedBefore = await rows("SELECT * FROM verification_records");
  const photoGuard = (await rows("SELECT md5(pg_get_functiondef('enforce_teacher_attendance_photo_v88()'::regprocedure)) AS hash"))[0].hash;
  await exec(read("database/migrations/090_teacher_photo_attendance.sql"));
  const after = (await rows(read("database/cloudbase-console/090-preview.sql").split("SELECT tgname")[0]))[0];
  assert.deepEqual(after, before); passed.push("historical rows, absent photos and digest unchanged");
  assert.deepEqual(await rows("SELECT * FROM verification_records"), protectedBefore);
  assert.equal((await rows("SELECT md5(pg_get_functiondef('enforce_teacher_attendance_photo_v88()'::regprocedure)) AS hash"))[0].hash, photoGuard);
  passed.push("customer sentinel and private-photo guard unchanged");
  const checks = await rows(read("database/cloudbase-console/090-readonly-verify.sql"));
  assert.equal(checks.length, 4); checks.forEach(c => assert.equal(c.status, "READY"));
  passed.push("four independent readiness checks");
  const insert = (id, type = "CLOCK_IN", overrides = {}) => {
    const v = { teacher_id: id, staff_account_id: id, attendance_date: "(CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai')::date",
      attendance_type: `'${type}'`, attendance_method: "'PHOTO'", latitude: 30, longitude: 120, accuracy_m: 10,
      face_score: "NULL", face_request_id: "NULL", quality_score: "NULL", liveness_score: "NULL",
      client_request_id: `'synthetic_${id}_${type}'`, photo_object_ref: `'pg://synthetic/attendance/${"a".repeat(48)}.jpg'`,
      photo_bytes: 1024, photo_sha256: `'${"b".repeat(64)}'`, photo_width: 320, photo_height: 480,
      photo_taken_at: "CLOCK_TIMESTAMP() - INTERVAL '1 millisecond'", ...overrides };
    return `INSERT INTO teacher_attendance_records (${Object.keys(v).join(",")}) VALUES (${Object.values(v).join(",")}) RETURNING *`;
  };
  async function reject(name, sql, pattern) { await assert.rejects(exec(sql), pattern); passed.push(name); }
  await reject("clock-out before clock-in denied", insert(3, "CLOCK_OUT"), /earlier same-day clock-in/);
  await reject("archived teacher denied", insert(4), /active teachers/);
  await reject("store caller denied", insert(5), /active teachers/);
  await reject("wrong teacher/account pair denied", insert(3, "CLOCK_IN", { staff_account_id: 2 }), /active teachers/);
  await reject("historical date denied", insert(3, "CLOCK_IN", { attendance_date: "CURRENT_DATE - 7" }), /current Shanghai date/);
  await reject("missing private photo denied", insert(3, "CLOCK_IN", { photo_object_ref: "NULL" }), /private photo evidence/);
  await reject("fabricated face score denied", insert(3, "CLOCK_IN", { face_score: 100 }), /method_check_v90/);
  await reject("oversized photo denied", insert(3, "CLOCK_IN", { photo_bytes: 3145729 }), /photo_check_v89/);
  await reject("expired photo time denied", insert(3, "CLOCK_IN", { photo_taken_at: "CLOCK_TIMESTAMP() - INTERVAL '3 minutes'" }), /recent server time/);
  const created = (await rows(insert(2)))[0];
  assert.equal(created.face_score, null); assert.equal(created.face_request_id, null);
  assert.equal(created.attendance_method, "PHOTO");
  assert.equal(created.checked_in_at.getTime(), created.photo_taken_at.getTime());
  passed.push("teacher without face enrollment creates PHOTO with null audits and shared time");
  await reject("duplicate clock-in denied", insert(2), /duplicate key/);
  await rows(insert(2, "CLOCK_OUT")); passed.push("clock-out after same-day clock-in succeeds");
  await reject("new PHOTO record immutable", "UPDATE teacher_attendance_records SET accuracy_m=11 WHERE staff_account_id=2", /immutable/);
  await reject("history cannot be deleted", "DELETE FROM teacher_attendance_records WHERE staff_account_id=1", /immutable/);
  await reject("legacy FACE still requires profile", insert(3, "CLOCK_IN", { attendance_method: "'FACE'", face_score: 99, face_request_id: "'legacy'" }), /enrolled profile/);
  for (const role of ["anon", "authenticated"]) {
    const [p] = await rows(`SELECT has_table_privilege('${role}','teacher_attendance_records','SELECT,INSERT,UPDATE,DELETE') AS allowed`);
    assert.equal(p.allowed, false);
  }
  passed.push("anonymous/authenticated table access remains denied");
  await db.close(); console.log(JSON.stringify({ postgres: "isolated PGlite", productionWrites: 0, checks: passed.length, passed }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
