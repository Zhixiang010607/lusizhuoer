'use strict';
// Isolated PostgreSQL. Never connects to production or sends messages.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const{PGlite}=require(path.resolve(process.argv[2]));const db=new PGlite();let checks=0;
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE TABLE staff_accounts(id bigint PRIMARY KEY,auth_uid text,staff_name text,phone text,role_code text,account_status text);
    INSERT INTO staff_accounts VALUES(1,'hq-one','总部一','13800000001','hq','ACTIVE'),(2,'hq-two','总部二','13800000002','hq','ACTIVE'),(3,'teacher','老师','13800000003','teacher','ACTIVE'),(4,'store','门店','13800000004','store','ACTIVE'),(5,'archived','封存总部','13800000005','hq','ARCHIVED');`);
  const before=await db.query('SELECT * FROM staff_accounts ORDER BY id');
  await db.exec(fs.readFileSync('database/cloudbase-console/094-01-hq-review-sms-preferences.sql','utf8'));
  await db.exec(fs.readFileSync('database/cloudbase-console/095-01-hq-review-sms-categories.sql','utf8'));
  const get=async(actor,id)=>(await db.query('SELECT public.get_hq_review_sms_preference_v94($1,$2) AS p',[actor,id])).rows[0].p;
  const set=async(actor,id,value)=>(await db.query('SELECT public.set_hq_review_sms_preference_v94($1,$2,$3) AS p',[actor,id,value])).rows[0].p;
  assert.equal((await get('hq-one',2)).enabled,false);checks++;
  assert.equal((await get('hq-two',1)).enabled,false);checks++;
  assert.equal((await get('hq-one',2)).phone,'138****0002');checks++;
  assert.equal((await set('hq-one',2,true)).enabled,true);checks++;
  assert.equal((await get('hq-two',2)).enabled,true);checks++;
  assert.equal((await set('hq-two',2,false)).enabled,false);checks++;
  assert.equal((await set('hq-two',1,true)).enabled,true);checks++;
  assert.equal((await get('hq-one',1)).deliveryReady,false);checks++;
  assert.equal((await db.query('SELECT updated_by_account_id FROM hq_review_sms_preferences WHERE staff_account_id=1')).rows[0].updated_by_account_id,2);checks++;
  for(const actor of ['teacher','store','archived','missing']){
    await assert.rejects(get(actor,2),/SMS_ONLY_ACTIVE_HQ/);checks++;
    await assert.rejects(set(actor,2,true),/SMS_ONLY_ACTIVE_HQ/);checks++;
  }
  for(const id of [3,4,999]){await assert.rejects(set('hq-one',id,true),/SMS_HQ_NOT_FOUND/);checks++;}
  await assert.rejects(set('hq-one',5,true),/SMS_HQ_ARCHIVED/);checks++;
  assert.equal((await set('hq-one',5,false)).enabled,false);checks++;
  await assert.rejects(set('hq-one',2,null),/SMS_INVALID_STATE/);checks++;
  await db.exec("SET ROLE anon");await assert.rejects(db.query("SELECT public.set_hq_review_sms_preference_v94('hq-one',2,true)"),/permission denied/);checks++;
  await assert.rejects(db.query('SELECT * FROM hq_review_sms_preferences'),/permission denied/);checks++;
  await db.exec('RESET ROLE; SET ROLE authenticated');await assert.rejects(db.query("SELECT public.get_hq_review_sms_preference_v94('hq-one',2)"),/permission denied/);checks++;
  await db.exec('RESET ROLE');
  assert.deepEqual((await db.query('SELECT * FROM staff_accounts ORDER BY id')).rows,before.rows);checks++;
  const verify=await db.query(fs.readFileSync('database/cloudbase-console/094-readonly-verify.sql','utf8'));
  assert.equal(verify.rows.length,5);assert(verify.rows.every(r=>r.status==='READY'));checks+=5;
  await db.query('SELECT public.set_hq_review_sms_categories_v95($1,$2,$3,$4,$5,$6)',['hq-one',2,true,false,true,false]);
  assert.deepEqual((await get('hq-two',2)).categories,{purchase:true,recharge:false,refund:true,verification:false});checks++;
  assert.equal((await get('hq-two',2)).enabled,true);checks++;
  await set('hq-two',2,false);assert(Object.values((await get('hq-one',2)).categories).every(v=>v===false));checks++;
  const v95=await db.query(fs.readFileSync('database/cloudbase-console/095-readonly-verify.sql','utf8'));assert(v95.rows.every(r=>r.status==='READY'));checks+=3;
  console.log(JSON.stringify({postgres:'isolated PGlite',checks,productionWrites:0,smsSent:0}));await db.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
