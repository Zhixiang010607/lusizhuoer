"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),test=require("node:test");
const mini=path.resolve(__dirname,"../miniprogram-app/miniprogram");
const read=file=>fs.readFileSync(path.join(mini,file),"utf8");
function harness(role="teacher",enabled=true){
  let definition;const calls=[],navigation=[];
  const session={requireSession:roles=>!roles||roles.includes(role)?{role}:null,waitForStartupSession:async()=>{}};
  const api={async callStaff(action,payload){calls.push({action,payload});if(action==="getTeamAccess")return{isTeamLeader:enabled};if(!enabled)throw Object.assign(new Error("组长权限已取消"),{code:"FORBIDDEN"});
    if(action==="getTeamTeacherProfile")return{teacher:{teacherId:"7",teacherName:"成员老师",phone:"00000000007",teacherStatus:"ACTIVE",accountStatus:"ACTIVE"}};
    if(action==="getTeamTeacherEntitlements")return{entitlements:[]};if(action==="getTeamTeacherWorkMonth")return{serverToday:"2026-11-06",teacher:{employmentStartDate:"2026-01-01"},attendance:[],reports:[]};throw new Error("Unexpected actor route "+action);},async callFace(action,payload){calls.push({action,payload});assert.equal(action,"getTeamTeacherWorkspace");return{profile:{teacherId:"7"},page:{records:[],page:1,total:0,totalPages:1},summary:{products:[],totals:{}}};}};
  api.callRating=async(action,payload)=>{calls.push({action,payload});if(!enabled)throw Object.assign(new Error("组长已取消"),{code:"FORBIDDEN"});if(action==='getTeamRatingAnalysisOptions')return{stores:[],products:[{id:'1',name:'样例项目'}],teachers:[{id:'7',name:'成员'}]};if(action==='queryTeamRatingAnalysis')return{orders:[{id:'1',customerCode:'QA-C',customerName:'组内客户',effectiveScore:4}],summary:{total:1,rated:1,scoreCounts:[0,0,0,0,1,0]},total:1,totalPages:1,pageNumber:1};throw Error('Unexpected rating action '+action);};
  const helperContext={module:{exports:{}},require:id=>id==="./api"?api:session};vm.runInNewContext(read("services/teacher-team.js"),helperContext);
  const wx={navigateTo:value=>navigation.push(value.url),setNavigationBarTitle(){},getStorageSync(){},stopPullDownRefresh(){},showToast(){},nextTick(){},showModal(o){o.success({confirm:true});}};
  function dependencies(id){if(id.endsWith("/api"))return api;if(id.endsWith("/session"))return session;if(id.endsWith("/teacher-team"))return helperContext.module.exports;if(id.endsWith("/teacher-experience-recharge"))return{};return require(path.join(mini,"services",path.basename(id)));}
  return {calls,navigation,helper:helperContext.module.exports,setEnabled:value=>{enabled=value;},page(file){vm.runInNewContext(read(file),{Page:v=>{definition=v;},require:dependencies,wx,console,Date,Math,Map,Set,setTimeout,clearTimeout,decodeURIComponent,encodeURIComponent});const page={...definition,data:JSON.parse(JSON.stringify(definition.data)),setData(patch,done){Object.assign(this.data,patch);done?.();}};return page;},component(){vm.runInNewContext(read("components/teacher-workspace/index.js"),{Component:v=>{definition=v;},require:dependencies,wx,console});return{...definition.methods,data:{...JSON.parse(JSON.stringify(definition.data)),teacherId:"7",viewerMode:"TEAM"},_ready:true,setData(patch,done){Object.assign(this.data,patch);done?.();}};}};
}
test("group capability requires both teacher session and current server permission",async()=>{
  for(const role of ["hq","store"]){const h=harness(role);await assert.rejects(()=>h.helper.requireTeamAccess());assert.equal(h.calls.length,0);}
  const h=harness("teacher",false);await assert.rejects(()=>h.helper.requireTeamAccess());assert.equal(h.calls[0].action,"getTeamAccess");
});
test("member page reuses only home/work tabs and invokes no HQ staff or product read",async()=>{
  const h=harness(),p=h.page("pages/teacher-detail/index.js");await p.onLoad({scope:"TEAM",teacherId:"7"});assert.equal(p.data.staff.teacher_id,"7");
  for(const section of ["basic","configuration","personnel"]){p.switchSection({currentTarget:{dataset:{section}}});assert.equal(p.data.activeSection,"home");}
  await p.toggleTeamLeader();assert.ok(h.calls.every(c=>["getTeamAccess","getTeamTeacherProfile","getTeamTeacherEntitlements"].includes(c.action)));
  p.setData({activeSection:"work"});await p.loadWorkMonth();assert.equal(h.calls.at(-1).action,"getTeamTeacherWorkMonth");
  const view=read("pages/teacher-detail/index.wxml");for(const section of ["basic","configuration"]){assert.ok(view.includes(`!teamScope && activeSection === '${section}'`));}
});
test("a revoked member view clears profile, calendar, quotas and removes its workspace",async()=>{
  const h=harness(),p=h.page("pages/teacher-detail/index.js");await p.onLoad({scope:"TEAM",teacherId:"7"});h.setEnabled(false);await p.loadTeamProfile();assert.equal(p.data.staff,null);assert.equal(p.data.calendarDays.length,0);assert.equal(p.data.entitlements.length,0);assert.equal(p.data.selectedWorkDay,null);
});
test("teacher workspace in member mode uses the scoped route and exposes no customer/order navigation",async()=>{
  const h=harness(),c=h.component();await c.load();assert.equal(h.calls[0].action,"getTeamTeacherWorkspace");c.data.rows=[{id:"1",recordCode:"QA1",type:"VERIFICATION"}];c.openOrder({currentTarget:{dataset:{id:"1"}}});c.openCustomer({currentTarget:{dataset:{code:"QA-C"}}});assert.equal(h.navigation.length,0);
});
test("group ranking links resolve only present teacher rows to two-tab member view",async()=>{
  const h=harness(),p=h.page("pages/team-dashboard/index.js");p.setData({authorized:true,hqDimension:"teacher",hqRanking:[{entityId:"7"}]});
  await p.openHqRankedProfile({currentTarget:{dataset:{dimension:"store",id:"7"}}});await p.openHqRankedProfile({currentTarget:{dataset:{dimension:"teacher",id:"8"}}});assert.equal(h.navigation.length,0);
  await p.openHqRankedProfile({currentTarget:{dataset:{dimension:"teacher",id:"7"}}});assert.equal(h.navigation[0],"/pages/teacher-detail/index?scope=TEAM&teacherId=7");
});
test("new member read errors never return raw database diagnostics",async()=>{
  const fail=(message,code)=>{throw Object.assign(new Error(message),{code});};const staff=require("../cloudfunctions/staffAccount/teacher-team").createTeacherTeams({fail});const face=require("../cloudfunctions/faceRecognition/teacher-team").createTeacherTeamReads({fail});
  for(const service of [staff,face])await assert.rejects(()=>service.safeRead(async()=>{throw Object.assign(new Error("column private_table.secret does not exist"),{code:"DATABASE_ERROR"});}),error=>error.code==="TEAM_SERVICE_UNAVAILABLE"&&!error.message.includes("private_table"));
});
test("member directory rejects invalid page input and preserves the scoped search when paging",()=>{
  const h=harness(),p=h.page("pages/team-operations/index.js"),requests=[];p.reload=page=>requests.push(page);p.setData({members:{page:2,totalPages:3,total:21},keyword:"成员",membersInput:"4"});p.jumpPage();assert.equal(requests.length,0);p.changePageInput({detail:{value:"1"}});p.jumpPage();p.movePage({currentTarget:{dataset:{delta:1}}});assert.deepEqual(requests,[1,3]);assert.equal(p.data.keyword,"成员");p.setData({loading:true,membersInput:"2"});p.jumpPage();assert.equal(requests.length,2);
  const template=read("pages/team-operations/index.wxml");assert.ok(!template.includes("<team-pager"));assert.equal((template.match(/bindtap="jumpPage"/g)||[]).length,1);
});

