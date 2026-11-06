"use strict";
// Genuine client UI, synthetic transport only. No production SDK or credentials.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const root=path.resolve(__dirname,".."),mini=path.join(root,"miniprogram-app/miniprogram");
const target=fs.mkdtempSync(path.join(os.tmpdir(),"lusizhuoer-customer-qa-"));
const web=path.join(target,"web");
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
const files=["app.wxss","styles/query-refinements.wxss",...fs.readdirSync(path.join(mini,"pages/customer-detail")).map(f=>"pages/customer-detail/"+f),...fs.readdirSync(path.join(mini,"services")).filter(f=>f.endsWith(".js")&&!["api.js","session.js","cloudbase.js"].includes(f)).map(f=>"services/"+f)];
const manifest=files.map(file=>{const bytes=fs.readFileSync(path.join(mini,file));write(path.join(target,file),bytes);return{file,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};});
write(path.join(target,"app.json"),JSON.stringify({pages:["pages/launcher/index","pages/customer-detail/index"],window:{navigationBarTitleText:"露思卓儿 · 隔离验收",navigationBarBackgroundColor:"#302a22",navigationBarTextStyle:"white"}}));
write(path.join(target,"app.js"),'App({});');
write(path.join(target,"project.config.json"),JSON.stringify({appid:"wxb053c1bd6c684d8b",projectname:"Lusizhuoer customer isolated QA",compileType:"miniprogram",miniprogramRoot:"./",setting:{urlCheck:false,es6:true,minified:false}}));
write(path.join(target,"pages/launcher/index.json"),'{}');
write(path.join(target,"pages/launcher/index.wxml"),'<view class="page"><view class="card"><text>仅隔离合成数据</text><button data-total="21" bindtap="open">21 条业务记录</button><button data-total="3" bindtap="open">3 条业务记录</button><button data-total="0" bindtap="open">空记录</button></view></view>');
write(path.join(target,"pages/launcher/index.js"),`Page({open(e){wx.setStorageSync('qaTotal',Number(e.currentTarget.dataset.total));wx.navigateTo({url:'/pages/customer-detail/index?customerCode=QA-C'});}});`);
write(path.join(target,"services/session.js"),`exports.requireSession=()=>({role:'hq',staffName:'隔离总部'});`);
const fixture=`const fields={RECHARGE:'recharges',REFUND:'refunds',VERIFICATION:'verifications',EXPERIENCE:'experiences',PRODUCT_PURCHASE:'productPurchases'};
function result(p={},total=21){const types=p.historyType?[p.historyType]:Object.keys(fields),out={history:{}};
 if(!p.historyType)Object.assign(out,{customer:{customerCode:'QA-C',customerName:'隔离样例客户',storeName:'隔离样例门店',birthDate:'1990-06-18',customerStatus:'ACTIVE',createdAt:'2026-10-01T02:00:00Z',totalRechargeCount:20,totalRefundCount:5,totalVerificationCount:5,totalExperienceCount:4},balances:[{productId:'1',productName:'海洋之蕴',totalRechargeCount:20,totalRefundCount:5,totalVerificationCount:5,remainingCount:10}],retailProductSummary:[{productId:'1',productName:'医用面膜',purchasedCount:7,giftedCount:3}]});
 for(const type of types){const page=Math.min(Number(p.historyPage||1),Math.max(1,Math.ceil(total/10))),field=fields[type];out[field]=Array.from({length:Math.max(0,Math.min(10,total-(page-1)*10))},(_,i)=>({id:String((page-1)*10+i+1),rechargeCode:'RC261106'+String((page-1)*10+i+1).padStart(6,'0'),verificationCode:'VF261106'+String((page-1)*10+i+1).padStart(6,'0'),purchaseCode:'PP20261106'+String((page-1)*10+i+1).padStart(6,'0'),rechargeType:type==='REFUND'?'REFUND':'NEW',verificationType:type==='EXPERIENCE'?'EXPERIENCE':'NORMAL',unitCount:3,productName:type==='PRODUCT_PURCHASE'?'医用面膜':'海洋之蕴',teacherName:'隔离样例老师',recordStatus:'APPROVED',submittedAt:'2026-11-06T01:02:03Z'}));out.history[field]={pageNumber:page,pageSize:10,total,totalPages:Math.max(1,Math.ceil(total/10)),hasMore:page<Math.ceil(total/10),nextCursor:null};}return out;}
function read(action,p,total){if(action==='getCustomerProfile')return Promise.resolve(result(p,total));if(action==='listCustomerMessages')return Promise.resolve({messages:[],totalCount:0,page:{hasMore:false}});return Promise.reject(Error('隔离验收不读取照片或写入业务'));}
`;
write(path.join(target,"services/api.js"),fixture+`exports.callFace=(action,p={})=>read(action,p,wx.getStorageSync('qaTotal')||0);`);
for(const file of ["styles.css","list-row-numbers.css","datetime.js","customer-profile.js","web-tablet-parity.css"]){write(path.join(web,file),fs.readFileSync(path.join(root,file)));}
let html=fs.readFileSync(path.join(root,"customer-detail.html"),"utf8");
html=html.replace(/<script[^>]*src="(?:https:[^"]+|cloudbase-auth-config.js|auth-ui.js[^\"]*)"[^>]*><\/script>/g,"");
const mock=fixture+`sessionStorage.setItem('prototypeSession',JSON.stringify({role:'hq'}));window.cloudbase={init:()=>({callFunction:async({data})=>({result:{ok:true,...await read(data.action,data,Number(new URLSearchParams(location.search).get('rows')||21))}})})};window.CloudBaseAuthConfig={};window.registerFunctions=()=>{};`;
html=html.replace('<html lang="zh-CN">','<html lang="zh-CN" data-auth-ready>').replace('</head>','<link rel="stylesheet" href="web-tablet-parity.css"></head>');
html=html.replace('<script src="customer-profile.js',`<script>${mock}</script><script src="customer-profile.js`);
write(path.join(web,"customer-detail.html"),html);
write(path.join(target,"source-ui-manifest.json"),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({project:target,web,uiFiles:manifest.length,productionWrites:0}));
