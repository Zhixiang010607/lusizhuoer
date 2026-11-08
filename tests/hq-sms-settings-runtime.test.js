"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const root=path.resolve(__dirname,"..");
const categories={purchase:true,recharge:false,refund:true,verification:false};
const preference={staffAccountId:"2",name:"合成总部二",phone:"138****0002",active:true,categories};
function mini(callStaff,authorized=true){let def;vm.runInNewContext(fs.readFileSync(path.join(root,"miniprogram-app/miniprogram/pages/hq-sms-settings/index.js"),"utf8"),{
  require:id=>id.endsWith("/api")?{callStaff}:{requireSession:()=>authorized?{role:"hq"}:null},Page:d=>{def=d;}});
 return{...def,data:JSON.parse(JSON.stringify(def.data)),setData(p){Object.assign(this.data,p);}};
}
test("mini HQ settings load independent choices and send all four boolean values",async()=>{
 const calls=[];const p=mini(async(a,payload)=>{calls.push({a,payload});return{preference};});p.onLoad({staffAccountId:"2"});await p.load();
 assert.equal(p.data.loaded,true);assert.deepEqual(Array.from(p.data.categories,v=>v.checked),[true,false,true,false]);
 p.changeCategories({detail:{value:["recharge"]}});await p.save();
 assert.deepEqual(JSON.parse(JSON.stringify(calls[1].payload)),{staffAccountId:"2",categories:{purchase:false,recharge:true,refund:false,verification:false}});
 assert.equal(p.data.message,"设置已保存");
});
test("mini uncertain save requires readback and never automatically repeats a mutation",async()=>{
 let writes=0;const p=mini(async action=>{if(action.startsWith("set")){writes++;throw Error("network lost");}return{preference};});p.onLoad({staffAccountId:"2"});await p.load();await p.save();await p.save();assert.equal(writes,1);assert.equal(p.data.loaded,false);assert.match(p.data.message,/重新读取/);await p.load();assert.equal(p.data.loaded,true);
});
test("mini store/teacher denial and unloaded requests never produce UI success or a write",async()=>{
 let calls=0;const p=mini(async()=>{calls++;return{preference};},false);p.onLoad({staffAccountId:"2"});await p.load();await p.save();assert.equal(calls,0);
 let resolve;const q=mini(()=>new Promise(r=>{resolve=r;}));q.onLoad({staffAccountId:"2"});const read=q.load();q.onUnload();resolve({preference});await read;assert.equal(q.data.loaded,false);
});
test("web switching targets discards stale reads and saves the selected HQ only",async()=>{
 const ids=["hqSmsSettings","hqSmsForm","hqSmsTarget","hqSmsPhone","hqSmsSave","hqSmsStatus","hqSmsClose","entityInfo",...Object.keys(categories).map(k=>`hqSms-${k}`)];const nodes=Object.fromEntries(ids.map(id=>[id,{textContent:"",checked:false,disabled:false,handlers:{},scrollIntoView(){},addEventListener(n,f){this.handlers[n]=f;}}]));const requests=[];let apiResolve;
 const window={CloudBasePhoneAuth:{getHqReviewSmsPreference:({staffAccountId})=>staffAccountId==="1"?new Promise(r=>{apiResolve=r;}):Promise.resolve({preference}),setHqReviewSmsPreference:async payload=>{requests.push(payload);return{preference};}}};
 vm.runInNewContext(fs.readFileSync(path.join(root,"hq-sms-settings.js"),"utf8"),{window,document:{body:{dataset:{management:"hq"}},getElementById:id=>nodes[id]}});
 const a=window.HqSmsSettings.open({staffAccountId:"1",name:"旧目标"});await window.HqSmsSettings.open({staffAccountId:"2",name:"新目标"});apiResolve({preference:{...preference,staffAccountId:"1",name:"旧目标"}});await a;
 assert.equal(nodes.hqSmsTarget.textContent,"合成总部二 · 审核短信");nodes["hqSms-purchase"].checked=false;nodes["hqSms-recharge"].checked=true;
 await nodes.hqSmsForm.handlers.submit({preventDefault(){}});assert.equal(requests.length,1);assert.deepEqual(JSON.parse(JSON.stringify(requests[0])),{staffAccountId:"2",categories:{purchase:false,recharge:true,refund:true,verification:false}});
});
