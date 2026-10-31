"use strict";
// Reuse the isolated, write-rejecting HQ fixture; only synthetic calendar data.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),cp=require("node:child_process");
const result=JSON.parse(cp.execFileSync(process.execPath,[path.join(__dirname,"build-hq-teacher-home-preview.js")],{encoding:"utf8"}));
const target=result.project,source=path.resolve(__dirname,"../miniprogram-app/miniprogram");
const files=[...["work-calendar","attendance"].flatMap(name=>["js","wxml","wxss","json"].map(ext=>`pages/${name}/index.${ext}`)),...["month-selector","punch-tabs","date-selector","attendance-photo"].flatMap(name=>["js","wxml","wxss","json"].map(ext=>`components/${name}/index.${ext}`)),"services/business-time.js"];
const manifest=JSON.parse(fs.readFileSync(path.join(target,"source-ui-manifest.json")));
function write(file,value){fs.mkdirSync(path.dirname(path.join(target,file)),{recursive:true});fs.writeFileSync(path.join(target,file),value);}
for(const file of files){const bytes=fs.readFileSync(path.join(source,file));write(file,bytes);manifest.push({file,sha256:crypto.createHash("sha256").update(bytes).digest("hex")});}
write("source-ui-manifest.json",JSON.stringify(manifest,null,2));
write("project.config.json",JSON.stringify({appid:"wxb053c1bd6c684d8b",projectname:"Lusizhuoer calendar controls QA",compileType:"miniprogram",libVersion:"3.17.1",setting:{es6:true,enhance:true}}));
write("app.json",JSON.stringify({pages:["pages/launcher/index","pages/work-calendar/index","pages/teacher-detail/index","pages/attendance/index"],window:{navigationBarTitleText:"日历控件离线验收",navigationBarBackgroundColor:"#302a22",navigationBarTextStyle:"white"},style:"v2"}));
write("app.js","App({globalData:{session:{staffId:'QA'}}});");
write("services/session.js","exports.requireSession=()=>({role:'hq',staffId:'QA'}); exports.waitForStartupSession=async()=>{};");
write("pages/launcher/index.wxml",'<view class="page"><text>纯离线合成记录，不采集人脸、不写业务。</text><button data-route="work-calendar" bindtap="open">本人考勤月历</button><button data-route="teacher-detail" bindtap="open">总部考勤日报</button><button data-route="attendance" bindtap="open">本人打卡记录</button><button data-route="work-calendar" data-state="empty" bindtap="open">空记录</button><button data-route="work-calendar" data-state="error" bindtap="open">读取失败</button></view>');
write("pages/launcher/index.js","Page({open(e){wx.setStorageSync('qaState',e.currentTarget.dataset.state||'populated');wx.navigateTo({url:'/pages/'+e.currentTarget.dataset.route+'/index?teacherRef=901'})}});");
const oldApi=fs.readFileSync(path.join(target,"services/api.js"),"utf8");
write("services/api.js",oldApi+`\nconst priorStaff=exports.callStaff,priorFace=exports.callFace;
exports.callStaff=async(action,payload)=>{
 if(['getOwnTeacherWorkMonth','getHqTeacherWorkMonth','getOwnAttendanceMonth'].includes(action)){
  const state=wx.getStorageSync('qaState');if(state==='error')throw Error('合成读取失败');
  const month=payload.month||'2026-10',date=month+'-16';const records=state==='empty'?[]:['CLOCK_IN','CLOCK_OUT'].map((kind,i)=>({id:'QA-'+kind,attendanceType:kind,attendanceDate:date,checkedInAt:date+(i?'T10:02:03Z':'T01:02:03Z'),latitude:-35.28,longitude:149.13,placeName:i?'合成下班地点':'合成上班地点',formattedAddress:'只用于离线布局测试，不是真实地址'}));
  return{month,serverToday:'2026-10-31',faceEnrolled:false,teacher:{employmentStartDate:'2026-01-01',teacherName:'隔离测试老师',phone:'00000000000'},attendance:records,records,reports:state==='empty'?[]:[{reportDate:date,completedWork:'离线测试日报内容；不会写入生产。'}]};
 }
 return priorStaff(action,payload);
};
exports.callFace=async(action,payload)=>{
 if(action==='getAttendancePhoto')return{attendanceId:payload.attendanceId,photo:{url:'/fixture-photo.png',width:480,height:640,bytes:0}};
 return priorFace(action,payload);
};`);
// A synthetic one-pixel image is stretched only as an offline layout placeholder; no portrait/PII.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
write("fixture-photo.png",png);
console.log(JSON.stringify({project:target,productionFiles:manifest.length,network:"none",writes:"none"}));
