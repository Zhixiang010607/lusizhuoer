"use strict";
// Offline native QA: unchanged production pages, read-only synthetic responses, no cloud SDK.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const source = path.resolve(__dirname, "../miniprogram-app/miniprogram");
const target = fs.mkdtempSync(path.join(os.tmpdir(), "lusizhuoer-store-tabs-ui-"));
const files = ["app.wxss", "services/home-dashboard.js", "services/query-tools.js", "services/customer-age.js",
  ...["home", "store-detail"].flatMap(page => ["js", "wxml", "wxss", "json"].map(ext => `pages/${page}/index.${ext}`)),
  ...["js", "wxml", "wxss", "json"].map(ext => `components/project-summary/index.${ext}`)];
const manifest = files.map(file => {
  const bytes = fs.readFileSync(path.join(source, file));
  fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
  fs.writeFileSync(path.join(target, file), bytes);
  return { file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
});
function write(file, value) { fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true }); fs.writeFileSync(path.join(target, file), value); }
write("project.config.json", JSON.stringify({appid:"wxb053c1bd6c684d8b", projectname:"Lusizhuoer store customer tabs QA", compileType:"miniprogram", libVersion:"3.17.1", setting:{es6:true,enhance:true}}));
write("app.json",JSON.stringify({pages:["pages/launcher/index","pages/home/index","pages/store-detail/index"],window:{navigationBarTitleText:"离线门店切换样例",navigationBarBackgroundColor:"#302a22",navigationBarTextStyle:"white"},style:"v2"}));
write("app.js","App({});\n");
write("services/hq-dashboard-report.js","exports.createReportPdf=()=>{throw Error('离线样例不导出业务资料')};\n");
write("services/session.js",`exports.waitForStartupSession=async()=>{};exports.requireSession=()=>({role:wx.getStorageSync('qaRole')||'store',storeName:'隔离测试门店',storeCode:'QA-STORE'});exports.getSelectedStore=()=>null;exports.signOut=()=>{throw Error('离线样例不操作真实登录')};\n`);
write("services/api.js",`const totalFor=status=>wx.getStorageSync('qaEmpty')?0:status==='ACTIVE'?21:12;
const rowsFor=(status,page)=>Array.from({length:Math.min(10,Math.max(0,totalFor(status)-(page-1)*10))},(_,i)=>({customerCode:'QA-'+status+'-'+((page-1)*10+i+1),customerName:(status==='ACTIVE'?'活跃':'封存')+'样例'+((page-1)*10+i+1),birthDate:'1990-01-01',rechargeCount:20,verificationCount:i}));
exports.callStaff=async action=>{if(action!=='listStores')throw Error('隔离样例禁止账号写入');return{stores:[{id:'901',auth_uid:'QA-U',store_code:'QA-STORE',store_name:'隔离测试门店'}]}};
exports.callFace=async(action,event={})=>{
 if(action==='getStoreDashboard'){const ap=Number(event.activeCustomerPage||1),zp=Number(event.archivedCustomerPage||1);return{store:{id:'901',store_name:'隔离测试门店',store_code:'QA-STORE',store_status:'ACTIVE',address_detail:'离线样例地址',contact_name:'测试联系人',contact_phone:'00000000000',customers:rowsFor('ACTIVE',ap),customer_total:totalFor('ACTIVE'),customer_page:ap,customer_page_size:10,archived_customers:rowsFor('ARCHIVED',zp),archived_customer_total:totalFor('ARCHIVED'),archived_customer_page:zp,archived_customer_page_size:10}};}
 if(action==='getStoreBusinessAnalytics')return{products:[],totals:{}};
 if(action==='queryStoreBusinessRecords')return{records:[],page:1,pageSize:10,total:0};
 throw Error('离线样例禁止业务操作');
};\n`);
write("pages/launcher/index.json","{}");
write("pages/launcher/index.wxss","button{margin:16rpx 0;}");
write("pages/launcher/index.wxml",'<view class="page"><view class="card"><text>离线样例，无云端请求；生产页面和分页逻辑原样复用</text><button data-role="store" bindtap="open">门店主页</button><button data-role="hq" bindtap="open">总部查看门店</button><button data-role="store" data-empty="1" bindtap="open">门店空名单</button></view></view>');
write("pages/launcher/index.js","Page({open(e){wx.setStorageSync('qaRole',e.currentTarget.dataset.role);wx.setStorageSync('qaEmpty',Boolean(e.currentTarget.dataset.empty));wx.navigateTo({url:e.currentTarget.dataset.role==='hq'?'/pages/store-detail/index?storeRef=901':'/pages/home/index'})}});");
write("source-ui-manifest.json",JSON.stringify(manifest,null,2));
console.log(JSON.stringify({project:target,byteIdenticalProductionFiles:files.length,network:"none"}));
