"use strict";
// Exact client code with synthetic reads only: no SDK, server writes or camera capture.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const source = path.resolve(__dirname, "../miniprogram-app/miniprogram"), target = fs.mkdtempSync(path.join(os.tmpdir(), "lusizhuoer-store-search-"));
const pages = ["customer-create", "recharge", "product-purchase", "verification"], manifest = [];
function write(file, value) { fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true }); fs.writeFileSync(path.join(target, file), value); }
function copy(file) { const bytes = fs.readFileSync(path.join(source, file)); write(file, bytes); manifest.push({ file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }); }
function tree(dir) { for (const entry of fs.readdirSync(path.join(source, dir), { withFileTypes: true })) { const file = `${dir}/${entry.name}`; if (entry.isDirectory()) tree(file); else if (/\.(?:js|json|wxml|wxss)$/.test(file) && !["services/api.js", "services/session.js"].includes(file)) copy(file); } }
copy("app.wxss"); tree("components"); tree("services");
for (const page of pages) for (const ext of ["js", "json", "wxml", "wxss"]) copy(`pages/${page}/index.${ext}`);
write("project.config.json", JSON.stringify({ appid: "wxb053c1bd6c684d8b", projectname: "老师七项门店搜索离线验收", compileType: "miniprogram", libVersion: "3.17.1", setting: { es6: true, enhance: true } }));
write("app.json", JSON.stringify({ pages: ["pages/launcher/index", ...pages.map(p => `pages/${p}/index`)], window: { navigationBarTitleText: "七项办理离线验收", navigationBarBackgroundColor: "#302a22", navigationBarTextStyle: "white" }, style: "v2" }));
write("app.js", "App({});");
write("pages/launcher/index.json", "{}"); write("pages/launcher/index.wxss", "button{margin:12rpx 0;}");
const routes = [["客户建立", "customer-create", ""], ["办卡充值", "recharge", "NEW"], ["产品购买", "product-purchase", ""], ["退费申请", "recharge", "REFUND"], ["正常核销", "verification", "NORMAL"], ["补录核销", "verification", "SUPPLEMENT"], ["体验核销", "verification", "EXPERIENCE"]];
write("pages/launcher/index.wxml", '<view class="page"><view class="card"><text>仅合成门店，不联网、不采集照片、不写业务。</text>' + routes.map(([name, route, mode]) => `<button data-route="${route}" data-mode="${mode}" bindtap="open">${name}</button>`).join("") + '<button bindtap="empty">空门店列表</button><button bindtap="failure">读取失败</button><button bindtap="store">门店固定本店</button></view></view>');
write("pages/launcher/index.js", `Page({open(e){wx.setStorageSync('qaState','normal');wx.setStorageSync('qaRole','teacher');wx.navigateTo({url:'/pages/'+e.currentTarget.dataset.route+'/index?mode='+e.currentTarget.dataset.mode})},empty(){wx.setStorageSync('qaState','empty');wx.navigateTo({url:'/pages/verification/index?mode=SUPPLEMENT'})},failure(){wx.setStorageSync('qaState','error');wx.navigateTo({url:'/pages/verification/index?mode=SUPPLEMENT'})},store(){wx.setStorageSync('qaRole','store');wx.setStorageSync('qaState','normal');wx.navigateTo({url:'/pages/recharge/index?mode=NEW'})}});`);
write("services/session.js", `exports.requireSession=()=>({role:wx.getStorageSync('qaRole')||'teacher',teacherId:'9',staffId:'QA',uid:'offline'});exports.getSelectedStore=()=>({id:'42',name:'离线门店',code:'QA42'});exports.setSelectedStore=()=>{};`);
write("services/api.js", `exports.callFace=async(action)=>{
 if(action==='getTeacherBusinessContext'){const state=wx.getStorageSync('qaState');if(state==='error')throw Error('合成读取失败，请重试');return{stores:state==='empty'?[]:['广州天河门店','深圳南山门店','广州海珠门店','广州越秀门店','广州荔湾门店','用于检查长名称的广州大学城合作体验门店'].map((name,i)=>({storeId:String(i+42),storeName:name,storeCode:'QA'+(i+42)}))};}
 if(action==='listActiveTeachers')return{teachers:[{teacherId:'9',teacherName:'合成老师',teacherCode:'QA9'}]};
 if(action==='listActiveProducts')return{products:[]};
 if(action==='listActiveStoreCustomers')return{customers:[],hasMore:false,nextCursor:null};
 throw Error('离线验收禁止写入或访问真实业务：'+action);
};exports.callStaff=exports.callFace;`);
write("source-ui-manifest.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ project: target, files: manifest.length, productionWrites: 0, network: "none" }));
