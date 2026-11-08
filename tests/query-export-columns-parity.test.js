"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),zlib=require("node:zlib");
const root=path.resolve(__dirname,".."),mini=path.join(root,"miniprogram-app/miniprogram"),read=f=>fs.readFileSync(path.join(root,f),"utf8");
const moduleObject={exports:{}};
vm.runInNewContext(read("miniprogram-app/miniprogram/services/query-report-export.js"),{module:moduleObject,require:id=>["./api","./session"].includes(id)?{}:require(path.join(mini,"services",id)),Uint8Array,ArrayBuffer});
const miniModel=moduleObject.exports.documentModel;
const window={CustomerAge:{format:()=>"36岁"}};
for(const file of ["query-report-export.js","web-report-export.js"])vm.runInNewContext(read(file),{window,TextEncoder,Uint8Array,ArrayBuffer,DataView});
const font=zlib.brotliDecompressSync(fs.readFileSync(path.join(mini,"packages/report-font/NotoSansCJKsc-Common-Identity.br")));
function miniHeaders(kind){
 const customer=kind==="CUSTOMER",file=customer?"customers":"records",selector=customer?"customer-row customer-head":"record-row record-head";
 const body=read(`miniprogram-app/miniprogram/pages/${file}/index.wxml`).split(`class="${selector}">`)[1].split("</view>")[0];
 const context={recordType:kind};return [...body.matchAll(/<text([^>]*)>([\s\S]*?)<\/text>/g)].filter(([,attrs])=>{const conditional=attrs.match(/wx:if="\{\{(.*?)\}\}"/);return !conditional||vm.runInNewContext(conditional[1],context);}).map(([,attrs,label])=>label.replace(/\{\{(.*?)\}\}/g,(_,expression)=>vm.runInNewContext(expression,context)));
}
function webHeaders(kind){const file=({CUSTOMER:"customer",RECHARGE:"recharge",VERIFICATION:"verification",PRODUCT_PURCHASE:"product"})[kind];return ["序号",...[...read(`${file}-query.html`).match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/)[1].matchAll(/<th>(.*?)<\/th>/g)].map(m=>m[1])];}
const cases=[
 ["CUSTOMER",{exportAll:true,total:1,customers:[{customerCode:"EXAMPLE-C",customerName:"同名客户",storeName:"示例门店",birthDate:"1990-01-01",customerStatus:"ACTIVE"}]}],
 ["RECHARGE",{exportAll:true,total:1,records:[{id:"1",recordCode:"RC-EXAMPLE",customerCode:"EXAMPLE-C",customerName:"同名客户",storeName:"示例门店",teacherName:"示例老师",unitCount:2,originalType:"NEW",recordStatus:"APPROVED"}]}],
 ["VERIFICATION",{exportAll:true,total:1,records:[{id:"1",recordCode:"VR-EXAMPLE",customerCode:"EXAMPLE-C",customerName:"同名客户",storeName:"示例门店",teacherName:"示例老师",unitCount:2,originalType:"SUPPLEMENT",recordStatus:"APPROVED"}]}],
 ["PRODUCT_PURCHASE",{exportAll:true,total:1,orders:[{id:"1",source_type:"GIFT",source_line_id:"2",record_code:"RC-EXAMPLE",customer_code:"EXAMPLE-C",customer_name:"同名客户",store_name:"示例门店",product_name_snapshot:"新产品类别",unit_count:3,record_status:"APPROVED"}]}]
];
function xmlEntries(bytes){const data=Buffer.from(bytes),out=new Map();let at=0;while(data.readUInt32LE(at)===0x04034b50){const size=data.readUInt32LE(at+18),nameLength=data.readUInt16LE(at+26),extra=data.readUInt16LE(at+28),start=at+30+nameLength+extra;out.set(data.subarray(at+30,at+30+nameLength).toString(),data.subarray(start,start+size).toString());at=start+size;}return out;}
for(const [kind,result] of cases)for(const client of ["mini","web"])test(`${client} ${kind} PDF/XLSX use the actual query columns in the same order, including store`,()=>{
 const model=client==="mini"?miniModel(kind,result):window.QueryReportExport.model(kind,result);
 const expected=client==="mini"?miniHeaders(kind):webHeaders(kind);
 const labels=Array.from(model.columns,c=>c.header||c.label);assert.deepEqual(labels,expected);
 const store=model.columns.find(c=>(c.header||c.label)==="门店");assert.equal(model.rows[0][store.key],"示例门店");
 const bytes=client==="mini"?require(path.join(mini,"services/grouped-table-export")).createGroupedWorkbook(model).bytes:window.WebReportExport.workbook(model.columns.map(c=>[c.key,c.label]),model.rows);
 const sheet=xmlEntries(bytes).get("xl/worksheets/sheet1.xml");
 const header=[...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(m=>m[1]).find(row=>row.includes('s="4"'));
 const exported=[...header.matchAll(/<t(?: [^>]*)?>(.*?)<\/t>/g)].map(m=>m[1]);assert.deepEqual(exported,expected);
 if(client==="mini"){
  const pdf=require(path.join(mini,"services/grouped-table-pdf")).createGroupedPdf({...model,cjkFontBytes:font});
  assert.match(Buffer.from(pdf.bytes).toString("latin1"),/<95E85E97> Tj/,'store must be a real PDF header, not only part of the group title');
 }else{
  assert.equal(model.sections[0].columns.length,model.columns.length);
  assert.deepEqual(Array.from(model.sections[0].columns,c=>c.label),expected,'PDF sections and workbook must not have different columns');
 }
});
test("Web operational PDF keeps the requested store column and the retired calculation origin remains excluded",()=>{
 const source=read("operational-metrics.js");assert.doesNotMatch(source,/columns\.filter\(\(\[key\]\)=>key!=="storeName"\)/);
 const body=source.slice(source.indexOf("function exportColumns()"),source.indexOf("async function exportRows"));assert.doesNotMatch(body,/baselineSource|计算起点/);
});

test("Web PDF aligns the same query columns across store groups with different text lengths",()=>{
 let commands;const window={HqDashboardReport:{createVectorPdf:pages=>{commands=pages.flat();return new Uint8Array(1);}}};
 vm.runInNewContext(read("web-table-report.js"),{window,Uint8Array});
 const columns=[{key:"name",label:"NAME"},{key:"store",label:"STORE"}];
 window.WebTableReport.createDocument({title:"Query",criteria:"",sections:[{title:"A",columns,rows:[{name:"A very long customer name",store:"A"}]},{title:"B",columns,rows:[{name:"B",store:"B"}]}]},new Uint8Array(1000));
 const headers=commands.filter(c=>c.includes("<53544F5245> Tj"));assert.equal(headers.length,2);
 const x=command=>Number(command.match(/ ([\d.]+) [\d.]+ Td/)[1]);assert.equal(x(headers[0]),x(headers[1]));
});
