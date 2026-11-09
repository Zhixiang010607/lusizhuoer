'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),mini=path.join(root,'miniprogram-app/miniprogram');
const {parseTeacherLookup,lookupCustomerCondition}=require('../cloudfunctions/faceRecognition/teacher-customer-lookup');
const fail=(message,code)=>{throw Object.assign(Error(message),{code});};
const quote=x=>"'"+String(x).replace(/'/g,"''")+"'";
const lookup={storeId:'1',customerName:'示例客户',customerCode:'QA-1'};
test('lookup requires exact explicit store/name/customer and refuses spoofed roles, bad ids and malformed names',()=>{
 assert.equal(parseTeacherLookup({},'teacher',fail),null);
 for(const role of ['hq','store','operation'])assert.throws(()=>parseTeacherLookup({teacherLookup:lookup},role,fail),{code:'FORBIDDEN'});
 for(const input of [null,[],{}, {...lookup,storeId:'1 OR TRUE'},{...lookup,storeId:'9223372036854775808'},{...lookup,customerName:''},{...lookup,customerName:'a'.repeat(41)},{...lookup,customerCode:''}])
  assert.throws(()=>parseTeacherLookup({teacherLookup:input},'teacher',fail),{code:'BAD_REQUEST'});
 const sql=lookupCustomerCondition(parseTeacherLookup({teacherLookup:{...lookup,customerName:"O'Neil%_"}},'teacher',fail),'c',quote);
 assert.match(sql,/c.customer_name = 'O''Neil%_'/);assert.doesNotMatch(sql,/ILIKE|LIKE|LOWER/);assert.match(sql,/store_status = 'ACTIVE'/);assert.match(sql,/customer_code = 'QA-1'/);
 assert.equal(fs.readFileSync(root+'/cloudfunctions/customerRating/teacher-customer-lookup.js','utf8'),fs.readFileSync(root+'/cloudfunctions/faceRecognition/teacher-customer-lookup.js','utf8'));
});
function pageFixture(route,api,session={uid:'qa',role:'teacher'}){
 let page;const links=[];
 vm.runInNewContext(fs.readFileSync(path.join(mini,'pages',route,'index.js'),'utf8'),{
  Page:x=>page=x,wx:{nextTick(){},navigateTo:x=>links.push(x.url),setNavigationBarTitle(){}},
  require(id){if(id.endsWith('/api'))return{callFace:api};if(id.endsWith('/session'))return{requireSession:roles=>roles.includes(session.role)?session:null,waitForStartupSession:async()=>{}};
   return require(path.resolve(mini,'pages',route,id));}
 });
 page.setData=(change,done)=>{Object.assign(page.data,change);if(done)done();};return{page,links};
}
const storeResult={stores:[{storeId:'1',storeName:'示例门店'}]};
test('teacher search has no default customer query, requires both fields and carries only chosen result to original homepage',async()=>{
 const calls=[];const{page,links}=pageFixture('teacher-customer-query',async(a,p)=>{calls.push([a,p]);return a==='getTeacherBusinessContext'?storeResult:{customers:[{customerCode:'QA-1',customerName:'示例客户'}],page:1,total:1,totalPages:1};});
 await page.onShow();assert.equal(calls.length,1);assert.equal(page.data.searched,false);
 await page.search();assert.equal(calls.length,1);
 page.selectStore({detail:{value:1}});await page.search();assert.equal(calls.length,1);
 page.inputName({detail:{value:'示例客户'}});assert.equal(calls.length,1);await page.search();
 assert.equal(calls[1][0],'queryTeacherCustomers');assert.deepEqual(JSON.parse(JSON.stringify(calls[1][1])),{teacherLookup:{storeId:'1',customerName:'示例客户'},page:1});
 page.openCustomer({currentTarget:{dataset:{code:'not-in-results'}}});assert.equal(links.length,0);
 page.openCustomer({currentTarget:{dataset:{code:'QA-1'}}});assert.match(links[0],/^\/pages\/customer-detail\/index\?/);
 const params=new URL('https://example.test'+links[0]).searchParams;assert.deepEqual(JSON.parse(params.get('teacherLookup')),lookup);
 page.inputName({detail:{value:'其他'}});page.openCustomer({currentTarget:{dataset:{code:'QA-1'}}});assert.equal(links.length,1);
});
test('late search response cannot repopulate customers after store or name changes',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const{page}=pageFixture('teacher-customer-query',async(a)=>a==='getTeacherBusinessContext'?storeResult:gate);
 await page.onShow();page.selectStore({detail:{value:1}});page.inputName({detail:{value:'示例客户'}});
 const request=page.search();page.inputName({detail:{value:'其他客户'}});release({customers:[{customerCode:'OLD'}],total:1});await request;
 assert.equal(page.data.customers.length,0);assert.equal(page.data.searched,false);
});
test('full homepage uses server edit rights, blocks foreign composer methods and preserves read context on order links',async()=>{
 const{page,links}=pageFixture('customer-detail',async()=>{throw Error('unexpected write');});
 page.load=async()=>{};page.onLoad({customerCode:'QA-1',teacherLookup:encodeURIComponent(JSON.stringify(lookup))});
 assert.equal(page.data.canEditNotes,false);assert.equal(page.data.canSendMessages,false);
 assert.deepEqual(JSON.parse(JSON.stringify(page.readPayload({customerCode:'QA-1'}))),{customerCode:'QA-1',teacherLookup:lookup});
 page.data.messageText='must not send';await page.submitMessage();page.startEditNotes();assert.equal(page.data.notesEditing,false);
 for(const type of ['RECHARGE','VERIFICATION','PRODUCT_PURCHASE']){
  page.data.historyType=type;page.openOrder({currentTarget:{dataset:{id:'1',code:'QA-ORDER',originalType:'NORMAL'}}});
  assert.deepEqual(JSON.parse(new URL('https://example.test'+links.at(-1)).searchParams.get('teacherLookup')),lookup);
 }
 const source=fs.readFileSync(mini+'/pages/order-detail/index.js','utf8');
 for(const action of ['getTeacherWorkspace','getVerificationPhotos','getVerificationPhotoThumbnailData','getVerificationPhotoOriginalUrl','getVerificationPhotoExportData','getForStaff'])assert.match(source,new RegExp('"'+action+'", this\\.readPayload\\('));
 assert.match(source,/ratingExport = \["store", "hq"\]/,'teachers cannot issue receipt rating QR codes');
});