test("leader rating page uses dedicated read routes and never opens customer, order or exports",async()=>{
  const h=harness(),p=h.page("pages/rating-analysis/index.js");await p.onLoad({scope:"TEAM"});await p.load();assert.equal(p.data.orders.length,1);
  p.openCustomer({currentTarget:{dataset:{code:"QA-C"}}});p.openOrder({currentTarget:{dataset:{id:"1"}}});await p.exportAll();
  assert.equal(h.navigation.length,0);assert.ok(h.calls.every(c=>["getTeamAccess","getTeamRatingAnalysisOptions","queryTeamRatingAnalysis"].includes(c.action)));
  h.setEnabled(false);await p.load();assert.equal(p.data.orders.length,0);assert.equal(p.data.summary.total,0);assert.equal(p.data.error,true);
});
test("ordinary teacher cannot enter rating analysis via a forged group URL",async()=>{
  const h=harness("teacher",false),p=h.page("pages/rating-analysis/index.js");await p.onLoad({scope:"TEAM"});assert.equal(p.data.orders.length,0);assert.equal(p.data.error,true);assert.equal(h.calls.length,1);
});
test("activity, balance and rating share exactly the same UID-derived customer scope module",()=>{
  const a=fs.readFileSync(path.resolve(__dirname,'../cloudfunctions/faceRecognition/teacher-team.js'),'utf8');
  const b=fs.readFileSync(path.resolve(__dirname,'../cloudfunctions/customerRating/teacher-team.js'),'utf8');assert.equal(a,b);
});
