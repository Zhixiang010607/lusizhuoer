"use strict";
// Genuine PostgreSQL parsing/execution against isolated synthetic rows only.
// Usage: node tests/verify-business-submission-recovery-db.js /path/to/pglite
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const { PGlite } = require(process.argv[2] || "@electric-sql/pglite");
const read = name => fs.readFileSync(path.resolve(__dirname, "..", name), "utf8");
(async () => {
  const db = new PGlite(), source = read("cloudfunctions/faceRecognition/index.js");
  const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const recovery = part("async function recoverBusinessSubmission(event)", "async function getCustomerProductBalances(event)");
  const attribution = part("function teacherBusinessAttributionSourceCondition(", "function trustedBusinessTeacherIdSql(");
  await db.exec(`CREATE TABLE staff_accounts(id BIGINT PRIMARY KEY,role_code TEXT);
    CREATE TABLE teachers(id BIGINT PRIMARY KEY,staff_account_id BIGINT,teacher_code TEXT,teacher_name TEXT);
    CREATE TABLE customers(id BIGINT PRIMARY KEY,customer_code TEXT,customer_name TEXT);
    CREATE TABLE products(id BIGINT PRIMARY KEY,product_code TEXT,product_name TEXT);
    CREATE TABLE teacher_product_experience_quotas(id BIGINT PRIMARY KEY);
    CREATE TABLE verification_records(id BIGINT PRIMARY KEY,verification_code TEXT,verification_type TEXT,store_id BIGINT,
      teacher_id BIGINT,customer_id BIGINT,product_id BIGINT,unit_count INTEGER,record_status TEXT,
      submitted_by_account_id BIGINT,submitted_at TIMESTAMPTZ,idempotency_key TEXT);
    CREATE TABLE device_signal_outbox(id BIGINT PRIMARY KEY,verification_id BIGINT,signal_type TEXT,signal_status TEXT,created_at TIMESTAMPTZ);
    INSERT INTO staff_accounts VALUES(17,'teacher'); INSERT INTO teachers VALUES(7,17,'QA-T','合成老师');
    INSERT INTO customers VALUES(1,'QA-C','合成客户'); INSERT INTO products VALUES(1,'QA-P','合成项目');
    INSERT INTO teacher_product_experience_quotas VALUES(1);`);
  const canonical = read("database/cloudbase-console/046-03-experience-quota-tables.sql");
  const quotaStart = canonical.indexOf("CREATE TABLE IF NOT EXISTS public.teacher_experience_quota_usages");
  assert.ok(quotaStart >= 0);
  await db.exec(canonical.slice(quotaStart, canonical.indexOf(";", quotaStart) + 1));
  let lastSql = "", caller = { staffId: 17, storeId: 9 };
  const sandbox = {
    activeBusinessCaller: async () => caller,
    rechargeSubmissionKey: value => `key:${value}`, sqlText: value => "'" + String(value).replace(/'/g, "''") + "'",
    fail(message, code) { throw Object.assign(new Error(message), { code }); },
    executeSql: async sql => { lastSql = sql; return (await db.query(sql)).rows; }
  };
  vm.runInNewContext(attribution + recovery + "\nthis.recover = recoverBusinessSubmission;", sandbox);
  const recover = (type = "SUPPLEMENT", id = "original") => sandbox.recover({ recordType: type, clientRequestId: id });
  assert.equal((await recover()).found, false);
  await assert.rejects(db.query(lastSql.replace("usage.verification_id AS quota_usage_id", "usage.id AS quota_usage_id")), error => error.code === "42703");
  const checks = ["empty query parses against canonical quota schema; obsolete usage.id fails even without rows"];
  await db.exec(`INSERT INTO verification_records VALUES(1,'QA-V','SUPPLEMENT',9,7,1,1,2,'PENDING',17,NOW(),'key:original');`);
  for (const status of ["PENDING", "REJECTED", "APPROVED"]) {
    await db.query("UPDATE verification_records SET record_status=$1", [status]);
    const before = (await db.query("SELECT * FROM verification_records")).rows;
    const result = await recover();
    assert.equal(result.found, true); assert.equal(result.complete, true);
    assert.equal(result.verificationId, "1"); assert.equal(result.recordStatus, status); assert.equal(result.deviceSignal, null);
    assert.deepEqual((await db.query("SELECT * FROM verification_records")).rows, before);
  }
  checks.push("three supplement states recover original order read-only without device signal or quota usage");
  await assert.rejects(recover("VERIFICATION"), error => error.code === "IDEMPOTENCY_CONFLICT");
  for (const denied of [{ staffId: 18, storeId: 9 }, { staffId: 17, storeId: 8 }]) {
    caller = denied; await assert.rejects(recover(), error => error.code === "FORBIDDEN");
  }
  caller = { staffId: 17, storeId: 9 }; checks.push("wrong family, caller and store cannot recover or acknowledge order");
  await db.exec("UPDATE verification_records SET verification_type='NORMAL'");
  assert.equal((await recover("VERIFICATION")).complete, false);
  await db.exec("INSERT INTO device_signal_outbox VALUES(1,1,'START','PENDING',NOW())");
  assert.equal((await recover("VERIFICATION")).complete, true);
  await assert.rejects(recover(), error => error.code === "IDEMPOTENCY_CONFLICT");
  checks.push("normal verification still requires device signal; supplement cannot recover normal order");
  await db.exec("UPDATE verification_records SET verification_type='EXPERIENCE'");
  assert.equal((await recover("VERIFICATION")).complete, false);
  await db.exec(`INSERT INTO teacher_experience_quota_usages
    (verification_id,quota_id,teacher_id,product_id,quota_month,available_before_count,available_after_count)
    VALUES(1,1,7,1,'2026-11-01',3,2)`);
  const result = await recover("VERIFICATION"); assert.equal(result.complete, true);
  assert.equal(result.experienceQuota.availableBeforeCount, 3); assert.equal(result.experienceQuota.availableAfterCount, 2);
  await db.exec("DELETE FROM device_signal_outbox"); assert.equal((await recover("VERIFICATION")).complete, false);
  checks.push("experience requires both real quota verification_id and device signal");
  await db.close(); console.log(JSON.stringify({ postgres: "isolated PGlite", productionWrites: 0, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
