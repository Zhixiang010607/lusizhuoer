"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),zlib=require("node:zlib");
const root=path.resolve(__dirname,".."),mini=path.join(root,"miniprogram-app/miniprogram/services");
const pdf=require(mini+"/grouped-table-pdf"),excel=require(mini+"/grouped-table-export"),font=zlib.brotliDecompressSync(fs.readFileSync(path.join(mini,"../packages/report-font/NotoSansCJKsc-Common-Identity.br")));
function client(api={}){const module={exports:{}};let uid="hq-a";vm.runInNewContext(fs.readFileSync(mini+"/query-report-export.js","utf8"),{module,Uint8Array,ArrayBuffer,require:id=>id==="./api"?api:id==="./session"?{readSession:()=>({uid})}:id==="./grouped-table-pdf"?{...pdf,loadCjkFontBytes:async()=>font}:require(path.join(mini,id))});return{...module.exports,changeIdentity:()=>{uid="hq-b";}};}
const customers=n=>({exportAll:true,total:n,customers:Array.from({length:n},(_,i)=>({customerCode:String(i+1),customerName:"示例客户"+(i+1),birthDate:"1990-01-01",storeName:"示例门店",createdAt:"2026-11-07T20:00:00Z",customerStatus:"ACTIVE",customerProcessStatus:"INFORMATION_ONLY",totalRechargeCount:0,totalVerificationCount:0}))});
function page(){return{data:{loading:false},setData(v){Object.assign(this.data,v);}};}
function device(){const writes=[],opened=[];global.wx={env:{USER_DATA_PATH:"/isolated"},getFileSystemManager:()=>({writeFile(o){assert(o.data instanceof ArrayBuffer);writes.push({path:o.filePath,bytes:Buffer.from(o.data)});o.success({});}}),openDocument(o){opened.push(o.fileType);o.success({});}};return{writes,opened};}
function webClient(){const window={CustomerAge:{format:()=>"36岁"}};vm.runInNewContext(fs.readFileSync(path.join(root,"query-report-export.js"),"utf8"),{window});return window.QueryReportExport;}
function fn(file,start,end,dependencies){const source=fs.readFileSync(path.join(root,file),"utf8"),a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);const sandbox={...dependencies};vm.runInNewContext(source.slice(a,b)+`\nthis.run=${start.match(/function (\w+)/)[1]};`,sandbox);return sandbox.run;}
const fail=(message,code)=>{throw Object.assign(Error(message),{code});},sqlText=v=>"'"+String(v).replace(/'/g,"''")+"'";
function face(kind,rows,deny=false){const sql=[];const dependencies={activeScopedQueryCaller:async()=>{if(deny)fail("无权查询","FORBIDDEN");return{scopeMode:"store",storeId:"7"};},fail,scopedStoreClause:(_,column)=>`${column} = 7`,sqlText,optionalBusinessQueryDate:v=>v||"",scopedQueryCursorTimestamp:v=>v||"",businessQueryDatabaseId:v=>String(v),teacherBusinessAttributionSourceCondition:()=>"TRUE",databaseBoolean:Boolean,executeSql:async q=>{sql.push(q);return rows;}};
return{sql,run:fn("cloudfunctions/faceRecognition/index.js",kind === "CUSTOMER"?"async function queryStoreCustomers(":"async function queryStoreBusinessRecords(",kind === "CUSTOMER"?"\nfunction inactiveVerificationCursor":"\nfunction customerListPageSize",dependencies)};}
for(const type of ["CUSTOMER","RECHARGE","VERIFICATION"])test(`${type} export uses one scoped snapshot, permits 1000 and rejects 1001`,async()=>{
 for(const count of [0,10,1000,1001]){const rows=Array.from({length:count},(_,i)=>({id:i+1,customer_code:String(i+1),store_id:7,product_id:1,record_code:"QA"+i,unit_count:1})),h=face(type,rows);
 const payload={exportAll:true,recordType:type,page:9,pageSize:10,limit:1,cursorId:"999",cursorCreatedAt:"2026-01-01",cursorSubmittedAt:"2026-01-01",statusCategory:"APPROVED",rechargeType:"REFUND",startDate:"2026-11-01",endDate:"2026-11-08"};
 if(count>1000)await assert.rejects(h.run(payload),e=>e.code==="EXPORT_LIMIT_EXCEEDED");else{const r=await h.run(payload);assert.equal(r.total,count);assert.equal((r.customers||r.records).length,count);assert.equal(r.exportAll,true);}
 assert.equal(h.sql.length,1);assert.match(h.sql[0],/LIMIT 1001/);assert.doesNotMatch(h.sql[0],/OFFSET|999::bigint/);assert.match(h.sql[0],type === "CUSTOMER"?/c.created_store_id = 7/:/r.store_id = 7|v.store_id = 7/);
 if(type === "RECHARGE")assert.match(h.sql[0],/recharge_type = 'REFUND'/);
 }
 const denied=face(type,[],true);await assert.rejects(denied.run({exportAll:true,recordType:type}),/无权/);assert.equal(denied.sql.length,0);
});
test("product export preserves multiple gift lines and dynamic product types in one snapshot",async()=>{
 const sql=[];let amount=2;const run=fn("cloudfunctions/staffAccount/index.js","async function listRetailProductPurchaseReviews(","\nasync function reviewRetailProductPurchase",{requireReviewer:()=>{},requireRetailProductPurchaseSchema:async()=>{},hasRechargeProductGiftSchema:async()=>true,numericId:String,strictDashboardDate:v=>v,sqlText,fail,executeSql:async q=>{sql.push(q);return Array.from({length:amount},(_,i)=>({id:1,source_type:"GIFT",source_line_id:i+1,record_code:"RC261108000001",product_name_snapshot:"未来产品"+i}));}});
 const r=await run({}, {exportAll:true,status:"",sourceType:"GIFT",storeId:"7"});assert.equal(r.total,2);assert.equal(sql.length,1);assert.match(sql[0],/gift.store_id = 7/);assert.match(sql[0],/LIMIT 1001/);assert.doesNotMatch(sql[0].slice(sql[0].indexOf(') SELECT entry.record_id')),/review_note|\.message|product_code_snapshot/);amount=1001;await assert.rejects(run({}, {exportAll:true,status:""}),e=>e.code==="EXPORT_LIMIT_EXCEEDED");
});
for(const kind of ["Attendance","DailyReport"])test(`${kind} export reuses current team roster, no per-person detail requests`,async()=>{
 const queries=[];let count=4;
 const run=fn("cloudfunctions/staffAccount/index.js",`async function getHq${kind}TrackingDay(`,kind==="Attendance"?"\nfunction teacherWorkMonthResponse":"\nasync function getHqDailyReportDetail",{requireHq:()=>fail("仅限总部","FORBIDDEN"),requireTeacherAttendanceSchema:async()=>{},requireDailyReportSchema:async()=>{},validCalendarDate:v=>v,sqlText,fail,databaseBoolean:Boolean,attendanceResponse:r=>r.attendance_id?{id:String(r.attendance_id),checkedInAt:r.checked_in_at}:null,executeSql:async q=>{queries.push(q);return Array.from({length:count},(_,i)=>({teacher_id:i+1,teacher_name:"示例老师"+i,server_today:"2026-11-08",report_id:i+1,completed_work:"真实日报内容",updated_at:"2026-11-08T10:00:00Z"}));}});
 const scope=column=>`${column} IN (SELECT member_id FROM current_test_members)`;
 const result=await run({}, {exportAll:true,attendanceDate:"2026-11-08",reportDate:"2026-11-08"},scope);assert.equal(result.total,4);assert.equal(queries.length,1);assert.match(queries[0],/current_test_members/);assert.match(queries[0],/LIMIT 1001/);if(kind==="DailyReport"){assert.match(queries[0],/report.completed_work/);assert.equal(result.exportRows[0].completedWork,"真实日报内容");}
 await assert.rejects(run({}, {exportAll:true}),/仅限总部/);count=1001;await assert.rejects(run({}, {exportAll:true,attendanceDate:"2026-11-08",reportDate:"2026-11-08"},scope),e=>e.code==="EXPORT_LIMIT_EXCEEDED");
});
test("query model keeps customer age and product line identities, excludes private/internal columns",()=>{
 const c=client();const model=c.documentModel("CUSTOMER",customers(1000));assert.equal(model.rows.length,1000);assert(!model.columns.some(x=>/birth|code|message|note/i.test(x.key)));assert.throws(()=>c.documentModel("CUSTOMER",customers(1001)),/1000/);assert.throws(()=>c.documentModel("CUSTOMER",customers(0)),/没有/);assert.throws(()=>c.documentModel("CUSTOMER",{...customers(2),total:3}),/不完整/);
 const gift={exportAll:true,total:2,orders:[1,2].map(i=>({id:"1",source_type:"GIFT",source_line_id:String(i),record_code:"RC261108000001",product_name_snapshot:"新产品"+i}))};assert.equal(c.documentModel("PRODUCT_PURCHASE",gift).rows.length,2);gift.orders[1].source_line_id="1";assert.throws(()=>c.documentModel("PRODUCT_PURCHASE",gift),/重复/);
});
test("runtime Excel and PDF both export all 21 matches, and stale account/filter responses never open",async()=>{
 for(const format of ["excel","pdf"]){const d=device(),calls=[];const c=client({callFace:async(a,p)=>{calls.push({a,p});return customers(21);}});await c.exportPage(page(),"CUSTOMER",{mode:"browse",limit:10},{format});assert.equal(calls.length,1);assert.equal(calls[0].p.exportAll,true);assert.equal(d.opened[0],format==="pdf"?"pdf":"xlsx");assert(d.writes[0].bytes.length>1000);}
 for(const change of ["account","filter"]){let resolve,valid=true;const d=device(),c=client({callFace:()=>new Promise(r=>resolve=r)}),p=page();const task=c.exportPage(p,"CUSTOMER",{}, {format:"excel",valid:()=>valid});if(change==="account")c.changeIdentity();else valid=false;resolve(customers(21));await task;assert.equal(d.opened.length,0);assert.equal(p.data.exporting,false);}
});
test("attendance PDF is summary-only; daily PDF has one teacher per detail page and two Excel sheets",async()=>{
 const d=device(),calls=[];const c=client({callStaff:async(a,p)=>{calls.push(a);return{exportAll:true,total:2,attendanceDate:"2026-11-08",exportRows:[1,2].map(i=>({teacherId:String(i),teacherName:"示例老师"+i,phone:"1380000000"+i,attendanceStatus:"MISSING"}))};}});
 await c.exportPage(page(),"ATTENDANCE",{attendanceDate:"2026-11-08"},{team:true,format:"pdf"});assert.deepEqual(calls,["getTeamAttendanceTrackingDay"]);assert.match(d.writes[0].path,/2026-11-08打卡情况.pdf$/);assert.equal((d.writes[0].bytes.toString('latin1').match(/\/Type \/Page \/Parent/g)||[]).length,1);assert.doesNotMatch(d.writes[0].bytes.toString('latin1'),/\/Subtype \/Image/);
 const result={exportAll:true,total:3,reportDate:"2026-11-08",exportRows:[1,2,3].map(i=>({teacherId:String(i),teacherName:"示例老师"+i,phone:"1380000000"+i,completed:i<3,updatedAt:"2026-11-08T10:00:00Z",completedWork:"完成客户服务并核对记录。".repeat(75).slice(0,1000)}))};
 const model=c.documentModel("DAILY_REPORT",result),details=require(mini+'/daily-detail-report').createDetailPages(model);assert.equal(details.length,2);const report=pdf.createGroupedPdf({...model,columns:model.columns.filter(c=>c.key!=="content"),detailPages:details,cjkFontBytes:font});assert.equal(report.pages,3);
 const workbook=excel.createGroupedWorkbook({...model,sheets:[{...model,sheetName:"当天汇总",columns:model.columns.filter(c=>c.key!=="content")},{...model,sheetName:"详细内容",narrative:true}]});assert.equal(workbook.sheetCount,2);assert(Buffer.from(workbook.bytes).includes(Buffer.from('当天汇总')));assert(Buffer.from(workbook.bytes).includes(Buffer.from('详细内容')));
});

for(const type of ["RECHARGE","VERIFICATION"])for(const format of ["pdf","excel"])test(`${type} ${format} accepts repeated teacher/customer from the actual server response mapper`,async()=>{
  const raw=Array.from({length:8},(_,i)=>({id:String(9001+i),record_code:(type==="RECHARGE"?"RC":"VR")+String(202611070057-i),original_type:type==="RECHARGE"?"NEW":"NORMAL",unit_count:1,record_status:"APPROVED",submitted_at:"2026-11-07T10:00:00Z",customer_code:"SAME-CUSTOMER",customer_name:"同一示例客户",birth_date:"1990-01-01",teacher_id:"77",teacher_name:"同一示例老师",store_id:7,store_name:"隔离门店",product_id:1,product_name:"隔离项目"}));
  const server=face(type,raw),payload={recordType:type,statusCategory:"ALL"};
  const result=await server.run({...payload,exportAll:true});
  assert.equal(new Set(result.records.map(r=>r.teacherId)).size,1);assert.equal(new Set(result.records.map(r=>r.customerCode)).size,1);
  for(const model of [client().documentModel(type,result),webClient().model(type,result)]){assert.equal(model.rows.length,8);assert.equal(new Set(model.rows.map(r=>r.number)).size,8);}
  const d=device(),p=page(),service=client({callFace:async(action,event)=>{assert.equal(action,"queryStoreBusinessRecords");return server.run(event);}});
  await service.exportPage(p,type,payload,{format});assert.equal(p.data.error,false);assert.equal(p.data.message,"已导出 8 条");assert.equal(d.opened.length,1);assert.equal(d.writes.length,1);
  const duplicate={...result,records:[...result.records.slice(0,7),result.records[0]]};
  for(const run of [()=>client().documentModel(type,duplicate),()=>webClient().model(type,duplicate)])assert.throws(run,/重复/);
  const missing={...result,records:result.records.map((r,i)=>i? r:{...r,id:undefined})};
  for(const run of [()=>client().documentModel(type,missing),()=>webClient().model(type,missing)])assert.throws(run,/编号缺失/);
});

test("refunds, daily rosters, customers and product lines validate only their own identity domain",()=>{
  const c=client(),web=webClient();
  const refund={exportAll:true,total:2,records:[1,2].map(i=>({id:String(i),teacherId:"77",customerCode:"ONE",originalType:"REFUND",recordCode:"RC"+i}))};
  for(const model of [c.documentModel("RECHARGE",refund,{rechargeType:"REFUND"}),web.model("RECHARGE",refund,{rechargeType:"REFUND"})])assert.equal(model.rows.length,2);
  const sameTeacherCustomers=customers(2);sameTeacherCustomers.customers.forEach(r=>{r.teacherId="77";r.id="999";});assert.equal(c.documentModel("CUSTOMER",sameTeacherCustomers).rows.length,2);
  for(const kind of ["ATTENDANCE","DAILY_REPORT"]){const result={exportAll:true,total:2,attendanceDate:"2026-11-08",reportDate:"2026-11-08",exportRows:[1,2].map(i=>({teacherId:String(i),id:"SAME-UNRELATED-ID",customerCode:"SAME-UNRELATED-CUSTOMER"}))};assert.equal(c.documentModel(kind,result).rows.length,2);assert.equal(web.model(kind,result).rows.length,2);result.exportRows[1].teacherId="1";assert.throws(()=>c.documentModel(kind,result),/重复/);assert.throws(()=>web.model(kind,result),/重复/);}
  const product={exportAll:true,total:2,orders:["PURCHASE","GIFT"].map(source_type=>({id:"5",source_type,source_line_id:"5",teacherId:"77",customerCode:"ONE"}))};assert.equal(c.documentModel("PRODUCT_PURCHASE",product).rows.length,2);assert.equal(web.model("PRODUCT_PURCHASE",product).rows.length,2);
  for(const value of [undefined,null,""," ","undefined",{}]){const bad={exportAll:true,total:1,orders:[{id:"1",source_type:"GIFT",source_line_id:value}]};assert.throws(()=>c.documentModel("PRODUCT_PURCHASE",bad),/编号缺失/);assert.throws(()=>web.model("PRODUCT_PURCHASE",bad),/编号缺失/);}
  assert.throws(()=>c.documentModel("OTHER",refund),/类型无效/);assert.throws(()=>web.model("OTHER",refund),/类型无效/);
});
