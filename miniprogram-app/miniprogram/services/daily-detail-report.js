"use strict";
const pdf=require("./grouped-table-pdf");
const {formatShanghaiTimestamp}=require("./business-time");
const W=841.89,H=595.28;
function lineWidth(value){return Array.from(String(value)).reduce((n,c)=>n+(c.codePointAt(0)<128?.6:1),0);}
function wrap(value,width,size=13){return String(value||"—").split(/\r?\n/).flatMap(part=>{const lines=[];let line="";for(const ch of Array.from(part)){if(line && lineWidth(line+ch)*size>width){lines.push(line);line=ch;}else line+=ch;}lines.push(line||"—");return lines;});}
function pageHeader(model,row,continued){const commands=[];pdf.renderText(commands,model.title,38,27,19);pdf.renderText(commands,`${row.teacherName} · ${row.phone || "未登记电话"}${continued?"（续）":""}`,38,61,14);return commands;}
function createDetailPages(model){
  const pages=[];
  for(const row of model.rows){
    if(!row.completed)continue;
    const lines=wrap(row.content, W-92,13);let offset=0;
    do{const commands=pageHeader(model,row,offset>0);pdf.renderText(commands,`提交时间：${formatShanghaiTimestamp(row.updatedAt)}（北京时间）`,38,91,11);pdf.fillRect(commands,38,119,W-76,29,[.957,.91,.835]);pdf.renderText(commands,"日报内容",48,125,13);const chunk=lines.slice(offset,offset+21);chunk.forEach((v,i)=>pdf.renderText(commands,v,48,163+i*18,13));pages.push(commands);offset+=chunk.length;}while(offset<lines.length);
  }
  return pages;
}
module.exports={createDetailPages};
