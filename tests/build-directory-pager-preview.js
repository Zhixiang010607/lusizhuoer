"use strict";
// Generated native preview only: exact production page + read-only fake API, no CloudBase SDK.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "miniprogram-app/miniprogram");
const target = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), "lusizhuoer-directory-ui-"));
if (process.argv[2] && (!target.startsWith(os.tmpdir()) || !path.basename(target).startsWith("lusizhuoer-directory-ui-") || !fs.existsSync(path.join(target, "source-ui-manifest.json")))) throw new Error("Not an isolated directory preview");
fs.mkdirSync(path.join(target, "pages/hq-directory"), { recursive: true });
fs.mkdirSync(path.join(target, "pages/customer-detail"), { recursive: true });
fs.mkdirSync(path.join(target, "pages/launcher"), { recursive: true });
fs.mkdirSync(path.join(target, "services"), { recursive: true });
const names = ["app.wxss", "services/query-tools.js", ...["hq-directory", "customer-detail"].flatMap(page => ["js", "wxml", "wxss", "json"].map(ext => `pages/${page}/index.${ext}`))];
const manifest = names.map(name => {
  const bytes = fs.readFileSync(path.join(source, name)); fs.writeFileSync(path.join(target, name), bytes);
  return { file: name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
});
const appid = JSON.parse(fs.readFileSync(path.join(root, "miniprogram-app/project.config.json"))).appid;
if (appid !== "wxb053c1bd6c684d8b") throw new Error("Unexpected app identity");
fs.writeFileSync(path.join(target, "project.config.json"), JSON.stringify({ appid, projectname: "Lusizhuoer directory pager QA", compileType: "miniprogram", setting: { es6: true, enhance: true }, libVersion: "3.17.1" }, null, 2));
fs.writeFileSync(path.join(target, "app.json"), JSON.stringify({ pages: ["pages/launcher/index", "pages/hq-directory/index", "pages/customer-detail/index"], window: { navigationBarTitleText: "隔离管理分页样例", navigationBarBackgroundColor: "#302a22", navigationBarTextStyle: "white" }, style: "v2" }, null, 2));
fs.writeFileSync(path.join(target, "app.js"), "App({});\n");
fs.writeFileSync(path.join(target, "services/session.js"), "exports.requireSession=()=>({role:'hq'});\n");
fs.writeFileSync(path.join(target, "services/api.js"), `exports.callStaff=async(action,event={})=>{
 if(action!=='listStaff'&&action!=='listStores')throw Error('隔离预览禁止业务操作');
 if(action==='listStaff'&&event.role!=='teacher')throw Error('仅测试老师目录');
 const mode=wx.getStorageSync('qaScenario')||'normal';
 const count=mode==='empty'?0:mode==='single'?1:mode==='long'?2001:21;
 const rows=Array.from({length:count*2},(_,i)=>({id:'QA-'+i,teacher_id:'QA-T'+i,auth_uid:'QA-U'+i,staff_name:'测试老师'+(i+1),store_name:'测试门店'+(i+1),contact_name:'测试联系人'+(i+1),phone:'000'+String(i+1).padStart(8,'0'),contact_phone:'000'+String(i+1).padStart(8,'0'),store_status:i<count?'ACTIVE':'ARCHIVED',account_status:i<count?'ACTIVE':'ARCHIVED',teacher_status:i<count?'ACTIVE':'ARCHIVED',address_detail:'隔离样例地址，不连接云端'}));
 return action==='listStaff'?{staff:rows}:{stores:rows};
};
exports.callFace=async(action,event={})=>{
 if(action==='getCustomerProfile')return {customer:{customerCode:event.customerCode,customerName:'隔离样例客户',birthDate:'1990-01-01',storeName:'测试门店',notes:'隔离样例备注，不连接云端'}};
 if(action==='getCustomerPhotoUrl')throw Error('本样例不读取真实照片');
 if(action==='listCustomerMessages'){
  const mode=wx.getStorageSync('qaScenario'), count=mode==='emptyMessages'?0:mode==='oneMessage'?1:20;
  return {totalCount:count,page:{hasMore:false},messages:Array.from({length:count},(_,i)=>({id:'QA-M'+i,authorName:'测试老师',authorRole:'teacher',createdAt:'2026-10-31T01:00:00Z',content:'第'+(i+1)+'条隔离测试留言。用于检查换行和展示高度。'.repeat(i===0?3:1)}))};
 }
 throw Error('隔离预览禁止业务写入');
};\n`);
const entries = [["老师管理", "teacher", "normal"], ["门店管理", "store", "normal"], ["老师管理空结果", "teacher", "empty"], ["老师管理单条", "teacher", "single"], ["老师管理三位页码", "teacher", "long"], ["客户留言空框", "customer", "emptyMessages"], ["客户留言一条", "customer", "oneMessage"], ["客户留言二十条", "customer", "manyMessages"]];
fs.writeFileSync(path.join(target, "pages/launcher/index.wxml"), '<view class="page"><view class="card"><text>隔离样例，不连接云端；页面和分页逻辑与生产一致</text>'+entries.map(([label,type,scenario])=>`<button data-type="${type}" data-scenario="${scenario}" bindtap="open">${label}</button>`).join("")+'</view></view>');
fs.writeFileSync(path.join(target, "pages/launcher/index.wxss"), "button{margin:16rpx 0;}\n");
fs.writeFileSync(path.join(target, "pages/launcher/index.json"), "{}\n");
fs.writeFileSync(path.join(target, "pages/launcher/index.js"), "Page({open(e){wx.setStorageSync('qaScenario',e.currentTarget.dataset.scenario);wx.navigateTo({url:e.currentTarget.dataset.type==='customer'?'/pages/customer-detail/index?customerCode=QA-CUSTOMER':'/pages/hq-directory/index?type='+e.currentTarget.dataset.type})}});\n");
fs.writeFileSync(path.join(target, "source-ui-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ project: target, byteIdenticalProductionFiles: manifest.length, network: "none", pageLogic: "unchanged production JS" }));
