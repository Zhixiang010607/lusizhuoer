'use strict';
// Runs the pinned official SDK with a stub transport; zero network / SMS.
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const ownRequire=createRequire(require.resolve('tencentcloud-sdk-nodejs-sms'));
const {HttpConnection}=ownRequire('tencentcloud-sdk-nodejs-common/tencentcloud/common/http/http_connection');
const {officialClient}=require('../cloudfunctions/staffAccount/review-sms-sender');
(async()=>{
 let calls=0;const original=HttpConnection.doRequestWithSign3;
 try {
  HttpConnection.doRequestWithSign3=async config=>{
   calls++;assert.equal(config.url,'https://sms.tencentcloudapi.com/');assert.equal(config.timeout,5000);
   assert.equal(config.action,'SendSms');assert.equal(config.version,'2021-01-11');assert.equal(config.token,'isolated-token');
   assert.equal(config.data.SignName,'广州露思卓儿科技');assert.deepEqual(config.data.TemplateParamSet,[]);
   throw Error('isolated transport timeout');
  };
  const client=officialClient({secretId:'isolated-id',secretKey:'isolated-key',token:'isolated-token'});
  await assert.rejects(client.SendSms({PhoneNumberSet:['+8613800000001'],SmsSdkAppId:'1401179904',TemplateId:'2769944',SignName:'广州露思卓儿科技',TemplateParamSet:[],SessionContext:'isolated'}));
  assert.equal(calls,1,'the official SDK must not retry an uncertain SMS request');
  console.log(JSON.stringify({sdk:'tencentcloud-sdk-nodejs-sms@4.1.306',mockedTransportCalls:calls,networkRequests:0,smsSent:0}));
 } finally {HttpConnection.doRequestWithSign3=original;}
})().catch(e=>{console.error(e);process.exitCode=1;});
