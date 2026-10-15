"use strict";
// Isolated PostgreSQL/WASM test. No production connection, accounts or photos.
// Development-only dependency: @electric-sql/pglite (resolve through NODE_PATH).
const { PGlite } = require("@electric-sql/pglite");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
async function main() {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE public.staff_accounts (id bigint primary key, role_code text, account_status text);
      CREATE TABLE public.teachers (id bigint primary key, staff_account_id bigint, teacher_status text);
      CREATE TABLE public.teacher_attendance_face_profiles (id bigint primary key, teacher_id bigint, staff_account_id bigint);
      INSERT INTO public.staff_accounts VALUES (1,'teacher','ACTIVE'),(2,'teacher','ARCHIVED');
      INSERT INTO public.teachers VALUES (1,1,'ACTIVE'),(2,2,'ARCHIVED');
      INSERT INTO public.teacher_attendance_face_profiles VALUES (1,1,1),(2,2,2);
      CREATE TABLE public.teacher_attendance_records (id bigserial primary key, teacher_id bigint, staff_account_id bigint,
        attendance_date date, checked_in_at timestamptz, created_at timestamptz, client_request_id text unique);
      INSERT INTO public.teacher_attendance_records(teacher_id,staff_account_id,attendance_date,checked_in_at)
        VALUES(1,1,(CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai')::date-1,CLOCK_TIMESTAMP()-INTERVAL '1 day');`);
    await db.exec(fs.readFileSync(path.join(root, "database/migrations/078_teacher_two_punch_attendance.sql"), "utf8"));
    for (const file of ["088-01-teacher-attendance-photo-schema.sql", "088-02-teacher-attendance-photo-guard.sql"]) {
      await db.exec(fs.readFileSync(path.join(root, "database/cloudbase-console", file), "utf8"));
    }
    assert.equal((await db.query("SELECT photo_object_ref FROM teacher_attendance_records WHERE id=1")).rows[0].photo_object_ref, null);
    const today = "(CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai')::date";
    const ref = `pg://customer-photos/attendance/${"a".repeat(48)}.jpg`;
    async function insert(kind, overrides = {}) {
      const v = { teacher: "1", account: "1", date: today, type: `'${kind}'`, ref: `'${ref}'`, bytes: "1000", sha: `'${"a".repeat(64)}'`, width: "960", height: "1280", at: "CLOCK_TIMESTAMP()", ...overrides };
      return db.query(`INSERT INTO teacher_attendance_records(teacher_id,staff_account_id,attendance_date,attendance_type,
        photo_object_ref,photo_bytes,photo_sha256,photo_width,photo_height,photo_taken_at)
        VALUES(${v.teacher},${v.account},${v.date},${v.type},${v.ref},${v.bytes},${v.sha},${v.width},${v.height},${v.at}) RETURNING id,checked_in_at=photo_taken_at AS same_time`);
    }
    await assert.rejects(insert("CLOCK_OUT"));
    await assert.rejects(insert("CLOCK_IN", { ref: "NULL" }));
    await assert.rejects(insert("CLOCK_IN", { bytes: "524289" }));
    await assert.rejects(insert("CLOCK_IN", { at: "CLOCK_TIMESTAMP()-INTERVAL '3 minutes'" }));
    await assert.rejects(insert("CLOCK_IN", { at: "CLOCK_TIMESTAMP()+INTERVAL '1 minute'" }));
    await assert.rejects(insert("CLOCK_IN", { teacher: "2", account: "2" }));
    const clockIn = (await insert("CLOCK_IN")).rows[0]; assert.equal(clockIn.same_time, true);
    await assert.rejects(insert("CLOCK_IN"));
    const clockOut = (await insert("CLOCK_OUT")).rows[0]; assert.equal(clockOut.same_time, true);
    await assert.rejects(db.query(`UPDATE teacher_attendance_records SET photo_object_ref=NULL WHERE id=${clockIn.id}`));
    await assert.rejects(db.query(`DELETE FROM teacher_attendance_records WHERE id=${clockOut.id}`));
    const checks = await db.query(fs.readFileSync(path.join(root, "database/cloudbase-console/088-readonly-verify.sql"), "utf8"));
    assert.equal(checks.rows.length, 4); assert.ok(checks.rows.every((r) => r.status === "READY"));
    console.log("Isolated PostgreSQL: legacy absence, order, byte limit, timestamp/TTL, archived rejection, two-punch uniqueness, immutable photo and 4 READY checks: PASS");
    const originalRows=await db.query("SELECT * FROM teacher_attendance_records ORDER BY id");
    const guards=()=>db.query("SELECT tgname,pg_get_triggerdef(oid) AS def,pg_get_functiondef(tgfoid) AS func FROM pg_trigger WHERE tgrelid='teacher_attendance_records'::regclass ORDER BY tgname");
    const beforeGuards=await guards();
    await db.exec(fs.readFileSync(path.join(root,"database/cloudbase-console/089-01-teacher-attendance-hd-photo.sql"),"utf8"));
    assert.deepEqual((await db.query("SELECT * FROM teacher_attendance_records ORDER BY id")).rows,originalRows.rows);
    assert.deepEqual((await guards()).rows,beforeGuards.rows);
    await db.exec("INSERT INTO staff_accounts VALUES (3,'teacher','ACTIVE'); INSERT INTO teachers VALUES (3,3,'ACTIVE'); INSERT INTO teacher_attendance_face_profiles VALUES (3,3,3)");
    const hd={teacher:"3",account:"3",width:"2160",height:"3840",bytes:"3145728"};
    await assert.rejects(insert("CLOCK_OUT",hd));
    await assert.rejects(insert("CLOCK_IN",{...hd,bytes:"3145729"}));
    await assert.rejects(insert("CLOCK_IN",{...hd,width:"10001"}));
    await assert.rejects(insert("CLOCK_IN",{...hd,width:"8000",height:"8000"}));
    const hdIn=(await insert("CLOCK_IN",hd)).rows[0]; assert.equal(hdIn.same_time,true);
    await assert.rejects(insert("CLOCK_IN",hd));
    await insert("CLOCK_OUT",hd);
    await assert.rejects(db.query(`UPDATE teacher_attendance_records SET photo_bytes=1000 WHERE id=${hdIn.id}`));
    await assert.rejects(db.query(`DELETE FROM teacher_attendance_records WHERE id=${hdIn.id}`));
    const hdChecks=await db.query(fs.readFileSync(path.join(root,"database/cloudbase-console/089-readonly-verify.sql"),"utf8"));
    assert.equal(hdChecks.rows.length,4); assert.ok(hdChecks.rows.every(r=>r.status==="READY"));
    console.log("089 isolated PostgreSQL: native HD 3 MiB accepted; overflow/order/duplicate/mutation rejected; prior rows and guard definitions unchanged; 4 READY: PASS");
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
