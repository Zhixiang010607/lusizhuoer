"use strict";
// Fresh offline project; production page/components byte-identical, no cloud SDK.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const source=path.resolve(__dirname,"../miniprogram-app/miniprogram"),target=fs.mkdtempSync(path.join(os.tmpdir(),"lusizhuoer-hq-teacher-home-"));
const files=["app.wxss","pages/home/index.wxss",...["js","wxml","wxss","json"].map(ext=>`pages/teacher-detail/index.${ext}`),
  ...["teacher-workspace","project-summary"].flatMap(name=>["js","wxml","wxss","json"].map(ext=>`components/${name}/index.${ext}`)),
  ...["home-dashboard","query-tools","customer-age","teacher-experience-recharge","attendance-map"].map(name=>`services/${name}.js`)];
function write(file,value){fs.mkdirSync(path.dirname(path.join(target,file)),{recursive:true});fs.writeFileSync(path.join(target,file),value);}
const manifest=files.map(file=>{const data=fs.readFileSync(path.join(source,file));write(file,data);return{file,sha256:crypto.createHash("sha256").update(data).digest("hex")};});
write("project.config.json",JSON.stringify({appid:"wxb053c1bd6c684d8b",projectname:"Lusizhuoer HQ teacher home QA",compileType:"miniprogram",libVersion:"3.17.1",setting:{es6:true,enhance:true}}));
write("app.js","App({});");
write("app.json",JSON.stringify({pages:["pages/launcher/index","pages/teacher-detail/index"],window:{navigationBarTitleText:"总部老师主页离线验收",navigationBarBackgroundColor:"#302a22",navigationBarTextStyle:"white"},style:"v2"}));
write("pages/launcher/index.json","{}");write("pages/launcher/index.wxss","button{margin:16rpx 0;}");
write("pages/launcher/index.wxml",'<view class="page"><view class="card"><text>离线合成数据，不读取生产、不修改账号／核销。</text><button data-state="populated" bindtap="open">老师主页：21条</button><button data-state="empty" bindtap="open">老师主页：空资料</button><button data-state="error" bindtap="open">老师主页：读取失败</button></view></view>');
write("pages/launcher/index.js","Page({open(e){wx.setStorageSync('qaState',e.currentTarget.dataset.state);wx.navigateTo({url:'/pages/teacher-detail/index?teacherRef=901'})}});");
write("services/session.js","exports.requireSession=()=>({role:'hq'});\n");
for(const name of ["attendance-photo","camera-capture"]){write(`components/${name}/index.json`,'{"component":true}');write(`components/${name}/index.js`,"Component({});");write(`components/${name}/index.wxml`,'<view>隔离样例：不采集照片／不读取考勤</view>');write(`components/${name}/index.wxss`,"");}
write("services/api.js",`exports.callTeacherCreate=async()=>{throw Error('离线样例禁止任何写入')};
exports.callStaff=async(action)=>{
 if(action==='listStaff')return{staff:[{teacher_id:'901',id:'71',staff_name:'隔离测试老师',teacher_name:'隔离测试老师',phone:'00000000000',role_code:'teacher',account_status:'ACTIVE',teacher_status:'ACTIVE'}]};
 if(action==='listProducts')return{products:[{id:'1',product_name:'海洋之蕴',product_status:'ACTIVE'},{id:'2',product_name:'魔法柔肤',product_status:'ACTIVE'},{id:'3',product_name:'露思康辰',product_status:'ACTIVE'}]};
 if(action==='getTeacherExperienceEntitlements')return{teacher:{id:'901'},entitlements:wx.getStorageSync('qaState')==='empty'?[]:['海洋之蕴','魔法柔肤','露思康辰'].map((name,i)=>({productId:String(i+1),productName:name,monthlyAllowance:30,usedCount:2,availableCount:28,productStatus:'ACTIVE'}))};
 if(action==='getHqTeacherWorkMonth')return{serverToday:'2026-10-31',teacher:{employmentStartDate:'2026-01-01'},attendance:[],reports:[]};
 throw Error('离线样例禁止业务操作');
};
exports.callFace=async(action,payload)=>{
 if(action!=='getHqTeacherWorkspace')throw Error('离线样例禁止业务操作');
 const state=wx.getStorageSync('qaState');if(state==='error')throw Error('QA read error');const total=state==='empty'?0:21,page=Math.min(Number(payload.page||1),Math.max(1,Math.ceil(total/10)));
 return{profile:{teacherId:'901'},summary:{totals:{verification:21,recharge:30,experience:3,refund:1},products:total?['海洋之蕴','魔法柔肤','露思康辰'].map((name,i)=>({productId:String(i+1),productName:name,verification:7,recharge:10,experience:1,refund:i===0?1:0})):[]},page:{page,pageSize:10,total,totalPages:Math.max(1,Math.ceil(total/10)),records:Array.from({length:Math.max(0,Math.min(10,total-(page-1)*10))},(_,i)=>({id:String((page-1)*10+i+1),recordCode:'QA-'+String((page-1)*10+i+1),storeName:'离线门店',customerName:'合成客户',customerCode:'QA-C',productName:'海洋之蕴',unitCount:1,submittedAt:'2026-10-31T01:23:45Z'}))}};
};`);
write("source-ui-manifest.json",JSON.stringify(manifest,null,2));
console.log(JSON.stringify({project:target,productionFiles:files.length,network:"none",writes:"none"}));
