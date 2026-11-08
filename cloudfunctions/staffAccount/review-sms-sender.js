"use strict";
const crypto = require("node:crypto");
const TRIGGER_NAME = "send-hq-review-sms";
const TEMPLATES = Object.freeze({purchase:"2769941",recharge:"2769944",refund:"2769946",verification:"2769949"});
const SIGN_NAME = "露思卓儿";
const field = rows => {
  const value=rows?.[0]?.result;
  return typeof value === "string" ? JSON.parse(value) : value;
};
const safeCode = value => /^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(String(value||"")) ? String(value) : "UNCONFIRMED";
const safeId = value => /^[A-Za-z0-9:_-]{1,200}$/.test(String(value||"")) ? String(value) : "";
function credentials(env) {
  // Refresh SCF's short-lived execution-role credentials on every invocation.
  const {TENCENTCLOUD_SECRETID:secretId,TENCENTCLOUD_SECRETKEY:secretKey,TENCENTCLOUD_SESSIONTOKEN:token}=env;
  return secretId && secretKey && token ? {secretId,secretKey,token} : null;
}
function officialClient(credential) {
  const {Client}=require("tencentcloud-sdk-nodejs-sms").sms.v20210111;
  return new Client({credential,region:"ap-guangzhou",profile:{httpProfile:{endpoint:"sms.tencentcloudapi.com",protocol:"https://",reqTimeout:5}}});
}
function parseSendResult(response,phone,context) {
  const statuses=response?.SendStatusSet;
  const status=Array.isArray(statuses)&&statuses.length===1 ? statuses[0] : null;
  if (!status || status.PhoneNumber!==phone || status.SessionContext!==context || !safeId(response.RequestId)) {
    return {status:"UNKNOWN",code:"UNCONFIRMED_RESPONSE",request:"",serial:""};
  }
  if (status.Code === "Ok" && safeId(status.SerialNo)) {
    return {status:"ACCEPTED",code:"Ok",request:safeId(response.RequestId),serial:safeId(status.SerialNo)};
  }
  // A provider timeout/internal error does not prove non-acceptance.
  const code=safeCode(status.Code);
  const rejected=/^(InvalidParameter|InvalidParameterValue|UnauthorizedOperation|AuthFailure|LimitExceeded|FailedOperation\.(Sign|Template|PhoneNumber|InsufficientBalance|ContainsSensitiveWord|SmsSdkAppId))/.test(code);
  return {status:rejected?"REJECTED":"UNKNOWN",code,request:safeId(response.RequestId),serial:""};
}
function createReviewSmsSender({executeSql,sqlText,requireControlPlane,env=process.env,clientFactory=officialClient,now=Date.now}) {
  async function configuration() {
    const rows=await executeSql("SELECT enabled,sdk_app_id FROM public.hq_review_sms_delivery_state WHERE singleton=TRUE");
    const config=rows?.[0];
    return {enabled:config?.enabled===true||config?.enabled==="true",appId:String(config?.sdk_app_id||"")};
  }
  async function ready() {
    const config=await configuration();
    return config.enabled && /^140[0-9]{7}$/.test(config.appId) && Boolean(credentials(env));
  }
  async function handle(event={},context={}) {
    if (event.Type!=="Timer" || event.TriggerName!==TRIGGER_NAME) return null;
    if (String(env.TRIGGER_SRC).toLowerCase()!=="timer" || env.SCF_FUNCTIONNAME!=="staffAccount"
      || (context.function_name && context.function_name!=="staffAccount") || !Number.isFinite(Date.parse(event.Time))) {
      throw Object.assign(Error("短信定时任务来源无效"),{code:"UNTRUSTED_TIMER_EVENT"});
    }
    await requireControlPlane();
    const config=await configuration(), credential=credentials(env);
    if (!config.enabled || !/^140[0-9]{7}$/.test(config.appId) || !credential) return {ok:true,timer:true,deliveryReady:false,processed:0};
    const client=clientFactory(credential), began=now();
    let processed=0,accepted=0,unknown=0,rejected=0;
    for(let index=0;index<5 && now()-began<25000;index++) {
      const token=crypto.randomBytes(16).toString("hex");
      const job=field(await executeSql(`SELECT public.claim_hq_review_sms_v96(${sqlText(token)}) AS result`));
      if (!job) break;
      if(job.skipped) continue;
      if(!/^[1-9][0-9]*$/.test(String(job.id)) || !TEMPLATES[job.category] || !/^\+861[3-9][0-9]{9}$/.test(job.phone)) throw Error("SMS_INVALID_JOB");
      // No provider call until a confirmed durable SENDING transition.
      if(field(await executeSql(`SELECT public.start_hq_review_sms_v96(${job.id},${sqlText(token)}) AS result`))!==true) continue;
      let outcome;
      const session=`review-${job.id}-${token}`;
      try {
        const response=await client.SendSms({PhoneNumberSet:[job.phone],SmsSdkAppId:config.appId,SignName:SIGN_NAME,
          TemplateId:TEMPLATES[job.category],TemplateParamSet:[],SessionContext:session});
        outcome=parseSendResult(response,job.phone,session);
      } catch (_) {
        // No request retry: a transport timeout can already have sent the SMS.
        // SDK errors may contain the phone or signature, so never log/store them.
        outcome={status:"UNKNOWN",code:"TRANSPORT_UNCONFIRMED",request:"",serial:""};
      }
      const saved=field(await executeSql(`SELECT public.finish_hq_review_sms_v96(${job.id},${sqlText(token)},${sqlText(outcome.status)},${sqlText(outcome.code)},${sqlText(outcome.request)},${sqlText(outcome.serial)}) AS result`));
      if(saved!==true) throw Error("SMS_RESULT_UNCONFIRMED");
      processed++; if(outcome.status==="ACCEPTED")accepted++; else if(outcome.status==="REJECTED")rejected++; else unknown++;
    }
    // Counts only. ACCEPTED means provider accepted, not handset delivery.
    return {ok:true,timer:true,deliveryReady:true,processed,accepted,rejected,unknown};
  }
  function diagnostics() {
    let sdkInstalled=false;
    try { require.resolve("tencentcloud-sdk-nodejs-sms"); sdkInstalled=true; } catch (_) { /* health must not expose paths */ }
    return {executionCredentialsAvailable:Boolean(credentials(env)),sdkInstalled};
  }
  return {handle,ready,diagnostics};
}
module.exports={TRIGGER_NAME,TEMPLATES,SIGN_NAME,createReviewSmsSender,parseSendResult,officialClient};
