"use strict";
// Entirely synthetic PostgreSQL. No credentials, network, or production writes.
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),assert=require("node:assert/strict");
const {PGlite}=require(path.resolve(process.argv[2]));
(async()=>{const db=new PGlite();let reads=0;
try{
await db.exec(`CREATE TABLE teachers(id bigint,staff_account_id bigint,teacher_code text,teacher_name text,teacher_status text);
CREATE TABLE staff_accounts(id bigint,phone text,role_code text,account_status text);
CREATE TABLE teacher_attendance_face_profiles(id bigint,teacher_id bigint,staff_account_id bigint);
CREATE TABLE teacher_attendance_records(id bigint,staff_account_id bigint,attendance_date date,attendance_type text,checked_in_at timestamptz,latitude numeric,longitude numeric,accuracy_m numeric,face_score numeric,device_platform text,place_name text,formatted_address text,address_provider text);
CREATE TABLE staff_daily_reports(id bigint,staff_account_id bigint,report_date date,created_at timestamptz,updated_at timestamptz,completed_work text,customer_project_progress text,problems_and_support text,tomorrow_plan text);
CREATE TABLE synthetic_team(leader_id bigint,teacher_id bigint);
INSERT INTO staff_accounts VALUES(1,'13800000001','teacher','ACTIVE'),(2,'13800000002','teacher','ACTIVE'),(3,'13800000003','teacher','ACTIVE');
INSERT INTO teachers VALUES(1,1,'T1','示例老师一','ACTIVE'),(2,2,'T2','示例老师二','ACTIVE'),(3,3,'T3','封存老师','ARCHIVED');
INSERT INTO synthetic_team VALUES(99,1);
INSERT INTO teacher_attendance_records(id,staff_account_id,attendance_date,attendance_type,checked_in_at) VALUES(1,1,'2026-01-01','CLOCK_IN','2026-01-01T01:00:00Z'),(2,1,'2026-01-01','CLOCK_OUT','2026-01-01T10:30:00Z');
INSERT INTO staff_daily_reports VALUES(1,1,'2026-01-01','2026-01-01T10:00:00Z','2026-01-01T10:30:00Z','完成事项','旧客户进展','旧问题','旧计划');`);
const source=fs.readFileSync(path.resolve(__dirname,'../cloudfunctions/staffAccount/index.js'),'utf8');const deps={requireHq:c=>assert.equal(c.role,'hq'),requireTeacherAttendanceSchema:async()=>{},requireDailyReportSchema:async()=>{},validCalendarDate:v=>v,sqlText:v=>"'"+String(v).replace(/'/g,"''")+"'",fail:(m,c)=>{throw Object.assign(Error(m),{code:c});},databaseBoolean:Boolean,attendanceResponse:r=>r.attendance_id?{id:String(r.attendance_id),checkedInAt:r.checked_in_at}:null,executeSql:async q=>{reads++;return(await db.query(q)).rows;}};
const funcs={};for(const [name,end]of [['getHqAttendanceTrackingDay','\nfunction teacherWorkMonthResponse'],['getHqDailyReportTrackingDay','\nasync function getHqDailyReportDetail']]){const a=source.indexOf('async function '+name+'('),b=source.indexOf(end,a),context={...deps};vm.runInNewContext(source.slice(a,b)+'\nthis.run='+name,context);funcs[name]=context.run;}
const payload={exportAll:true,attendanceDate:'2026-01-01',reportDate:'2026-01-01'};const scope=column=>`${column} IN (SELECT teacher_id FROM synthetic_team WHERE leader_id=99)`;
for(const [name,run]of Object.entries(funcs)){let before=reads,r=await run({role:'hq'},payload);assert.equal(reads-before,1);assert.equal(r.total,2);r=await run({role:'teacher'},payload,scope);assert.equal(r.total,1);assert.equal(r.exportRows[0].teacherName,'示例老师一');if(name.includes('Daily')){assert.equal(r.exportRows[0].completedWork,'完成事项');assert.equal(r.exportRows[0].problemsAndSupport,'旧问题');assert.equal(r.exportRows[0].tomorrowPlan,'旧计划');}else assert.equal(r.exportRows[0].workDurationSeconds,34200);}
await db.exec(`INSERT INTO staff_accounts SELECT id,'13800000000','teacher','ACTIVE' FROM generate_series(4,1001) id;INSERT INTO teachers SELECT id,id,'T'||id,'老师'||id,'ACTIVE' FROM generate_series(4,1001) id`);
for(const run of Object.values(funcs))assert.equal((await run({role:'hq'},payload)).total,1000);
await db.exec(`INSERT INTO staff_accounts VALUES(1002,'13800000000','teacher','ACTIVE');INSERT INTO teachers VALUES(1002,1002,'T1002','老师1002','ACTIVE')`);
for(const run of Object.values(funcs))await assert.rejects(run({role:'hq'},payload),e=>e.code==='EXPORT_LIMIT_EXCEEDED');
await db.exec('DELETE FROM synthetic_team');for(const run of Object.values(funcs))assert.equal((await run({role:'teacher'},payload,scope)).total,0);
console.log(JSON.stringify({postgres:'isolated PGlite',productionWrites:0,checks:18,readStatements:reads}));
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
