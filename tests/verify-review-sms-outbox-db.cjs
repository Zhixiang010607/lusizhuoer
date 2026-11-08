'use strict';
// Isolated PostgreSQL only. Never opens a production connection or sends SMS.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const {PGlite}=require(path.resolve(process.argv[2]));const db=new PGlite();let checks=0;
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE staff_accounts(id bigint PRIMARY KEY,auth_uid text,staff_name text,phone text,role_code text,account_status text);
 INSERT INTO staff_accounts VALUES(1,'hq-a','总部甲','13800000001','hq','ACTIVE'),(2,'hq-b','总部乙','+8613800000002','hq','ACTIVE'),(3,'teacher','老师','13800000003','teacher','ACTIVE'),(4,'archived','封存总部','13800000004','hq','ARCHIVED');
 CREATE TABLE retail_product_purchase_records(id bigint PRIMARY KEY,record_status text,submitted_at timestamptz DEFAULT clock_timestamp());
 CREATE TABLE recharge_records(id bigint PRIMARY KEY,record_status text,recharge_type text,submitted_at timestamptz DEFAULT clock_timestamp());
 CREATE TABLE verification_records(id bigint PRIMARY KEY,record_status text,verification_type text,void_request_status text DEFAULT 'NONE',submitted_at timestamptz DEFAULT clock_timestamp());
 INSERT INTO recharge_records(id,record_status,recharge_type) VALUES(1,'PENDING','NEW');`);
 for(const file of ['094-01-hq-review-sms-preferences.sql','095-01-hq-review-sms-categories.sql','096-01-hq-review-sms-outbox.sql'])await db.exec(fs.readFileSync('database/cloudbase-console/'+file,'utf8'));
 const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
 const scalar=async(sql,args=[])=>(await q(sql,args))[0].v;
 const count=()=>scalar('SELECT count(*)::int AS v FROM hq_review_sms_outbox');
 const set=async(id,cats)=>q('SELECT set_hq_review_sms_categories_v95($1,$2,$3,$4,$5,$6)',['hq-a',id,...cats]);
 const claim=token=>scalar('SELECT claim_hq_review_sms_v96($1) AS v',[token]);
 const start=(id,token)=>scalar('SELECT start_hq_review_sms_v96($1,$2) AS v',[id,token]);
 const finish=(id,token,status,code='Ok',serial='serial')=>scalar('SELECT finish_hq_review_sms_v96($1,$2,$3,$4,$5,$6) AS v',[id,token,status,code,'request',serial]);
 const status=id=>scalar('SELECT status AS v FROM hq_review_sms_outbox WHERE id=$1',[id]);
 const token='a'.repeat(32),other='b'.repeat(32);
 assert.equal(await count(),0);checks++;
 await set(1,[true,true,true,true]);await set(2,[false,true,false,true]);
 await db.exec("INSERT INTO recharge_records(id,record_status,recharge_type) VALUES(2,'PENDING','NEW')");
 assert.equal(await count(),0);checks++; // disabled means no queue/backfill
 await db.exec("UPDATE hq_review_sms_delivery_state SET enabled=true,activated_at=clock_timestamp()");
 assert.equal(await count(),0);checks++;
 await db.exec(`INSERT INTO retail_product_purchase_records(id,record_status) VALUES(10,'PENDING'),(11,'APPROVED');
 INSERT INTO recharge_records(id,record_status,recharge_type) VALUES(10,'PENDING','NEW'),(11,'PENDING','REFUND'),(12,'APPROVED','NEW'),(13,'PENDING','GIFT');
 INSERT INTO verification_records(id,record_status,verification_type) VALUES(10,'PENDING','SUPPLEMENT'),(11,'APPROVED','NORMAL'),(12,'APPROVED','EXPERIENCE');
 INSERT INTO verification_records(id,record_status,verification_type,void_request_status) VALUES(13,'PENDING','SUPPLEMENT','PENDING');
 INSERT INTO recharge_records(id,record_status,recharge_type,submitted_at) VALUES(14,'PENDING','NEW','2020-01-01');`);
 assert.equal(await count(),6);checks++;
 assert.deepEqual(await q('SELECT category,count(*)::int AS n FROM hq_review_sms_outbox GROUP BY category ORDER BY category'),[{category:'purchase',n:1},{category:'recharge',n:2},{category:'refund',n:1},{category:'verification',n:2}]);checks++;
 const claimed=await claim(token);assert.equal(claimed.category,'purchase');checks++;
 const second=await claim(other);assert.notEqual(claimed.id,second.id);checks++;
 assert.equal(await start(claimed.id,other),false);checks++;
 assert.equal(await start(claimed.id,token),true);checks++;
 assert.equal(await start(claimed.id,token),false);checks++;
 assert.equal(await finish(claimed.id,other,'ACCEPTED'),false);checks++;
 await assert.rejects(finish(claimed.id,token,'ACCEPTED','Ok',''),/SMS_UNCONFIRMED_ACCEPTANCE/);checks++;
 assert.equal(await finish(claimed.id,token,'ACCEPTED'),true);checks++;
 assert.equal(await finish(claimed.id,token,'UNKNOWN'),false);checks++;
 assert.equal(await status(claimed.id),'ACCEPTED');checks++;
 // Revoking a category after claim cancels before send.
 await set(1,[true,false,true,true]);assert.equal(await start(second.id,other),false);checks++;
 assert.equal(await status(second.id),'CANCELLED');checks++;
 const changedPhone=await claim(token);await db.exec("UPDATE staff_accounts SET phone='13800000009' WHERE id=2");
 assert.equal(await start(changedPhone.id,token),false);checks++;
 const reviewed=await claim(token);await db.exec("UPDATE recharge_records SET record_status='APPROVED' WHERE id=11");
 assert.equal(await start(reviewed.id,token),false);checks++;
 const archived=await claim(token);await db.exec("UPDATE staff_accounts SET account_status='ARCHIVED' WHERE id=1");
 assert.equal(await start(archived.id,token),false);checks++;
 // Remaining queued recipient has a changed phone, hence skipped.
 assert.deepEqual(await claim(token),{skipped:true});checks++;
 assert.equal(await claim(token),null);checks++;
 await db.exec("UPDATE staff_accounts SET account_status='ACTIVE',phone='13800000001' WHERE id=1");
 await set(1,[true,true,true,true]);
 await db.exec("INSERT INTO recharge_records(id,record_status,recharge_type) VALUES(20,'PENDING','NEW')");
 const interrupted=await claim(token);assert.equal(await start(interrupted.id,token),true);checks++;
 await db.exec(`UPDATE hq_review_sms_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${interrupted.id}`);
 // Recover claims that never sent; mark interrupted sends UNKNOWN, never requeue.
 const next=await claim(other);assert.equal(await status(interrupted.id),'UNKNOWN');checks++;
 assert.notEqual(next.id,interrupted.id);checks++;
 await db.exec(`UPDATE hq_review_sms_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${next.id}`);
 const recovered=await claim(token);assert.equal(recovered.id,next.id);checks++;
 assert.equal(await start(recovered.id,other),false);checks++;
 await db.exec("UPDATE hq_review_sms_delivery_state SET enabled=false");
 assert.equal(await start(recovered.id,token),false);checks++;
 // Re-enabling cannot send old activation-era jobs.
 await db.exec("UPDATE hq_review_sms_delivery_state SET enabled=true,activated_at=clock_timestamp()");
 await db.exec("INSERT INTO recharge_records(id,record_status,recharge_type) VALUES(21,'PENDING','NEW')");
 const expired=await claim(token);await db.exec(`UPDATE hq_review_sms_outbox SET created_at=clock_timestamp()-interval '25 hours' WHERE id=${expired.id}`);
 assert.equal(await start(expired.id,token),false);checks++;
 await assert.rejects(q("SELECT claim_hq_review_sms_v96('wrong')"),/SMS_INVALID_LEASE/);checks++;
 for(const role of ['anon','authenticated']) {
  await db.exec('SET ROLE '+role);
  for(const sql of ["SELECT * FROM hq_review_sms_outbox","SELECT * FROM hq_review_sms_delivery_state",`SELECT claim_hq_review_sms_v96('${token}')`,`SELECT start_hq_review_sms_v96(1,'${token}')`,`SELECT finish_hq_review_sms_v96(1,'${token}','ACCEPTED','Ok','req','serial')`]){await assert.rejects(q(sql),/permission denied/);checks++;}
  await db.exec('RESET ROLE');
 }
 // No financial rows are updated by any worker transition.
 assert.equal(await scalar('SELECT count(*)::int AS v FROM recharge_records'),9);checks++;
 assert.equal(await scalar('SELECT count(*)::int AS v FROM verification_records'),4);checks++;
 console.log(JSON.stringify({postgres:'isolated PGlite',checks,productionWrites:0,smsSent:0}));await db.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
