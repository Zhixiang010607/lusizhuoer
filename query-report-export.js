(() => {
  "use strict";
  const LIMIT=1000;
  const labels={ACTIVE:"活跃",ARCHIVED:"已封存",PENDING:"待审核",APPROVED:"已通过",REJECTED:"已驳回",VOIDED:"已作废",COMPLETE:"完整打卡",CLOCK_IN_ONLY:"仅上班打卡",CLOCK_OUT_ONLY:"仅下班打卡",MISSING:"未打卡"};
  function beijing(value,clock=false){if(!value)return "—";const d=new Date(value);if(!Number.isFinite(d.getTime()))return "—";const t=new Date(d.getTime()+28800000).toISOString();return clock?t.slice(11,19):t.slice(0,10);}
  const c=(key,label,maxWidth=100,number=false)=>({key,label,maxWidth,number});
  function model(kind,result,payload={}){
    let title,rows,columns;const number=c("number","序号",42,true),name=c("customer","客户",86),age=c("age","年龄",48),state=c("status","状态",66),record=c("order","工单号",128),date=c("date","提交日期",96);
    if(kind === "CUSTOMER"){
      title="客户查询";rows=(result.customers||[]).map(r=>({id:r.customerCode,store:r.storeName,customer:r.customerName,age:window.CustomerAge.format(r.birthDate),recharge:r.totalRechargeCount,verification:r.totalVerificationCount,stage:({INFORMATION_ONLY:"有信息但没有充值",RECHARGED_NO_CONSUMPTION:"已充值但没有消费",RECHARGED_WITH_CONSUMPTION:"已充值并已有消费"})[r.customerProcessStatus]||"—",date:beijing(r.createdAt),status:labels[r.customerStatus]||"—"}));
      columns=[number,name,age,c("recharge","累计充值",80,true),c("verification","正常核销",80,true),c("stage","业务阶段",155),c("date","建档日期",96),state];
    }else if(kind === "ATTENDANCE"){
      title=`${result.attendanceDate}打卡情况`;rows=(result.exportRows||[]).map(r=>({id:r.teacherId,teacher:r.teacherName,phone:r.phone,status:labels[r.attendanceStatus]||"—",clockIn:beijing(r.clockInAt,true),clockOut:beijing(r.clockOutAt,true),duration:r.workDurationSeconds==null?"—":`${Math.floor(r.workDurationSeconds/3600)}小时${Math.floor(r.workDurationSeconds/60)%60}分`}));columns=[number,c("teacher","老师",100),c("phone","电话",110),c("status","打卡状态",98),c("clockIn","上班时间",92),c("clockOut","下班时间",92),c("duration","工作时长",105)];
    }else if(kind === "DAILY_REPORT"){
      title=`${result.reportDate}日报情况`;rows=(result.exportRows||[]).map(r=>({id:r.teacherId,teacher:r.teacherName,phone:r.phone,completed:r.completed,updatedAt:r.updatedAt,status:r.completed?"已填写":"未填写",time:r.completed?beijing(r.updatedAt,true):"—",content:[["今日完成事项",r.completedWork],["客户项目进展",r.customerProjectProgress],["问题与支持",r.problemsAndSupport],["明日计划",r.tomorrowPlan]].filter(([,v])=>v).map(([label,v])=>`${label}：${v}`).join("\n")||"—"}));columns=[number,c("teacher","老师",90),c("phone","电话",104),state,c("time","提交时间",90),c("content","日报内容",420)];
    }else if(kind === "PRODUCT_PURCHASE"){
      title="产品查询";rows=(result.orders||[]).map(r=>({id:`${r.source_type}:${r.source_line_id}`,store:r.store_name,order:r.record_code,source:r.source_type === "GIFT"?"充值赠送":"产品购买",customer:r.customer_name,age:window.CustomerAge.format(r.birth_date),product:r.product_name_snapshot,quantity:Number(r.unit_count),teacher:r.teacher_name||"—",date:beijing(r.submitted_at),status:labels[r.record_status]||"—"}));columns=[number,record,c("source","来源",78),name,age,c("product","产品",100),c("quantity","数量",48,true),c("teacher","老师",80),date,state];
    }else{
      title=kind === "VERIFICATION"?"核销查询":payload.rechargeType === "REFUND"?"退费查询":"充值与退费查询";
      rows=(result.records||[]).map(r=>({id:r.id,store:r.storeName,order:r.recordCode,customer:r.customerName,age:window.CustomerAge.format(r.birthDate),project:r.productName,type:kind === "VERIFICATION"?(r.originalType === "EXPERIENCE"?"体验核销":r.originalType === "SUPPLEMENT" && r.recordStatus !== "APPROVED"?"补录核销":"正常核销"):(r.originalType === "REFUND"?"退费":"充值"),quantity:r.unitCount,teacher:r.teacherName||"—",date:beijing(r.submittedAt),status:labels[r.recordStatus]||"—"}));columns=[number,record,name,age,c("project","项目",96),c("type","业务类型",84),c("quantity","次数",48,true),c("teacher","老师",80),date,state];
    }
    if(result.exportAll !== true || !Number.isInteger(result.total) || result.total !== rows.length)throw Error("导出结果不完整，请重新查询");
    if(!rows.length)throw Error("当前条件没有可导出的结果");
    if(rows.length>LIMIT)throw Error("单次最多导出1000条，请缩小查询范围");
    const seen=new Set();rows.forEach((r,i)=>{if(!r.id||seen.has(String(r.id)))throw Error("导出数据重复或编号缺失，请重新查询");seen.add(String(r.id));r.number=i+1;});
    const daily=kind === "ATTENDANCE"||kind === "DAILY_REPORT",sections=[];
    if(daily)sections.push({title:"全部在职老师",columns:kind === "DAILY_REPORT"?columns.filter(c=>c.key!=="content"):columns,rows});
    else{const groups=new Map();rows.forEach(r=>{const key=r.store||"未命名门店";if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);});for(const [store,list]of groups)sections.push({title:`${store} · ${list.length} 条`,columns,rows:list});}
    return{...(kind === "DAILY_REPORT"?{detailRows:rows.filter(r=>r.completed)}:{}),title,filename:daily?title:`${beijing(new Date())}${title}`,criteria:`${daily?"全部在职老师":"当前查询条件"} · 共 ${rows.length} 条 · 北京时间`,columns:daily?columns:[columns[0],c("store","门店",130),...columns.slice(1)],rows,sections};
  }
  const normalized=p=>{const q={...p};["page","pageSize","pageNumber","limit","cursorCreatedAt","cursorSubmittedAt","cursorId","exportAll"].forEach(k=>delete q[k]);return JSON.stringify(q);};
  function mount({kind,readPayload,fetch,notice}){
    const bar=document.getElementById("queryExportBar");let committed=null,version=0,busy=false;
    const identity=()=>sessionStorage.getItem("prototypeSession");
    function ready(){try{return !!committed&&!busy&&normalized(readPayload())===normalized(committed);}catch(_){return false;}}
    const refresh=()=>bar.querySelectorAll("button").forEach(b=>{b.disabled=!ready();});
    const api={begin(){committed=null;version++;refresh();},commit(p){committed={...p};version++;refresh();}};
    ["input","change"].forEach(e=>document.addEventListener(e,refresh));
    bar.querySelectorAll("button").forEach(button=>button.addEventListener("click",async()=>{
      if(!ready())return;const current=version,uid=identity(),payload={...committed,exportAll:true};["cursorCreatedAt","cursorSubmittedAt","cursorId"].forEach(k=>delete payload[k]);busy=true;refresh();
      const valid=()=>current===version&&uid===identity()&&normalized(readPayload())===normalized(payload);
      try{notice("正在生成导出文件…");const result=await fetch(payload);if(!valid())return;const documentModel=model(kind,result,payload);let bytes;
        if(button.dataset.format === "excel") {
          const convert=columns=>columns.map(c=>[c.key,c.label]);
          bytes=kind === "DAILY_REPORT"?window.WebReportExport.workbookSheets([{name:"当天汇总",columns:convert(documentModel.columns.filter(c=>c.key!=="content")),rows:documentModel.rows},{name:"详细内容",narrative:true,title:documentModel.title,criteria:documentModel.criteria,columns:convert(documentModel.columns),rows:documentModel.rows}]):window.WebReportExport.workbook(convert(documentModel.columns),documentModel.rows);
        }
        else{const font=await window.WebTableReport.font();if(!valid())return;bytes=window.WebTableReport.createDocument(documentModel,font).bytes;}
        if(!valid())return;window.WebTableReport.save(bytes,documentModel.filename,button.dataset.format === "excel"?"xlsx":"pdf");notice(`已导出 ${documentModel.rows.length} 条`);
      }catch(error){if(valid())notice(error.message||"导出失败，请重试",true);}finally{busy=false;refresh();}
    }));refresh();return api;
  }
  window.QueryReportExport=Object.freeze({LIMIT,model,mount});
})();
