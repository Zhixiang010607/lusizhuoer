"use strict";
// Test project only: unchanged production UI, synthetic data, no cloud SDK.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const base = process.argv[2] ? { project: process.argv[2] } : JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, "build-calendar-controls-preview.js")], { encoding: "utf8" }));
const target = base.project, source = path.resolve(__dirname, "../miniprogram-app/miniprogram");
function write(p, v) { fs.mkdirSync(path.dirname(path.join(target, p)), { recursive: true }); fs.writeFileSync(path.join(target, p), v); }
let manifest = JSON.parse(fs.readFileSync(path.join(target, "source-ui-manifest.json")));
for (const entry of manifest) {
  const bytes = fs.readFileSync(path.join(source, entry.file)); write(entry.file, bytes);
  entry.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
}
for (const ext of ["js", "wxml", "wxss", "json"]) {
  const p = `components/camera-capture/index.${ext}`, b = fs.readFileSync(path.join(source, p)); write(p, b);
  manifest = manifest.filter(x => x.file !== p); manifest.push({ file: p, sha256: crypto.createHash("sha256").update(b).digest("hex") });
}
write("source-ui-manifest.json", JSON.stringify(manifest, null, 2));
write("services/session.js", "exports.requireSession=()=>({role:'teacher',staffId:'QA'});exports.waitForStartupSession=async()=>{};");
write("project.config.json", JSON.stringify({ appid: "wxb053c1bd6c684d8b", projectname: "Lusizhuoer photo attendance QA", compileType: "miniprogram", libVersion: "3.17.1", setting: { es6: true, enhance: true } }));
write("pages/launcher/index.wxml", '<view class="page"><text>纯合成测试，不上传照片、不写生产。</text><button data-state="idle" bindtap="open">未录入人脸：可打卡</button><button data-state="inOnly" bindtap="open">仅上班：切换下班操作</button><button data-state="outReady" bindtap="open">下班照片待提交</button><button data-state="outError" bindtap="open">下班提交失败</button><button data-state="confirm" bindtap="open">位置确认</button><button data-state="photo" bindtap="open">现场拍照</button><button data-state="ready" bindtap="open">照片待提交</button><button data-state="loading" bindtap="open">提交中</button><button data-state="error" bindtap="open">提交失败</button><button data-state="complete" bindtap="open">上下班历史</button></view>');
write("pages/launcher/index.js", `Page({open(e){const state=e.currentTarget.dataset.state;wx.setStorageSync('qaPhotoState',state);wx.navigateTo({url:'/pages/attendance/index',success(){setTimeout(()=>{const p=getCurrentPages().slice(-1)[0];if(['idle','complete','inOnly'].includes(state))return;const out=state.startsWith('out');const ready=['ready','loading','error','outReady','outError'].includes(state);const error=['error','outError'].includes(state);
const preview={capturedAtMs:Date.now(),latitude:30,longitude:120,accuracy:10,checkedTime:'2026-11-01 09:00:00',coordinateText:'30.000000, 120.000000',coordinateType:'GCJ02',placeName:'合成位置',formattedAddress:'离线排版测试地址',markers:[{id:1,latitude:30,longitude:120}]};
p.setData({punchKind:out?'clockOut':'clockIn',checkInStage:state==='confirm'?'confirm':'photo',locationPreview:preview,pendingAttendanceType:out?'CLOCK_OUT':'CLOCK_IN',pendingAttendanceLabel:out?'下班打卡':'上班打卡',photoConsent:state!=='photo',captureReady:ready,clocking:state==='loading',message:error?'合成提交失败，请检查网络后重试。':state==='loading'?'正在保存打卡照片并提交…':'',error});
if(ready){setTimeout(()=>{const c=p.selectComponent('#attendanceCamera');if(c){c._capture={imageBase64:'synthetic-test-only'};c.setData({previewPath:'/fixture-photo.png',captureReady:true,message:'照片已拍摄，请确认后提交打卡'});}},100);}
},300);}})}});`);
write("services/api.js", `exports.callStaff=async(action,payload)=>{
if(action!=='getOwnAttendanceMonth')throw Error('Test fixture rejects unlisted actions');
const state=wx.getStorageSync('qaPhotoState');const types=state==='complete'?['CLOCK_IN','CLOCK_OUT']:(state==='inOnly'||String(state).startsWith('out'))?['CLOCK_IN']:[];const records=types.map((t,i)=>({id:'QA-'+t,attendanceType:t,attendanceDate:'2026-11-01',checkedInAt:'2026-11-01T'+(i?'10:00:00':'01:00:00')+'Z',latitude:30,longitude:120,placeName:'合成地点',formattedAddress:'仅用于排版',faceScore:null}));
return {month:payload.month,serverToday:'2026-11-01',faceEnrolled:false,records};};
exports.callFace=async(action,payload)=>{if(action==='getAttendancePhoto')return{attendanceId:payload.attendanceId,photo:{url:'/fixture-photo.png',width:480,height:640,bytes:0}};throw Error('离线测试禁止云端上传');};`);
console.log(JSON.stringify({ project: target, productionFiles: manifest.length, productionWrites: 0 }));
