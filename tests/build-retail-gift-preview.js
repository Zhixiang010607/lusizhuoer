"use strict";
// Offline fixture: production recharge handlers and detail UI, synthetic initial selection.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { project } = JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, "build-teacher-store-search-preview.js")], { encoding: "utf8" }));
const source = path.resolve(__dirname, "../miniprogram-app/miniprogram");
function write(file, content) { fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), content); }
for (const ext of ["js", "json", "wxml", "wxss"]) write(`pages/order-detail/index.${ext}`, fs.readFileSync(path.join(source, `pages/order-detail/index.${ext}`)));
const app = JSON.parse(fs.readFileSync(path.join(project, "app.json"))); app.pages.push("pages/order-detail/index"); write("app.json", JSON.stringify(app));
write("project.config.json", JSON.stringify({ appid: "wxb053c1bd6c684d8b", projectname: "充值赠品离线验收", compileType: "miniprogram", libVersion: "3.17.1", setting: { es6: true, enhance: true } }));
write("pages/launcher/index.wxml", '<view class="page"><view class="card"><text>离线合成数据，提交仅保存在本测试项目本机。</text><button bindtap="open">完整赠品直接提交</button><button bindtap="partial">不完整赠品阻止提交</button><button bindtap="detail">已有赠品详情</button></view></view>');
write("pages/launcher/index.js", "Page({open(){wx.navigateTo({url:'/pages/recharge/index'})},partial(){wx.navigateTo({url:'/pages/recharge/index?partial=1'})},detail(){wx.navigateTo({url:'/pages/order-detail/index?type=recharge&category=RECHARGE&recordId=901&recordCode=RC20261105000901'})}});");
// Only fixture registration replaces initial loading. All submit/validation handlers remain production code.
const recharge = fs.readFileSync(path.join(source, "pages/recharge/index.js"), "utf8");
write("pages/recharge/index.js", recharge.replace("Page({", `function fixturePage(definition){definition.onLoad=function(options){
 const products=Array.from({length:37},(_,i)=>({productId:String(100+i),productCode:'QA-'+i,productName:i===36?'医用面膜':'合成产品种类'+i}));
 const teacher={teacherId:'9',teacherName:'合成老师',displayName:'合成老师'};
 this.setData({session:{role:'teacher'},store:{id:'42',name:'离线门店'},stores:[{id:'42',name:'离线门店'}],storeIndex:1,
 customer:{customerCode:'QA-C',customerName:'合成客户'},products:[{productId:'1',productName:'海洋之蕴'}],productLabels:['海洋之蕴'],productIndex:0,selectedProduct:{productId:'1'},
 teachers:[teacher],teacherLabels:['合成老师'],selectedTeacher:teacher,teacherOptionsReady:true,teacherIndex:0,
 giftProducts:products,giftProductLabels:['请选择激活产品',...products.map(x=>x.productName)],giftProductIndex:37,selectedGiftProduct:products[36],giftProductQuantity:options.partial?'':'3',unitCount:'5',ready:true});
 };Page(definition);}fixturePage({`));
write("components/customer-picker/index.js", "Component({properties:{storeId:String}});");
write("components/customer-picker/index.wxml", '<view>合成客户 · 已确认（仅隔离测试初始状态）</view>');
write("services/verification-photo-upload-queue.js", "exports.subscribe=()=>()=>{};exports.resume=async()=>true;exports.tasksForRecord=()=>[];");
write("services/session.js", "exports.requireSession=()=>({role:'teacher',teacherId:'9',uid:'retail-offline'});exports.readSession=exports.requireSession;exports.getSelectedStore=()=>null;exports.setSelectedStore=()=>{};");
write("services/api.js", `function order(gifts){return{id:'901',recordType:'RECHARGE',recordCode:'RC20261105000901',originalType:'NEW',recordStatus:'PENDING',unitCount:5,
 submittedAt:'2026-11-05T08:30:00Z',storeName:'离线门店',customerName:'合成客户',productName:'海洋之蕴',teacherName:'合成老师',productGifts:gifts};}
exports.callFace=async(action,payload)=>{
 if(action==='createRechargeApplication'){wx.setStorageSync('qaGiftOrder',order(payload.productGifts.map(g=>({...g,productName:g.retailProductId==='136'?'医用面膜':'合成赠品',productCode:'QA-'+g.retailProductId}))));return{rechargeId:'901',rechargeCode:'RC20261105000901',recordStatus:'PENDING'};}
 if(action==='getTeacherWorkspace')return{record:wx.getStorageSync('qaGiftOrder')||order([{retailProductId:'136',productName:'医用面膜',productCode:'QA-136',unitCount:3}])};
 throw Error('离线验收禁止真实业务：'+action);
};exports.callStaff=exports.callFace;exports.callPhoto=exports.callFace;exports.callRating=exports.callFace;`);
console.log(JSON.stringify({ project, productionWrites: 0, network: "none", fixtureOverrides: ["initial recharge selection", "customer picker", "API/session/upload queue"] }));
