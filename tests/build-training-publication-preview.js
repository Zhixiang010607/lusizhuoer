"use strict";
// Production UI with synthetic read-only tasks. No network, files or uploads.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const result = JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, "build-ranking-links-preview.js")], { encoding: "utf8" }));
const target = result.project, source = path.resolve(__dirname, "../miniprogram-app/miniprogram");
const manifest = JSON.parse(fs.readFileSync(path.join(target, "source-ui-manifest.json")));
function write(file, value) { fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true }); fs.writeFileSync(path.join(target, file), value); }
for (const ext of ["js", "wxml", "wxss", "json"]) {
  const file = `pages/training-materials/index.${ext}`, bytes = fs.readFileSync(path.join(source, file));
  write(file, bytes); manifest.push({ file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
}
write("source-ui-manifest.json", JSON.stringify(manifest, null, 2));
const app = JSON.parse(fs.readFileSync(path.join(target, "app.json")));
app.pages.push("pages/training-materials/index"); write("app.json", JSON.stringify(app));
write("app.js", "App({globalData:{startupReady:true,session:{role:'hq',staffId:'QA',uid:'qa-only',loginAt:'qa-login'}}});");
write("services/session.js", "exports.requireSession=()=>getApp().globalData.session;exports.waitForStartupSession=async()=>{};exports.getSelectedStore=()=>null;exports.signOut=async()=>{throw Error('隔离预览禁止业务操作')};");
write("services/training-material-cache.js", "exports.invalidate=async()=>{};exports.find=async()=>'';exports.hasEntry=()=>false;exports.store=async()=>{};");
write("services/training-material-upload-queue.js", `
const tasks=[
 {id:'qa-transferring',ownerStaffId:'QA',title:'大文件传输中（纯测试）',state:'UPLOADING',bytes:8388608,uploadedBytes:0,phase:'TRANSFERRING',phaseStartedAt:Date.now()},
 {id:'qa-publish',ownerStaffId:'QA',title:'已上传，等待确认发布（纯测试）',state:'FAILED',bytes:8388608,uploadedBytes:8388608,phase:'VERIFYING',error:'PDF 已上传，发布暂未确认；重试只确认发布，无需重新上传'},
 {id:'qa-failed',ownerStaffId:'QA',title:'传输未完成（纯测试）',state:'FAILED',bytes:1048576,uploadedBytes:0,phase:'TRANSFERRING',error:'PDF 传输失败，请检查网络后重试'}
];
exports.allTasks=()=>tasks;exports.subscribe=()=>()=>{};exports.resume=async()=>{};
exports.retry=()=>false;exports.cancel=async()=>false;exports.dismissFailed=async()=>false;
exports.enqueue=()=>{throw Error('隔离预览不上传真实文件')};
`);
const api = fs.readFileSync(path.join(target, "services/api.js"), "utf8");
write("services/api.js", api + "\nconst rankedStaff=exports.callStaff;exports.callStaff=async(a,p)=>{if(a==='listTrainingMaterials')return{materials:[]};if(/TrainingMaterial/.test(a))throw Error('隔离预览禁止真实培训操作');return rankedStaff(a,p)};");
const launcher = fs.readFileSync(path.join(target, "pages/launcher/index.wxml"), "utf8");
write("pages/launcher/index.wxml", launcher + '<view class="page"><button data-route="training-materials" bindtap="training">培训发布恢复：隔离预览</button></view>');
write("pages/launcher/index.js", "Page({open(e){wx.setStorageSync('qaState',e.currentTarget.dataset.state);wx.navigateTo({url:'/pages/home/index'})},training(){wx.navigateTo({url:'/pages/training-materials/index'})}});");
console.log(JSON.stringify({ project: target, productionFiles: manifest.length, businessNetwork: "none", writes: "none" }));
