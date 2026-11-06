'use strict';
// Isolated native UI plus an independent Web profile fixture. No real login.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..');
const project=JSON.parse(cp.execFileSync(process.execPath,[path.join(__dirname,'build-teacher-team-preview.js')],{encoding:'utf8'})).project;
const write=(f,s)=>{const p=path.join(project,f);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
const app=JSON.parse(fs.readFileSync(path.join(project,'app.json'),'utf8'));app.pages.push('pages/home/index');write('app.json',JSON.stringify(app));
write('project.config.json',JSON.stringify({appid:'wxb053c1bd6c684d8b',projectname:'Lusizhuoer leader name QA',compileType:'miniprogram',setting:{es6:true,enhance:true,urlCheck:false}}));
write('pages/launcher/index.wxml','<view class="page"><view class="card"><text>合成资料，不连接生产。</text><button data-mode="self" bindtap="open">本人主页：有所属组长</button><button data-mode="none" bindtap="open">本人主页：没有组长</button><button data-mode="long" bindtap="open">本人主页：长姓名</button><button data-mode="error" bindtap="open">本人主页：读取失败</button><button data-mode="hq" bindtap="open">总部查看老师</button><button data-mode="member" bindtap="open">组长查看成员</button></view></view>');
write('pages/launcher/index.js',`Page({open(e){const mode=e.currentTarget.dataset.mode;wx.setStorageSync('qaRole',mode==='hq'?'hq':'teacher');wx.setStorageSync('qaArchived',false);wx.setStorageSync('qaError',mode==='error');wx.setStorageSync('qaLeader',true);wx.setStorageSync('qaViewMember',mode==='member');wx.setStorageSync('qaMembers',['1001']);wx.setStorageSync('qaOwner',mode==='none'?'':mode==='long'?'隔离样例名字很长的组长张三李四王五赵六':'隔离样例组长');wx.navigateTo({url:mode==='hq'?'/pages/teacher-detail/index?teacherRef=901':mode==='member'?'/pages/teacher-detail/index?scope=TEAM&teacherId=1001':'/pages/home/index'});}});`);
fs.appendFileSync(path.join(project,'services/api.js'),`
const oldStaff=exports.callStaff,oldFace=exports.callFace;const owner=()=>wx.getStorageSync('qaArchived')?'':wx.getStorageSync('qaOwner')||'';
exports.callStaff=async(action,p={})=>{if(action==='getTeamAccess')return{isTeamLeader:wx.getStorageSync('qaViewMember')===true};if(action==='getTeacherTeam')return{teacher:{isTeamLeader:false,assignedLeaderId:owner()?'900':'',assignedLeaderName:owner()},members:{records:[],page:1,total:0,totalPages:1}};
 if(action==='setStaffStatus'||action==='setMasterStatus'){wx.setStorageSync('qaArchived',p.status==='ARCHIVED');return{ok:true,status:p.status};}
 const value=await oldStaff(action,p);if(action==='listStaff'&&wx.getStorageSync('qaArchived'))value.staff.forEach(t=>{t.account_status='ARCHIVED';t.teacher_status='ARCHIVED';});return value;};
exports.callFace=async(action,p={})=>{if(action==='getTeacherWorkspace'){if(wx.getStorageSync('qaError'))throw Error('隔离样例：读取失败');return{profile:{teacherId:'901',teacherName:'隔离样例老师',teacherPhone:'00000000000',assignedLeaderName:owner()},experienceBalances:[],summary:{totals:{},products:[]},page:{records:[],page:1,total:0,totalPages:1}};}
 const value=await oldFace(action,p);if(value.profile)value.profile.assignedLeaderName=owner();return value;};
`);
// Use the Web client's actual profile markup and team controller, never Mini UI.
const web=path.join(project,'web');fs.mkdirSync(web,{recursive:true});
for(const f of ['styles.css','staff-team.css','staff-team.js','web-tablet-parity.css'])fs.copyFileSync(path.join(root,f),path.join(web,f));
const src=fs.readFileSync(path.join(root,'staff-detail.js'),'utf8'),a=src.indexOf('`<section class="teacher-profile-hero">'),z=src.indexOf('</section>`',a);
const template=src.slice(a,z+'</section>`'.length);const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const markup=Function('escapeHtml','initials','staffName','status','staff','return '+template)(escape,'隔','隔离样例老师','活跃',{phone:'00000000000'});
const html=`<!doctype html><html lang="zh-CN" data-auth-ready><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>老师组长姓名隔离验收</title><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="staff-team.css"><link rel="stylesheet" href="web-tablet-parity.css"><body data-staff-detail><main class="staff-detail-main"><h1>老师主页</h1><section class="staff-profile-workspace"><section id="staffDetailContent" class="staff-profile-shell">${markup}</section></section><button id="staffTeamTab" hidden>人员管理</button><section id="staffTeamContent" hidden></section></main><script>window.CloudBasePhoneAuth={teacherTeam:async()=>({teacher:{isTeamLeader:false,assignedLeaderName:new URLSearchParams(location.search).get('name')==='none'?'':new URLSearchParams(location.search).get('name')==='long'?'隔离样例名字很长的组长张三李四王五赵六':'隔离样例组长',assignedLeaderId:'900'},members:{records:[],page:1,total:0,totalPages:1}})};</script><script src="staff-team.js"></script><script>TeacherTeamManagement.mount({teacherId:'901',archived:false,onRevoked:()=>{}});</script></body></html>`;
fs.writeFileSync(path.join(web,'staff-leader.html'),html);
console.log(JSON.stringify({project,web,productionWrites:0}));
