'use strict';
// Isolated PostgreSQL only. Does not read credentials, connect to production, or load an SMS SDK.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const {PGlite}=require(path.resolve(process.argv[2]));
  const db=new PGlite(); let checks=0;
  const read=name=>fs.readFileSync('database/cloudbase-console/'+name,'utf8');
  const scalar=async sql=>(await db.query(sql)).rows[0].v;
  const query=async sql=>(await db.query(sql)).rows;
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    REVOKE ALL ON SCHEMA public FROM PUBLIC,anon,authenticated;
    CREATE TABLE staff_accounts(id bigint PRIMARY KEY,auth_uid text,staff_name text,phone text,role_code text,account_status text);
    INSERT INTO staff_accounts VALUES(1,'isolated-hq','隔离总部','13800000001','hq','ACTIVE');
    CREATE TABLE retail_product_purchase_records(id bigint PRIMARY KEY,record_status text,submitted_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE recharge_records(id bigint PRIMARY KEY,record_status text,recharge_type text,submitted_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE verification_records(id bigint PRIMARY KEY,record_status text,verification_type text,void_request_status text DEFAULT 'NONE',submitted_at timestamptz DEFAULT clock_timestamp());
    INSERT INTO recharge_records(id,record_status,recharge_type) VALUES(1,'PENDING','NEW');`);
  for(const name of ['094-01-hq-review-sms-preferences.sql','095-01-hq-review-sms-categories.sql','096-01-hq-review-sms-outbox.sql']) await db.exec(read(name));
  const fingerprints=async()=>query(`SELECT 'staff' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) AS data FROM staff_accounts t
    UNION ALL SELECT 'preferences',coalesce(jsonb_agg(to_jsonb(t) ORDER BY staff_account_id),'[]'::jsonb) FROM hq_review_sms_preferences t
    UNION ALL SELECT 'recharge',coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM recharge_records t
    UNION ALL SELECT 'verification',coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM verification_records t
    UNION ALL SELECT 'purchase',coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM retail_product_purchase_records t`);
  const definitions=async()=>query(`SELECT proname,md5(pg_get_functiondef(p.oid)) AS hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname LIKE '%sms%' ORDER BY proname`);
  const sequences=()=>query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
  const before=await fingerprints(),funcs=await definitions(),seq=await sequences();
  let preview=(await query(read('097-preview.sql')))[0].preview;
  assert.equal(preview.delivery.enabled,false); checks++;
  assert.equal(preview.active_preferences.any_enabled,0); checks++;
  assert.deepEqual(preview.outbox,{}); checks++;
  await db.exec(read('097-01-enable-hq-review-sms.sql'));
  for(const r of await query(read('097-readonly-verify.sql'))){assert.equal(r.status,'READY',r.check_name);checks++;}
  assert.deepEqual(await fingerprints(),before);checks++;
  assert.deepEqual(await definitions(),funcs);checks++;
  assert.deepEqual(await sequences(),seq);checks++;
  assert.equal(await scalar('SELECT count(*)::int AS v FROM hq_review_sms_outbox'),0);checks++;
  const activated=await scalar('SELECT activated_at::text AS v FROM hq_review_sms_delivery_state');
  await assert.rejects(db.exec(read('097-01-enable-hq-review-sms.sql')),/SMS_FIRST_ACTIVATION_STATE_MISMATCH/);checks++;
  await db.exec('ROLLBACK');
  assert.equal(await scalar('SELECT activated_at::text AS v FROM hq_review_sms_delivery_state'),activated);checks++;
  await db.exec(read('097-02-disable-hq-review-sms.sql'));
  for(const r of await query(read('097-disabled-readonly-verify.sql'))){assert.equal(r.status,'READY',r.check_name);checks++;}
  assert.equal(await scalar('SELECT activated_at::text AS v FROM hq_review_sms_delivery_state'),activated);checks++;
  assert.deepEqual(await fingerprints(),before);checks++;
  assert.deepEqual(await definitions(),funcs);checks++;
  assert.deepEqual(await sequences(),seq);checks++;
  // Stop is idempotent. First-activation SQL cannot silently reactivate an old era.
  await db.exec(read('097-02-disable-hq-review-sms.sql'));checks++;
  await assert.rejects(db.exec(read('097-01-enable-hq-review-sms.sql')),/SMS_FIRST_ACTIVATION_STATE_MISMATCH/);checks++;
  await db.exec('ROLLBACK');
  // Simulate interrupted preflight states; every failure rolls back atomically.
  await db.exec("UPDATE hq_review_sms_delivery_state SET activated_at=NULL,sdk_app_id='1400000000'");
  await assert.rejects(db.exec(read('097-01-enable-hq-review-sms.sql')),/SMS_FIRST_ACTIVATION_STATE_MISMATCH/);checks++;
  await db.exec('ROLLBACK');
  await db.exec("UPDATE hq_review_sms_delivery_state SET sdk_app_id='1401179904'; INSERT INTO hq_review_sms_outbox(category,source_record_id,recipient_account_id,phone_snapshot) VALUES('recharge',1,1,'+8613800000001')");
  await assert.rejects(db.exec(read('097-01-enable-hq-review-sms.sql')),/SMS_FIRST_ACTIVATION_REQUIRES_EMPTY_OUTBOX/);checks++;
  await db.exec('ROLLBACK');
  assert.equal(await scalar('SELECT enabled AS v FROM hq_review_sms_delivery_state'),false);checks++;
  // Stop preserves a queued job but eligibility must immediately reject it.
  const queueBefore=await query('SELECT * FROM hq_review_sms_outbox');
  await db.exec(read('097-02-disable-hq-review-sms.sql'));
  assert.deepEqual(await query('SELECT * FROM hq_review_sms_outbox'),queueBefore);checks++;
  for(const r of await query(read('097-disabled-readonly-verify.sql'))){assert.equal(r.status,'READY',r.check_name);checks++;}
  await db.exec('DELETE FROM hq_review_sms_outbox; ALTER TABLE recharge_records DISABLE TRIGGER enqueue_recharge_review_sms');
  await assert.rejects(db.exec(read('097-01-enable-hq-review-sms.sql')),/SMS_INSERT_TRIGGERS_NOT_READY/);checks++;
  await db.exec('ROLLBACK');
  assert.equal(await scalar('SELECT enabled AS v FROM hq_review_sms_delivery_state'),false);checks++;
  await db.exec(`ALTER TABLE recharge_records ENABLE TRIGGER enqueue_recharge_review_sms;
    CREATE OR REPLACE FUNCTION hq_review_sms_phone_v96(p_phone text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::text $$;`);
  await assert.rejects(db.exec(read('097-01-enable-hq-review-sms.sql')),/SMS_ROUTINE_BODY_CHANGED_REVIEW_REQUIRED/);checks++;
  await db.exec('ROLLBACK');
  assert.equal(await scalar('SELECT enabled AS v FROM hq_review_sms_delivery_state'),false);checks++;
  console.log(JSON.stringify({postgres:'isolated PGlite',checks,productionWrites:0,smsSent:0}));
  await db.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
