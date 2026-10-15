"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../staff-detail.js'),'utf8');
function harness(){
  const nodes=new Map(),calls=[];let reject=false,finish;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',type:'password',hidden:id==='staffPasswordForm',disabled:false,textContent:'',attrs:{},events:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,f){this.events[k]=f;},focus(){}});return nodes.get(id);};
  const staff={auth_uid:'isolated-synthetic-uid'};
  const resetStaffPassword=async args=>{calls.push(args);if(reject)throw Error('隔离失败');await new Promise(resolve=>{finish=resolve;});};
  const begin=source.indexOf('  let passwordSaving = false;'),end=source.indexOf('  $("staffStatusAction").addEventListener',begin);
  vm.runInNewContext(source.slice(begin,end),{$,staff,window:{CloudBasePhoneAuth:{resetStaffPassword}},hasPhoneAuthMethod:()=>true,setButtonPending:(b,p)=>{b.disabled=p;},render:()=>{}});
  return {$,staff,calls,submit:()=>$('staffPasswordForm').events.submit({preventDefault(){}}),reject(){reject=true;},finish(){finish();}};
}
test('inline password form toggles visibility, validates locally, clears only after success',async()=>{
  const h=harness();h.$('staffCredentialAction').events.click();assert.equal(h.$('staffPasswordForm').hidden,false);
  h.$('toggleStaffPassword').events.click();assert.equal(h.$('staffNewPassword').type,'text');
  h.$('staffNewPassword').value='short';await h.submit();assert.equal(h.calls.length,0);assert.match(h.$('staffPasswordMessage').textContent,/8–32/);
  h.$('staffNewPassword').value='Synthetic@Test2048';const pending=h.submit();await Promise.resolve();await h.submit();assert.equal(h.calls.length,1);assert.equal(h.$('staffNewPassword').disabled,true);
  h.finish();await pending;assert.equal(h.$('staffNewPassword').value,'');assert.equal(h.$('staffNewPassword').type,'password');assert.equal(h.$('staffPasswordForm').hidden,true);assert.match(h.$('staffPasswordMessage').textContent,/已保存/);
});
test('inline password failure retains input for correction and cancel clears it',async()=>{
  const h=harness();h.$('staffCredentialAction').events.click();h.$('staffNewPassword').value='Synthetic@Test2048';h.reject();await h.submit();assert.equal(h.$('staffPasswordForm').hidden,false);assert.equal(h.$('staffNewPassword').value,'Synthetic@Test2048');assert.match(h.$('staffPasswordMessage').textContent,/隔离失败/);assert.equal(h.$('staffNewPassword').disabled,false);h.$('cancelStaffPassword').events.click();assert.equal(h.$('staffNewPassword').value,'');assert.equal(h.$('staffPasswordForm').hidden,true);
});
