"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHqReviewSms } = require("../cloudfunctions/staffAccount/hq-review-sms");
const fail = (m, code) => { throw Object.assign(Error(m), { code }); };
function fixture(executeSql) {
  return createHqReviewSms({ executeSql, fail,
    requireHq: c => { if (c.profile?.role !== "hq") fail("forbidden", "FORBIDDEN"); },
    numericId: x => { const n=Number(x); if (!Number.isSafeInteger(n)||n<=0) fail("id", "BAD_REQUEST"); return n; },
    sqlText: x => `'${String(x).replaceAll("'", "''")}'` });
}
test("any HQ can edit another HQ; target and actor remain separate and sends stay disabled", async () => {
  const queries=[]; const service=fixture(async q => { queries.push(q); return [{preference: JSON.stringify({ staffAccountId:"2",enabled:true,deliveryReady:true })}]; });
  const p=await service.run({uid:"hq-one",profile:{role:"hq"}},{staffAccountId:2,enabled:true},true);
  assert.equal(p.enabled,true); assert.equal(p.deliveryReady,false);
  assert.match(queries[0],/set_hq_review_sms_categories_v95\('hq-one',2,TRUE,TRUE,TRUE,TRUE\)/);
});
test("teacher/store and invalid target or nonboolean state never reach SQL", async () => {
  let n=0; const service=fixture(async()=>{n++;});
  for (const role of ["teacher","store",undefined]) await assert.rejects(service.run({profile:{role}},{staffAccountId:2,enabled:true},true),{code:"FORBIDDEN"});
  const hq={uid:"hq",profile:{role:"hq"}};
  for(const id of [0,-1,"1;DELETE",Number.MAX_SAFE_INTEGER+1]) await assert.rejects(service.run(hq,{staffAccountId:id,enabled:true},true),{code:"BAD_REQUEST"});
  for(const enabled of [null,"true",1,undefined]) await assert.rejects(service.run(hq,{staffAccountId:2,enabled},true),{code:"BAD_REQUEST"});
  assert.equal(n,0);
});
test("unknown writes never return fabricated success or trigger a retry", async()=>{
  let n=0;const service=fixture(async()=>{n++;return [];});
  await assert.rejects(service.run({uid:"hq",profile:{role:"hq"}},{staffAccountId:2,enabled:true},true),{code:"SMS_PREFERENCE_UNCONFIRMED"});assert.equal(n,1);
  const wrong=fixture(async()=>[{preference:{staffAccountId:"9",enabled:false}}]);
  await assert.rejects(wrong.run({uid:"hq",profile:{role:"hq"}},{staffAccountId:2}),{code:"SMS_PREFERENCE_UNCONFIRMED"});
});
test("database identity rejections remain failures",async()=>{
  for(const [message,code] of [["SMS_ONLY_ACTIVE_HQ","FORBIDDEN"],["SMS_HQ_NOT_FOUND","NOT_FOUND"],["SMS_HQ_ARCHIVED","BAD_REQUEST"]]){
    const service=fixture(async()=>{throw Error(message);});
    await assert.rejects(service.run({uid:"hq",profile:{role:"hq"}},{staffAccountId:2,enabled:true},true),{code});
  }
});

test("four audit categories persist independently and invalid partial payloads never reach SQL",async()=>{
  const queries=[];const categories={purchase:true,recharge:false,refund:true,verification:false};
  const service=fixture(async q=>{queries.push(q);return[{preference:{staffAccountId:"2",enabled:true,categories}}];});
  const hq={uid:"hq-one",profile:{role:"hq"}};
  assert.deepEqual((await service.run(hq,{staffAccountId:2,categories},true)).categories,categories);
  assert.match(queries[0],/set_hq_review_sms_categories_v95\('hq-one',2,TRUE,FALSE,TRUE,FALSE\)/);
  for(const bad of [{purchase:true},{...categories,refund:"true"},{...categories,extra:true},[]]) await assert.rejects(service.run(hq,{staffAccountId:2,categories:bad},true),{code:"BAD_REQUEST"});
  assert.equal(queries.length,1);
});
