"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = p => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const dashboard = require("../miniprogram-app/miniprogram/services/home-dashboard");
const fail = (message, code) => { throw Object.assign(Error(message), {code}); };
function backend(role = "hq") {
  const queries = [];
  const context = {
    ...require("../cloudfunctions/faceRecognition/teacher-customer-lookup"),
    fail, sqlText: x => `'${x}'`, positiveDatabaseId(x) { if (!/^[1-9]\d*$/.test(String(x))) fail("invalid", "BAD_REQUEST"); return String(x); },
    businessQueryDatabaseId: x => String(x), optionalBusinessQueryDate: x => x || "", scopedQueryCursorTimestamp: x => x || "",
    activeScopedQueryCaller: async () => ({ role }), activeTeacherCaller: async () => ({role:"teacher", teacherId:"7", teacherName:"自己"}),
    teacherBusinessAttributionCondition: (who, alias) => `${alias}.teacher_id = '${who.teacherId}'::bigint AND trusted_source`,
    teacherBusinessAttributionSourceCondition: () => "trusted_source",
    parsedProductGiftRows: () => [],
    requireTeacherExperienceQuotaLifecycleSchema: async () => {},
    executeSql: async sql => {
      queries.push(sql);
      if (/LEFT JOIN public.staff_accounts a ON a.id = t.staff_account_id/.test(sql)) return [{teacher_id:"91",teacher_name:"目标老师",staff_id:71,role_code:"teacher"}];
      if (/SELECT COUNT\(\*\) AS total/.test(sql)) return [{total:11}];
      if (/AS record_code/.test(sql)) return [{id:91, record_code:"QA-91",unit_count:1}];
      if (/AS verification_count/.test(sql)) return [{product_id:1,product_name:"样例项目",verification_count:1}];
      return [];
    }
  };
  const options = cloud.slice(cloud.indexOf("const TEACHER_WORKSPACE_TYPES"), cloud.indexOf("function teacherBusinessCustomerPage"));
  const action = cloud.slice(cloud.indexOf("async function getTeacherWorkspace"), cloud.indexOf("async function deleteFacePerson"));
  vm.runInNewContext(options + "\n" + action + "\nthis.hq=getHqTeacherWorkspace;this.own=getTeacherWorkspace;", context);
  return {...context, queries};
}
test("HQ teacher overview resolves an explicit master and reads the original attribution without any write/reset", async () => {
  const api = backend();
  const result = await api.hq({teacherId:"91",recordType:"VERIFICATION",page:2,pageSize:10,includeOverview:true,startDate:"2026-10-01",endDate:"2026-10-31"});
  assert.equal(result.profile.teacherId,"91"); assert.equal(result.page.page,2); assert.equal(result.page.pageSize,10);
  assert.equal(result.summary.products[0].verification,1);
  const sql=api.queries.join("\n");
  assert.match(sql,/v.teacher_id = '91'::bigint AND trusted_source/);
  assert.match(sql,/v.record_status = 'APPROVED'/); assert.match(sql,/OFFSET 10/);
  assert.match(sql,/Asia\/Shanghai/);
  assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE)\b|reset_teacher_experience_quota/);
  assert.equal(result.experienceBalances.length,0,"HQ uses the existing entitlement view, not stale/raw quota balances");
});
test("store and teacher cannot select a teacher through the HQ action", async () => {
  for(const role of ["store","teacher"]) { const api=backend(role); await assert.rejects(api.hq({teacherId:"91"}),{code:"FORBIDDEN"}); assert.equal(api.queries.length,0); }
});
test("HQ action rejects invalid targets and a new detail shortcut", async () => {
  const api=backend();
  await assert.rejects(api.hq({teacherId:"91 OR TRUE"}),{code:"BAD_REQUEST"});
  await assert.rejects(api.hq({teacherId:"91",recordId:"5"}),{code:"BAD_REQUEST"});
  assert.equal(api.queries.length,0);
});
test("existing teacher route ignores spoofed target identity and preserves its own quota lifecycle", async () => {
  const api=backend(); const result=await api.own({teacherId:"91",hqTarget:{teacherId:"91"},recordType:"VERIFICATION",page:1,pageSize:10,includeOverview:true});
  assert.equal(result.profile.teacherId,"7"); assert.match(api.queries.join("\n"),/reset_teacher_experience_quota/);
  assert.match(api.queries.join("\n"),/v.teacher_id = '7'::bigint/);
  assert.match(cloud,/if \(action === "getTeacherWorkspace"\) return await getTeacherWorkspace\(event\);/);
});
function component(api) {
  let definition; const links=[];
  vm.runInNewContext(read("miniprogram-app/miniprogram/components/teacher-workspace/index.js"),{
    Component(value){definition=value;},wx:{navigateTo:x=>links.push(x.url)},require(id){if(id.endsWith("/api"))return{callFace:api};if(id.endsWith("/home-dashboard"))return dashboard;throw Error(id);}
  });
  const c={...definition.methods,data:{...structuredClone(definition.data),teacherId:"91"},_ready:true};
  c.setData=p=>Object.assign(c.data,p); return {c,definition,links};
}
function response(payload) { return {profile:{teacherId:payload.teacherId},summary:{products:[{productId:"1",productName:"样例项目",verification:11}],totals:{verification:11}},page:{page:payload.page,pageSize:10,total:11,totalPages:2,records:[{id:"3",recordCode:"QA-3",customerCode:"QA-C",unitCount:1}]}}; }
test("HQ component sends the chosen teacher and one common time range with ten-row pages; links preserve original detail types",async()=>{
  const calls=[];const {c,links}=component(async(action,payload)=>{calls.push({action,...payload});return response(payload);});
  await c.load(1); await c.nextPage(); assert.equal(c.data.page.page,2);
  await c.selectType({currentTarget:{dataset:{type:"EXPERIENCE"}}});
  assert.equal(calls[2].page,1);assert.equal(calls[2].teacherId,"91");assert.equal(calls[2].pageSize,10);
  assert.equal(calls[2].startDate,calls[2].endDate);assert.ok(calls.every(x=>x.action==="getHqTeacherWorkspace"));
  c.openOrder({currentTarget:{dataset:{id:"3"}}});assert.match(links[0],/type=verification&category=EXPERIENCE&recordId=3/);
  c.openCustomer({currentTarget:{dataset:{code:"QA-C"}}});assert.match(links[1],/customerCode=QA-C/);
  c.inputPage({detail:{value:"2"}});await c.jumpPage();assert.equal(c.data.page.page,2);
});
test("out-of-order responses, detach, and target mismatches cannot repaint the wrong teacher",async()=>{
  const pending=[];const {c,definition}=component((action,payload)=>new Promise(resolve=>pending.push({payload,resolve})));
  const old=c.load(1);const newer=c.load(2);pending[1].resolve(response(pending[1].payload));await newer;pending[0].resolve(response(pending[0].payload));await old;assert.equal(c.data.page.page,2);
  const gone=c.load(1);definition.lifetimes.detached.call(c);pending[2].resolve(response(pending[2].payload));await gone;assert.equal(c.data.page.page,2);
  c._ready=true;const mismatch=c.load(1);pending[3].resolve({...response(pending[3].payload),profile:{teacherId:"99"}});await mismatch;assert.equal(c.data.rows.length,0);assert.ok(c.data.error);
});
test("custom dates invalidate pending reads and reject future/reversed/missing dates without network traffic",async()=>{
  let count=0;const {c}=component(async(action,payload)=>{count++;return response(payload);});
  await c.chooseRange({currentTarget:{dataset:{preset:"CUSTOM"}}});assert.equal(count,0);
  c.data.startDate="2099-01-01";c.data.endDate="2099-01-02";await c.applyRange();assert.equal(count,0);assert.ok(c.data.error);
});
test("teacher home is a real fourth bounded tab, uses only HQ reads, sequence and shared responsive pagination",()=>{
  const view=read("miniprogram-app/miniprogram/pages/teacher-detail/index.wxml"),page=read("miniprogram-app/miniprogram/pages/teacher-detail/index.js"),style=read("miniprogram-app/miniprogram/pages/teacher-detail/index.wxss");
  assert.match(page,/activeSection: "home"/);assert.match(page,/\["home", "basic", "configuration", "work"\]/);
  assert.ok(view.indexOf('data-section="home"')<view.indexOf('data-section="basic"'));
  assert.match(style,/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);assert.match(style,/white-space: nowrap/);
  const componentView=read("miniprogram-app/miniprogram/components/teacher-workspace/index.wxml");
  assert.match(componentView,/index \+ 1/);assert.match(componentView,/customer-page-controls/);assert.match(componentView,/bindconfirm="jumpPage"/);
  assert.match(componentView,/tableHeight \? tableHeight \+ 'px'/,"native measured height must prevent tablet row clipping or excess space");
  assert.match(read("miniprogram-app/miniprogram/components/teacher-workspace/index.wxss"),/@import "\.\.\/\.\.\/pages\/home\/index.wxss"/);
});
