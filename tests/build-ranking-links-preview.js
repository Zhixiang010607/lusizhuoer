"use strict";
// Production home/detail routes with synthetic reads only; all writes rejected.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const result = JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, "build-calendar-controls-preview.js")], { encoding: "utf8" }));
const target = result.project, source = path.resolve(__dirname, "../miniprogram-app/miniprogram");
const manifest = JSON.parse(fs.readFileSync(path.join(target, "source-ui-manifest.json")));
function write(file, value) { fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true }); fs.writeFileSync(path.join(target, file), value); }
for (const file of [...["home", "store-detail"].flatMap(name => ["js", "wxml", "wxss", "json"].map(ext => `pages/${name}/index.${ext}`)), "services/hq-dashboard-report.js"]) {
  const bytes = fs.readFileSync(path.join(source, file)); write(file, bytes);
  const existing = manifest.find(entry => entry.file === file);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (existing) existing.sha256 = digest; else manifest.push({ file, sha256: digest });
}
write("source-ui-manifest.json", JSON.stringify(manifest, null, 2));
write("app.json", JSON.stringify({ pages: ["pages/launcher/index", "pages/home/index", "pages/teacher-detail/index", "pages/store-detail/index"], window: { navigationBarTitleText: "排名链接隔离验收", navigationBarBackgroundColor: "#302a22", navigationBarTextStyle: "white" }, style: "v2" }));
write("project.config.json", JSON.stringify({ appid: "wxb053c1bd6c684d8b", projectname: "Lusizhuoer ranking links QA", compileType: "miniprogram", libVersion: "3.17.1", setting: { es6: true, enhance: true } }));
write("services/session.js", "exports.requireSession=()=>({role:'hq',staffName:'隔离总部'});exports.waitForStartupSession=async()=>{};exports.getSelectedStore=()=>null;exports.signOut=async()=>{throw Error('离线禁止业务操作')};");
write("pages/launcher/index.wxml", '<view class="page"><view class="card"><text>纯合成排名，不连接生产业务、不写账号或核销。</text><button data-state="populated" bindtap="open">完整排名：21条</button><button data-state="empty" bindtap="open">完整排名：空记录</button><button data-state="error" bindtap="open">完整排名：读取失败</button></view></view>');
write("pages/launcher/index.js", "Page({open(e){wx.setStorageSync('qaState',e.currentTarget.dataset.state);wx.navigateTo({url:'/pages/home/index'})}});");
const api = fs.readFileSync(path.join(target, "services/api.js"), "utf8");
write("services/api.js", api + `
const calendarStaff=exports.callStaff,calendarFace=exports.callFace;
exports.callStaff=async(action,payload={})=>{
 if(action==='getHqDashboard'){
  const state=wx.getStorageSync('qaState');if(state==='error')throw Error('合成排名读取失败');
  const totals={recharge:60,verification:20,experience:5,refund:1};
  if(payload.mode==='overview')return{totals};
  if(payload.mode==='product-summary')return{productSummary:{total:1,pageNumber:1,pageSize:10,totalPages:1,rows:[{entityId:'1',entityName:'海洋之蕴',...totals}]}};
  const total=state==='empty'?0:21,page=Number(payload.pageNumber||1),teacher=payload.dimension==='teacher';
  return{ranking:{dimension:payload.dimension,rankingMetric:payload.rankingMetric,productId:payload.productId||'',total,pageNumber:page,pageSize:10,totalPages:Math.max(1,Math.ceil(total/10)),rows:Array.from({length:Math.max(0,Math.min(10,total-(page-1)*10))},(_,i)=>({entityId:teacher&&i===9?'0':String((teacher?901:301)+(page-1)*10+i),entityCode:teacher&&i===9?'UNASSIGNED':(teacher?'TCH-QA':'STR-QA')+String((page-1)*10+i+1).padStart(3,'0'),entityName:teacher&&i===9?'未指定老师':(teacher?'隔离测试老师':'隔离测试门店')+String((page-1)*10+i+1),recharge:60-i,verification:20-i,experience:5,refund:1}))}};
 }
 if(action==='listStaff'){const r=await calendarStaff(action,payload);return{...r,staff:Array.from({length:21},(_,i)=>({...r.staff[0],id:String(71+i),teacher_id:String(901+i),teacher_name:'隔离测试老师'+(i+1),teacher_code:'TCH-QA'+String(i+1).padStart(3,'0')}))};}
 if(action==='listStores')return{stores:Array.from({length:21},(_,i)=>({id:String(301+i),store_code:'STR-QA'+String(i+1).padStart(3,'0'),store_name:'隔离测试门店'+(i+1),store_status:'ACTIVE',contact_phone:'00000000000'}))};
 return calendarStaff(action,payload);
};
exports.callFace=async(action,payload={})=>{
 if(action==='getStoreDashboard')return{store:{id:'301',store_name:'隔离测试门店',store_code:'STR-QA001',store_status:'ACTIVE'}};
 if(action==='getStoreBusinessAnalytics')return{totals:{},products:[]};
 if(action==='queryStoreBusinessRecords')return{records:[],page:1,pageSize:10,total:0,totalPages:1};
 return calendarFace(action,payload);
};`);
console.log(JSON.stringify({ project: target, productionFiles: manifest.length, businessNetwork: "none", writes: "none" }));
