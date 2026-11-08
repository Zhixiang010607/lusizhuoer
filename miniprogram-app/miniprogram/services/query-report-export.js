"use strict";
const { callFace, callStaff } = require("./api");
const { readSession } = require("./session");
const { formatCustomerAge } = require("./customer-age");
const { formatShanghaiTimestamp } = require("./business-time");
const { businessToday } = require("./query-tools");
const excel = require("./grouped-table-export");
const pdf = require("./grouped-table-pdf");
const MAX_ROWS = 1000;
const status = value => ({ACTIVE:"活跃",ARCHIVED:"已封存",PENDING:"待审核",APPROVED:"已通过",REJECTED:"已驳回",VOIDED:"已作废"})[String(value)] || "—";
const stage = value => ({INFORMATION_ONLY:"有信息但没有充值",RECHARGED_NO_CONSUMPTION:"已充值但没有消费",RECHARGED_WITH_CONSUMPTION:"已充值并已有消费"})[value] || "—";
const day = value => value ? formatShanghaiTimestamp(value).slice(0,10) : "—";
const time = value => value ? formatShanghaiTimestamp(value).slice(11) : "—";
function duration(seconds) { if(seconds === null || seconds === undefined) return "—"; const m=Math.floor(Number(seconds)/60); return `${Math.floor(m/60)}小时${m%60}分`; }
function reportText(r) { return [["今日完成事项",r.completedWork],["客户项目进展",r.customerProjectProgress],["问题与支持",r.problemsAndSupport],["明日计划",r.tomorrowPlan]].filter(([,v])=>v).map(([k,v])=>`${k}：${v}`).join("\n") || "—"; }
const col=(key,header,width,type)=>({key,header,width,type});
function documentModel(kind, result, payload = {}, team = false) {
  let rows, columns, title;
  const number=col("number","序号",6,"number"), name=col("customerName","客户",14), age=col("age","年龄",7), state=col("status","状态",9);
  if(kind === "CUSTOMER") {
    title="客户查询"; rows=(result.customers || []).map(r=>({...r,age:formatCustomerAge(r.birthDate),recharge:r.totalRechargeCount,verification:r.totalVerificationCount,stage:stage(r.customerProcessStatus),status:status(r.customerStatus),date:day(r.createdAt)}));
    columns=[number,name,age,col("recharge","累计充值",10,"number"),col("verification","正常核销",10,"number"),col("stage","业务阶段",23),col("date","建档日期",14),state];
  } else if(kind === "ATTENDANCE") {
    title=`${result.attendanceDate}打卡情况`; rows=(result.exportRows || []).map(r=>({...r,status:({COMPLETE:"完整打卡",CLOCK_IN_ONLY:"仅上班打卡",CLOCK_OUT_ONLY:"仅下班打卡",MISSING:"未打卡"})[r.attendanceStatus] || "—",clockIn:time(r.clockInAt),clockOut:time(r.clockOutAt),duration:duration(r.workDurationSeconds)}));
    columns=[number,col("teacherName","老师",16),col("phone","电话",16),col("status","打卡状态",14),col("clockIn","上班时间",14),col("clockOut","下班时间",14),col("duration","工作时长",15)];
  } else if(kind === "DAILY_REPORT") {
    title=`${result.reportDate}日报情况`; rows=(result.exportRows || []).map(r=>({...r,status:r.completed?"已填写":"未填写",submittedAt:r.completed?time(r.updatedAt):"—",content:reportText(r)}));
    columns=[number,col("teacherName","老师",14),col("phone","电话",16),state,col("submittedAt","提交时间",12),col("content","日报内容",65)];
  } else if(kind === "PRODUCT_PURCHASE") {
    title="产品查询"; rows=(result.orders || []).map(r=>({ ...r,storeName:r.store_name,recordCode:r.record_code,source:r.source_type === "GIFT"?"充值赠送":"产品购买",customerName:r.customer_name,age:formatCustomerAge(r.birth_date),product:r.product_name_snapshot,quantity:Number(r.unit_count),teacher:r.teacher_name||"—",date:day(r.submitted_at),status:status(r.record_status)}));
    columns=[number,col("recordCode","工单号",25),col("source","来源",12),name,age,col("product","产品",16),col("quantity","数量",8,"number"),col("teacher","老师",13),col("date","提交日期",14),state];
  } else {
    title=kind === "VERIFICATION"?"核销查询":payload.rechargeType === "REFUND"?"退费查询":"充值与退费查询";
    rows=(result.records||[]).map(r=>({...r,age:formatCustomerAge(r.birthDate),type:kind === "VERIFICATION"?(r.originalType === "EXPERIENCE"?"体验核销":r.originalType === "SUPPLEMENT" && r.recordStatus !== "APPROVED"?"补录核销":"正常核销"):(r.originalType === "REFUND"?"退费":"充值"),quantity:r.unitCount,teacher:r.teacherName||"—",date:day(r.submittedAt),status:status(r.recordStatus)}));
    columns=[number,col("recordCode","工单号",25),name,age,col("productName","项目",15),col("type","业务类型",13),col("quantity","次数",8,"number"),col("teacher","老师",13),col("date","提交日期",14),state];
  }
  if(result.exportAll !== true || !Number.isInteger(result.total) || result.total !== rows.length) throw new Error("导出结果不完整，请重新查询后导出");
  if(!rows.length) throw new Error("当前条件没有可导出的结果");
  if(rows.length > MAX_ROWS) throw new Error("单次最多导出1000条，请缩小查询范围");
  const ids=new Set(); rows.forEach((r,i)=>{ const id=kind === "PRODUCT_PURCHASE"?`${r.source_type}:${r.source_line_id}`:r.teacherId||r.customerCode||r.id; if(!id||ids.has(String(id)))throw new Error("导出数据重复或编号缺失，请重新查询");ids.add(String(id));r.number=i+1; });
  const daily=["ATTENDANCE","DAILY_REPORT"].includes(kind);
  const criteria=`${daily?(team?"当前分配组员":"全部在职老师"):"当前查询条件"} · 共 ${rows.length} 条 · 北京时间${daily?"":` · 导出日期 ${businessToday()}`}`;
  return {title,filename:daily?title:`${businessToday()}${title}`,criteria,rows,columns,automaticWidths:true,compact:true,groupTitle:daily?"范围":"门店",...(daily?{groupKey:()=>"day",groupLabel:()=>team?"当前分配组员":"全部在职老师"}:{})};
}
async function fetchSnapshot(kind, payload, team=false) {
  const data={...payload,exportAll:true};
  delete data.cursorCreatedAt; delete data.cursorSubmittedAt; delete data.cursorId;
  if(kind === "CUSTOMER") return callFace("queryStoreCustomers",data);
  if(kind === "ATTENDANCE") return callStaff(team?"getTeamAttendanceTrackingDay":"getHqAttendanceTrackingDay",data);
  if(kind === "DAILY_REPORT") return callStaff(team?"getTeamDailyReportTrackingDay":"getHqDailyReportTrackingDay",data);
  if(kind === "PRODUCT_PURCHASE") return callStaff("listRetailProductPurchaseReviews",{...data,retailProductId:data.productId||"",status:data.statusCategory === "ALL"?"":data.statusCategory||"",limit:10});
  return callFace("queryStoreBusinessRecords",data);
}
async function exportPage(page,kind,payload,{team=false,valid=()=>true,format="pdf"}={}) {
  if(page.data.exporting || page.data.loading) return;
  const uid=readSession()?.uid;
  const isCurrent=()=>!page._unloaded && readSession()?.uid === uid && valid();
  page.setData({exporting:true,message:"正在生成导出文件…",error:false});
  try{
    const result=await fetchSnapshot(kind,payload,team);
    if(!isCurrent()) return;
    const model=documentModel(kind,result,payload,team);
    const daily=["ATTENDANCE","DAILY_REPORT"].includes(kind);
    let output;
    if(format === "excel") {
      output=excel.createGroupedWorkbook({...model,...(kind === "DAILY_REPORT"?{sheets:[{...model,sheetName:"当天汇总",columns:model.columns.filter(c=>c.key!=="content")},{...model,sheetName:"详细内容",narrative:true,columns:model.columns}]}:{})});
    } else {
      const font=await pdf.loadCjkFontBytes();
      let detailPages=[];
      if(kind === "DAILY_REPORT") detailPages=require("./daily-detail-report").createDetailPages(model);
      if(!isCurrent())return;
      output=pdf.createGroupedPdf({...model,columns:daily?model.columns.filter(c=>c.key!=="content"):model.columns,detailPages,cjkFontBytes:font});
    }
    if(!isCurrent()) return;
    await (format === "excel"?excel.openWorkbook:pdf.openPdf)({...output,filename:model.filename});
    if(isCurrent()) page.setData({message:`已导出 ${model.rows.length} 条`,error:false});
  }catch(error){if(isCurrent())page.setData({message:error.message||"导出失败，请重试",error:true});}
  finally{if(!page._unloaded)page.setData({exporting:false});}
}
module.exports={MAX_ROWS,documentModel,fetchSnapshot,exportPage};
