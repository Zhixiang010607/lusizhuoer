'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const migration=read('database/migrations/093_teacher_archive_team_release.sql');
test('atomic archive detaches before status writes, without extra group records',()=>{
 const body=migration.slice(migration.indexOf('CREATE FUNCTION public.set_teacher_status_v93('),migration.indexOf('CREATE FUNCTION public.teacher_team_leader_name_v93('));
 assert.doesNotMatch(body,/INSERT INTO public.teacher_team_events|PERFORM public.set_teacher_team_leader_v91/);
 assert(body.indexOf('DELETE FROM public.teacher_team_members WHERE leader_teacher_id')<body.indexOf('UPDATE public.teacher_team_leaders SET enabled=FALSE'));
 assert(body.indexOf('DELETE FROM public.teacher_team_members WHERE member_teacher_id')<body.indexOf('UPDATE public.teachers SET teacher_status=p_status'));
 assert.match(body,/p_status='ARCHIVED'/);assert.match(body,/role_code='hq' AND account_status='ACTIVE'/);
 assert.match(migration,/DEFERRABLE INITIALLY DEFERRED/);
 assert.equal(migration,read('database/cloudbase-console/093-01-teacher-archive-team-release.sql'));
 const staff=read('cloudfunctions/staffAccount/index.js');assert.match(staff,/persistStaffStatusAndMaster\(staff, status, caller\)/);assert.match(staff,/set_teacher_status_v93\(\$\{sqlText\(caller.uid\)\}/);
});
test('leader name is supplied only in already-authorized workspace and plain conditional UI',()=>{
 const face=read('cloudfunctions/faceRecognition/index.js');const body=face.slice(face.indexOf('async function getTeacherWorkspace('),face.indexOf('async function getHqTeacherWorkspace('));
 assert.match(body,/hqTarget \|\| await activeTeacherCaller\(\)/);assert.match(body,/teacher_team_leader_name_v93/);assert.match(body,/WHERE \$\{caller.teamReadScopeSql \|\| "TRUE"\}/);
 for(const file of ['pages/home/index.wxml','components/teacher-workspace/index.wxml']){
  const source=read('miniprogram-app/miniprogram/'+file);const line=source.split('\n').find(l=>l.includes('wx:if="{{assignedLeaderName}}"'));assert(line);assert.match(line,/所属组长/);assert.doesNotMatch(line,/bindtap|navigator|url=/);
 }
 assert.match(read('staff-team.js'),/row.querySelector\('dd'\).textContent=String\(name\)/);
});
function component(api){let definition;const dashboard=require('../miniprogram-app/miniprogram/services/home-dashboard');
 vm.runInNewContext(read('miniprogram-app/miniprogram/components/teacher-workspace/index.js'),{require:p=>p.includes('/api')?{callFace:api}:dashboard,Component:d=>definition=d,wx:{}});
 const instance={data:{...Object.fromEntries(Object.entries(definition.properties).map(([k,v])=>[k,v.value])),...definition.data,teacherId:'1',teacherName:'样例老师'},_ready:true,setData(p,callback){Object.assign(this.data,p);callback?.();}};
 for(const [k,v] of Object.entries(definition.methods))instance[k]=v.bind(instance);instance.measureTable=()=>{};return instance;
}
const result=name=>({profile:{teacherId:'1',assignedLeaderName:name},page:{records:[],page:1,total:0,totalPages:1},summary:{totals:{},products:[]}});
test('workspace removes prior leader name on empty response, failure, and late stale response',async()=>{
 let response=result('样例组长'),mode='ready',resolveOld;
 const instance=component(async()=>mode==='old'?new Promise(resolve=>{resolveOld=resolve;}):mode==='fail'?Promise.reject(Error('offline')):response);
 await instance.load();assert.equal(instance.data.assignedLeaderName,'样例组长');response=result('');await instance.load();assert.equal(instance.data.assignedLeaderName,'');
 response=result('另一组长');await instance.load();mode='fail';await instance.load();assert.equal(instance.data.assignedLeaderName,'');
 mode='old';const old=instance.load();mode='ready';response=result('当前组长');await instance.load();resolveOld(result('过期组长'));await old;assert.equal(instance.data.assignedLeaderName,'当前组长');
});
