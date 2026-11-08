"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createReviewSmsSender,parseSendResult,TEMPLATES,TRIGGER_NAME}=require('../cloudfunctions/staffAccount/review-sms-sender');
const sqlText=x=>`'${String(x).replaceAll("'","''")}'`;
const event={Type:'Timer',TriggerName:TRIGGER_NAME,Time:'2026-11-08T12:00:00Z'};
const env={TRIGGER_SRC:'timer',SCF_FUNCTIONNAME:'staffAccount',TENCENTCLOUD_SECRETID:'isolated-id',TENCENTCLOUD_SECRETKEY:'isolated-key',TENCENTCLOUD_SESSIONTOKEN:'isolated-token'};
function fixture(options={}) {
 const calls=[],sends=[];let control=0;let claims=0;
 const sender=createReviewSmsSender({env:{...env,...options.env},sqlText,requireControlPlane:async()=>{control++;if(options.user)throw Error('FORBIDDEN');},
 executeSql:async sql=>{calls.push(sql);
 if(sql.includes('delivery_state'))return [{enabled:options.enabled!==false,sdk_app_id:'1401179904'}];
 if(sql.includes('claim_'))return [{result:claims++<(options.jobs||1)?{id:String(claims),category:options.category||'recharge',phone:'+8613800000001'}:null}];
 if(sql.includes('start_'))return [{result:options.start!==false}];
 if(sql.includes('finish_'))return [{result:options.finish!==false}];throw Error('unexpected SQL');},
 clientFactory:()=>({SendSms:async req=>{sends.push(req);if(options.error)throw Error('private phone error');return options.response||{RequestId:'request',SendStatusSet:[{Code:'Ok',PhoneNumber:req.PhoneNumberSet[0],SessionContext:req.SessionContext,SerialNo:'serial'}]};}})});
 return {sender,calls,sends,get control(){return control;}};
}
test('disabled sender and missing temporary credentials never claim or call SMS',async()=>{
 for(const opts of [{enabled:false},{env:{TENCENTCLOUD_SESSIONTOKEN:''}}]){const f=fixture(opts);assert.equal((await f.sender.handle(event)).deliveryReady,false);assert.equal(f.calls.length,1);assert.equal(f.sends.length,0);assert.equal(f.control,1);}
});
test('ordinary client payload cannot forge the trusted timer',async()=>{
 for(const override of [{TRIGGER_SRC:'api'},{SCF_FUNCTIONNAME:'another'}])await assert.rejects(fixture({env:override}).sender.handle(event),{code:'UNTRUSTED_TIMER_EVENT'});
 await assert.rejects(fixture({user:true}).sender.handle(event),/FORBIDDEN/);
 await assert.rejects(fixture().sender.handle({...event,Time:'not-a-date'}),{code:'UNTRUSTED_TIMER_EVENT'});
 const f=fixture();assert.equal(await f.sender.handle({action:'sendSms',phone:'arbitrary'}),null);assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);
});
test('all four categories use approved fixed templates and bound phone only',async()=>{
 for(const [category,id] of Object.entries(TEMPLATES)){
  const f=fixture({category});assert.equal((await f.sender.handle(event)).accepted,1);
  assert.equal(f.sends.length,1);assert.equal(f.sends[0].TemplateId,id);assert.equal(f.sends[0].SignName,'广州露思卓儿科技');assert.deepEqual(f.sends[0].TemplateParamSet,[]);
  assert.deepEqual(f.sends[0].PhoneNumberSet,['+8613800000001']);assert.match(f.calls.find(x=>x.includes('finish_')),/'ACCEPTED','Ok'/);
 }
});
test('revoked claim never sends; timeout persists UNKNOWN without network retry',async()=>{
 const cancelled=fixture({start:false});await cancelled.sender.handle(event);assert.equal(cancelled.sends.length,0);
 const f=fixture({error:true});const result=await f.sender.handle(event);assert.equal(result.unknown,1);assert.equal(f.sends.length,1);assert.match(f.calls.find(x=>x.includes('finish_')),/'UNKNOWN','TRANSPORT_UNCONFIRMED'/);assert(!f.calls.join().includes('private phone error'));
});
test('bounded serial worker stops at five and never reports unconfirmed persistence as success',async()=>{
 const f=fixture({jobs:20});assert.equal((await f.sender.handle(event)).processed,5);assert.equal(f.sends.length,5);
 await assert.rejects(fixture({finish:false}).sender.handle(event),/SMS_RESULT_UNCONFIRMED/);
});
test('malformed/mismatched/provider timeout responses stay unknown; only matching receipt is accepted',()=>{
 const phone='+8613800000001',context='review-1';
 for(const r of [{},{SendStatusSet:[]},{RequestId:'r',SendStatusSet:[{Code:'Ok',PhoneNumber:phone,SessionContext:context}]},{RequestId:'r',SendStatusSet:[{Code:'Ok',SerialNo:'s',PhoneNumber:'+8613800000002',SessionContext:context}]}])assert.equal(parseSendResult(r,phone,context).status,'UNKNOWN');
 const response=code=>({RequestId:'request',SendStatusSet:[{Code:code,PhoneNumber:phone,SessionContext:context,SerialNo:''}]});
 assert.equal(parseSendResult(response('InternalError.Timeout'),phone,context).status,'UNKNOWN');
 assert.equal(parseSendResult(response('FailedOperation.TemplateIncorrectOrUnapproved'),phone,context).status,'REJECTED');
});
