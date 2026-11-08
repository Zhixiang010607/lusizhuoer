"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
function reportRuntime(){const context={window:{},TextEncoder,Uint8Array,DataView,Date,Intl};vm.createContext(context);vm.runInContext(read('datetime.js'),context);vm.runInContext(read('web-report-export.js'),context);return context.window.WebReportExport;}
function unzip(bytes){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files={};let o=0;while(v.getUint32(o,true)===0x04034b50){const size=v.getUint32(o+18,true),n=v.getUint16(o+26,true),extra=v.getUint16(o+28,true),start=o+30+n+extra;files[Buffer.from(bytes.slice(o+30,o+30+n)).toString()]=Buffer.from(bytes.slice(start,start+size)).toString();o=start+size;}return files;}
test('Excel uses Beijing calendar dates across UTC midnight and preserves never-verified markers',()=>{
 const exportApi=reportRuntime();assert.equal(exportApi.beijingDate('2026-10-30T20:32:34.646Z'),'2026-10-31');assert.equal(exportApi.beijingDate('2026-10-30T04:32:34.646Z'),'2026-10-30');assert.equal(exportApi.beijingDate('从未核销'),'从未核销');assert.equal(exportApi.beijingDate('invalid'),'—');
 const columns=[['name','客户'],['store','门店'],['days','间隔天数'],['at','上次核销日期（北京）','date']];
 const files=unzip(exportApi.workbook(columns,[{name:'=SUM(1,2)',store:'很长的中文门店名称用于自适应列宽验证',days:9,at:'2026-10-30T20:32:34.646Z'},{name:'客户乙',store:'短名',days:30,at:'从未核销'}]));
 const sheet=files['xl/worksheets/sheet1.xml'];assert.match(sheet,/2026-10-31/);assert.match(sheet,/从未核销/);assert.match(sheet,/<v>9<\/v>/);assert.doesNotMatch(sheet,/<f>|NORMAL|计算起点|T20:32/);assert.match(sheet,/bestFit="1"/);
 const widths=[...sheet.matchAll(/<col [^>]*width="(\d+)"/g)].map(m=>Number(m[1]));assert.ok(widths[1]>widths[0], 'CJK content, not fixed equal widths, determines the column width');assert.match(files['[Content_Types].xml'],/spreadsheetml.sheet.main/);
});
test('rating graphics retain all-score summary denominators independently of filtered list totals',()=>{
 const context={window:{}};vm.createContext(context);vm.runInContext(read('rating-charts.js'),context);const node={};
 context.window.RatingCharts.render(node,{total:100,rated:75,unrated:25,scoreCounts:[25,5,10,15,20,25]});
 assert.equal(node.hidden,false);assert.match(node.innerHTML,/75\.0%/);assert.match(node.innerHTML,/1–5 分分布/);assert.match(node.innerHTML,/5 分 25 单/);assert.doesNotMatch(node.innerHTML,/0 分 25 单/);
 context.window.RatingCharts.render(node,{total:0,rated:0,scoreCounts:[]});assert.match(node.innerHTML,/0\.0%/);assert.doesNotMatch(node.innerHTML,/NaN|Infinity/);
});
test('product query is HQ-only and purchase-only review remains isolated from the combined query',()=>{
 const auth=read('auth-ui.js'),hq=auth.slice(auth.indexOf('hq: new Set'),auth.indexOf('store: new Set')),others=auth.slice(auth.indexOf('store: new Set'),auth.indexOf('let session ='));
 assert.match(hq,/product-query\.html/);assert.doesNotMatch(others,/product-query\.html/);assert.match(auth,/\["product-query.html", "产品查询"\]/);assert.match(auth,/const homeActive = page === homes\[session.role\]/);
 const api=read('cloudbase-phone-auth.js');const review=api.slice(api.indexOf('async listRetailProductPurchaseReviews'),api.indexOf('async queryRetailProductRecords'));
 assert.match(review,/sourceType: "PURCHASE"/);const query=api.slice(api.indexOf('async queryRetailProductRecords'),api.indexOf('async reviewRetailProductPurchase'));
 assert.match(query,/sourceType = ""/);assert.match(query,/limit: 10/);assert.match(query,/retailProductId/);assert.match(query,/startDate, endDate/);
 for(const file of ['product-query.js','tracking-ui.js','rating-charts.js','web-report-export.js','web-login-presentation.js'])assert.doesNotMatch(read(file),/miniprogram-app|require\(|\.wxss|\.wxml/);
});

test('rating query and charts are separate inner pages behind one outer navigation entry',()=>{
 const query=read('rating-analysis.html'),charts=read('rating-charts.html'),auth=read('auth-ui.js'),client=read('operational-metrics.js');
 assert.doesNotMatch(query,/id="operationsCharts"/);assert.match(charts,/data-rating-view="charts"/);assert.doesNotMatch(charts,/id="operationsResults"/);assert.match(client,/scores: new Set\(\)/);assert.match(client,/!chartsOnly && !state\.scores\.size/);assert.match(client,/scores: chartsOnly \? \[0, 1, 2, 3, 4, 5\]/);
 const menu=auth.slice(auth.indexOf('const operationLinks'),auth.indexOf('document.querySelector(\'[data-menu="shared-query"]\')',auth.indexOf('const operationLinks')));assert.match(menu,/\["rating-analysis.html", "评价分析"\]/);assert.doesNotMatch(menu,/rating-charts.html/);
});


test('rating controls fill equal tracks and charts never report the paginated list count',()=>{
 const css=read('miniprogram-app/miniprogram/pages/rating-analysis/index.wxss');
 assert.match(css,/\.rating-page-tabs button \{ box-sizing: border-box; width: 100% !important; max-width: none !important/);
 assert.match(css,/\.page \.search-card > \.rating-search-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
 assert.match(css,/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); gap: 12px/);
 const client=read('operational-metrics.js');assert.match(client,/chartsOnly \? `图表已更新，共 \$\{Number\(state\.summary\.total \|\| 0\)\}/);assert.match(client,/score && row\.teacherServiceScore != null/);assert.doesNotMatch(client,/score && row\.teacherName/);
});
