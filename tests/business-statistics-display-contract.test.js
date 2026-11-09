"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),read=p=>fs.readFileSync(path.join(root,p),"utf8");
const face=read("cloudfunctions/faceRecognition/index.js");
test("current statistics backend version and deployment instructions agree",()=>{
 assert.match(face,/PHOTO_ONLY_FUNCTION \? "v13" : "v145"/);
 assert.equal(JSON.parse(read("cloudfunctions/faceRecognition/package.json")).version,"145.0.0");
 assert.match(read("cloudfunctions/faceRecognition/README.md"),/当前版本：`v145`/);
 for(const name of ["staffAccount","customerRating","verificationPhoto"])assert.match(read(`cloudfunctions/${name}/README.md`),/faceRecognition v145/);
});
test("customer histories have one-snapshot counts, fixed ten rows and old-client compatibility",()=>{
 assert.match(face,/function customerHistorySql\(/);
 assert.match(face,/if \(!options.numberedPage\) return sql;/);
 assert.match(face,/history_count AS[\s\S]*history_meta AS[\s\S]*history_rows AS/);
 assert.match(face,/LIMIT 10 OFFSET \(SELECT \(history_page - 1\) \* 10 FROM history_meta\)/);
 assert.match(face,/rows\.filter\(\(row\) => row.id !== null && row.id !== undefined\)/);
 for(const file of ["customer-profile.js","miniprogram-app/miniprogram/pages/customer-detail/index.js"]){
  const source=read(file);assert.match(source,/historyPageSize:\s*(?:10|HISTORY_LIMIT)/);
  assert.doesNotMatch(source,/target\.push\(row\)|cursorStack/);
 }
});
test("customer history geometry reuses existing pager and has no internal vertical scroll",()=>{
 const wxml=read("miniprogram-app/miniprogram/pages/customer-detail/index.wxml"),css=read("miniprogram-app/miniprogram/pages/customer-detail/index.wxss");
 assert.match(wxml,/class="table-pagination customer-pagination"/);
 assert.match(wxml,/class="customer-page-controls"/);assert.match(wxml,/class="customer-page-jump"/);
 assert.match(wxml,/class="list-row-number">\{\{index \+ 1\}\}/);
 assert.doesNotMatch(wxml.match(/<scroll-view[^\n]*record-scroll[^\n]*/)?.[0]||"",/scroll-y=/);
 assert.match(css,/\.record-scroll\[data-visible-rows="10"\] \{ height: 806rpx; \}/);
 assert.match(css,/\.record-scroll\[data-visible-rows="10"\] \{ height: 568px; \}/);
 const html=read("customer-detail.html");assert.match(html,/class="table-pagination list-pagination"/);
 assert.doesNotMatch(html,/loadMoreCustomerHistory/);
 assert.match(html,/<th>累计充值<\/th><th>累计退费<\/th><th>累计核销<\/th>/);
 assert.match(read("web-tablet-parity.css"),/customer-history-panel \.customer-record-scroll \{[^}]*max-height: none !important;[^}]*overflow-y: hidden !important;/s);
});
test("repeatable production audit is SELECT only and never runs balance refreshes",()=>{
 const sql=read("database/audits/001-business-statistics-readonly.sql");
 assert.doesNotMatch(sql,/\b(?:UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|TRUNCATE|refresh_customer_balance|reset_teacher)\b/i);
 for(const name of ["balance_mismatches","customer_cache_mismatches","invalid_units","orphan_business_references","duplicate_request_keys","negative_balances","latest_time_mismatches"])assert.ok(sql.includes(name));
});
test("historical business stages have one canonical migration and standalone console delivery",()=>{
 const migration=read("database/migrations/092_historical_customer_business_stage.sql");
 assert.equal(migration,read("database/cloudbase-console/092-01-historical-customer-business-stage.sql"));
 assert.match(migration,/WHEN NOT EXISTS \(SELECT 1 FROM public.recharge_records r/);
 assert.match(migration,/r.record_status = 'APPROVED' AND r.recharge_type = 'NEW'/);
 assert.match(migration,/v.verification_type IN \('NORMAL', 'SUPPLEMENT'\)/);
 const backfill=migration.slice(migration.indexOf("WITH expected AS"));
 assert.match(backfill,/SET customer_process_status = e.stage/);
 assert.doesNotMatch(backfill,/SET total_recharge_count|PERFORM public.refresh_customer_balance/);
 for(const file of ["092-preview.sql","092-readonly-verify.sql"])
   assert.doesNotMatch(read("database/cloudbase-console/"+file),/\b(?:UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
 const old=read("database/migrations/044_refund_application_workflow.sql");
 const functionBody=s=>s.slice(s.indexOf("CREATE OR REPLACE FUNCTION public.refresh_customer_balance("),s.indexOf("$$;",s.indexOf("AS $$",s.indexOf("CREATE OR REPLACE FUNCTION public.refresh_customer_balance(")))+3);
 const withoutStage=s=>functionBody(s).replace(/customer_process_status = CASE[\s\S]*?\n         END/,"customer_process_status = CASE /* audited separately */ END");
 assert.equal(withoutStage(migration),withoutStage(old),"Balance refresh changes only stage classification");
});
