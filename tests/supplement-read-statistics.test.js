"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const cloud=fs.readFileSync(require("node:path").resolve(__dirname,"../cloudfunctions/faceRecognition/index.js"),"utf8");
const root=require("node:path").resolve(__dirname,"..");
function webFunction(file,name,next,scope={}){const source=fs.readFileSync(require("node:path").join(root,file),"utf8");const start=source.indexOf(`function ${name}(`),end=source.indexOf(next,start);assert(start>=0&&end>start);const context={...scope};vm.runInNewContext(source.slice(start,end)+`\nthis.run=${name};`,context);return context.run;}
test("Web approved supplement labels match normal without replacing internal types or pending review",()=>{
 const tag=webFunction("query.js","verificationTypeTag","    function rechargeTypeTag");
 assert.equal(tag("SUPPLEMENT","APPROVED"),tag("NORMAL","APPROVED"));
 for(const state of ["PENDING","REJECTED",""])assert.match(tag("SUPPLEMENT",state),/补录核销/);
 assert.match(tag("EXPERIENCE","APPROVED"),/体验核销/);
 const clean=v=>String(v??"").trim(),field=(row,a,b)=>row[a]??row[b]??"";
 for(const type of ["verification","recharge"]){
  const database=webFunction("business-detail.js","normalizeDatabaseOrder","  function normalizeTeacherOrder",{type,clean,field,normalizeProductGifts:()=>[]});
  const teacher=webFunction("business-detail.js","normalizeTeacherOrder","  function ",{type,clean,normalizeProductGifts:()=>[]});
  for(const status of ["APPROVED","PENDING","REJECTED"]){
   const rows=[database({original_type:"SUPPLEMENT",original_status:status}),teacher({originalType:"SUPPLEMENT",recordStatus:status})];
   for(const row of rows){assert.equal(row.originalType,"SUPPLEMENT");assert.equal(row.recordStatus,status);assert.equal(row.originalKind,type==="recharge"?"SUPPLEMENT":status==="APPROVED"?"正常核销":"补录核销");}
  }
 }
 for(const file of ["recharge-query.html","verification-query.html"])assert.match(fs.readFileSync(require("node:path").join(root,file),"utf8"),/query\.js\?v=0\.15\.15/);
 for(const file of ["recharge-detail.html","verification-detail.html"])assert.match(fs.readFileSync(require("node:path").join(root,file),"utf8"),/business-detail\.js\?v=0\.16\.31/);
});
function extract(name,next){const a=cloud.indexOf(`async function ${name}(`),b=cloud.indexOf(next,a);assert(a>=0&&b>a);return cloud.slice(a,b);}
test("teacher active and archived customer counters include approved NORMAL plus SUPPLEMENT without EXPERIENCE",async()=>{
 const queries=[],source=extract("getTeacherBusinessCustomers","\nasync function getTeacherWorkspace");let run;
 vm.runInNewContext(source+"\nrun=getTeacherBusinessCustomers;",{activeTeacherCaller:async()=>({teacherId:"901",staffId:71}),positiveDatabaseId:v=>v,customerListPageSize:()=>10,teacherBusinessCustomerPage:v=>Number(v||1),teacherBusinessAttributionCondition:()=>"trusted_teacher_901",sqlText:v=>`'${v}'`,executeSql:async sql=>{queries.push(sql);return sql.includes("active_total")?[{active_total:1,archived_total:1}]:[{customer_id:"1",customer_code:"QA",customer_name:"合成客户",verification_count:5,experience_count:7,recharge_count:10,customer_status:sql.includes("= 'ACTIVE'")?"ACTIVE":"ARCHIVED"}];},set run(v){run=v;},Number,String,Map,Set,Object,Math});
 const result=await run({});assert.equal(result.active.records[0].verificationCount,5);assert.equal(result.archived.records[0].verificationCount,5);assert.equal(result.active.records[0].experienceCount,7);
 for(const sql of queries){assert.match(sql,/SUM\(event\.unit_count\) FILTER \(WHERE event\.event_type IN \('NORMAL', 'SUPPLEMENT'\)\)/);assert.match(sql,/v\.record_status = 'APPROVED'/);assert.match(sql,/trusted_teacher_901/);assert.doesNotMatch(sql,/\b(?:UPDATE|INSERT|DELETE|ALTER|reset_teacher)\b/i);}
});
test("inactive warnings and exports normalize approved supplement baseline, preserving time and one snapshot",async()=>{
 const queries=[],source=extract("queryInactiveVerificationCustomers","\nfunction lowBalanceCursor");let run;
 vm.runInNewContext(source+"\nrun=queryInactiveVerificationCustomers;",{activeScopedQueryCaller:async()=>({role:"hq",scopeMode:"ALL"}),operationalBalanceCategory:e=>e.balanceCategory||"ALL",inactiveVerificationCursor:()=>({baselineAt:"",customerId:""}),OPERATIONAL_EXPORT_MAX_ROWS:1000,scopedStoreClause:()=>"trusted_scope",sqlText:v=>`'${v}'`,fail:(m)=>{throw Error(m)},executeSql:async sql=>{queries.push(sql);return[{id:1,customer_code:"QA",customer_name:"合成客户",store_id:3,baseline_source:"NORMAL",last_verification_type:"SUPPLEMENT",baseline_at:"2026-01-01T00:00:00Z",cursor_baseline_at:"2026-01-01T00:00:00.000000Z",balance_category:"ZERO",days_since:303,selected_total:1,category_total:1,zero_balance_customers:1,nonzero_balance_customers:0,normal_baseline:1,experience_baseline:0,never_verified:0}];},set run(v){run=v;},Number,String,Map,Set,Object,Math});
 for(const exportAll of [false,true]){const result=await run({minimumDays:30,balanceCategory:"BOTH",exportAll});const rows=exportAll?result.exportCustomers:result.sections.ZERO.customers;assert.equal(rows[0].baselineSource,"NORMAL");assert.equal(rows[0].lastVerificationType,"NORMAL");assert.equal(rows[0].daysSince,303);assert.equal(rows[0].baselineAt,"2026-01-01T00:00:00Z");assert.equal(result.summary.normalBaseline,1);}
 assert.equal(queries.length,2);for(const sql of queries){assert.match(sql,/WHEN latest\.verification_type = 'SUPPLEMENT' THEN 'NORMAL'/);assert.match(sql,/COUNT\(\*\) FILTER \(WHERE baseline_source = 'NORMAL'\) AS normal_baseline/);assert.match(sql,/COALESCE\(latest\.submitted_at, c\.created_at\) AS baseline_at/);assert.match(sql,/v\.record_status = 'APPROVED'/);assert.match(sql,/v\.verification_type IN \('NORMAL', 'SUPPLEMENT', 'EXPERIENCE'\)/);assert.match(sql,/summary AS[\s\S]*page_rows AS/);assert.doesNotMatch(sql,/\b(?:UPDATE|INSERT|DELETE|ALTER)\b/i);}
});
