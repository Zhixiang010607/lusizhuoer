// Visible HQ home/review pages own the shared timer. Badges are server queue sizes,
// never an unread counter, and never optimistic local deductions.
const { callStaff } = require('./api');
const EMPTY = Object.freeze({ purchase:0, recharge:0, refund:0, verification:0 });
const INTERVAL_MS = 30000;
const listeners = new Set();
let uid='', generation=0, running=null, background=false, timer=null;
let state=emptyState();
function emptyState() { return { ready:false, syncing:false, counts:{...EMPTY}, total:0, revision:'', error:'', forbidden:false }; }
function owner() {
  try {
    const data=getApp().globalData;
    const session=data&&data.startupReady===true&&data.session;
    return session&&session.role==='hq'&&session.uid?String(session.uid):'';
  } catch(_) { return ''; }
}
function snapshot() { return {...state,counts:{...state.counts}}; }
function emit() { for(const listener of listeners)listener(snapshot()); }
function stopTimer() { if(timer!==null){clearTimeout(timer);timer=null;} }
function reset(next) {
  generation++; uid=next; stopTimer(); state=emptyState(); emit();
  // Retain the in-flight promise until it settles; never overlap two reads.
}
function valid(account) { return Boolean(account&&account===uid&&owner()===account&&!background&&listeners.size); }
function schedule() {
  stopTimer();
  if(valid(uid)&&!state.forbidden)timer=setTimeout(()=>{timer=null;void refresh();},INTERVAL_MS);
}
function decode(value) {
  const counts={};
  for(const key of Object.keys(EMPTY)) {
    const n=Number(value?.counts?.[key]);
    if(!Number.isSafeInteger(n)||n<0)throw Error('审核数量读取不完整');
    counts[key]=n;
  }
  const total=Object.values(counts).reduce((a,b)=>a+b,0);
  if(!Number.isSafeInteger(total)||Number(value.total)!==total||!value.revision)throw Error('审核数量读取不完整');
  return {counts,total,revision:String(value.revision)};
}
function refresh({force=false}={}) {
  const account=owner();
  if(account!==uid)reset(account);
  if(!valid(account))return Promise.resolve();
  stopTimer();
  if(force||!running)generation++;
  if(force){state={...state,ready:false,syncing:true,error:''};emit();}
  if(running)return running;
  const task=(async()=>{
    // Force-refresh during an old read invalidates its response and serially
    // re-reads. This prevents a pre-review snapshot overwriting a saved review.
    while(valid(uid)) {
      const requested=generation, requestedOwner=uid;
      state={...state,syncing:true}; emit();
      try {
        const value=decode(await callStaff('getPendingReviewCounts'));
        if(requested!==generation||requestedOwner!==uid)continue;
        if(!valid(requestedOwner))return;
        state={...state,...value,ready:true,syncing:false,error:'',forbidden:false}; emit(); return;
      } catch(error) {
        if(requested!==generation||requestedOwner!==uid)continue;
        if(!valid(requestedOwner))return;
        const forbidden=['FORBIDDEN','UNAUTHENTICATED','UNASSIGNED_IDENTITY','ACCOUNT_ARCHIVED'].includes(String(error?.code||''));
        state={...state,ready:false,syncing:false,error:'数量更新失败，点击重试',forbidden}; emit(); return;
      }
    }
  })();
  running=task;
  task.finally(()=>{if(running===task){running=null;schedule();}});
  return task;
}
function subscribe(listener) {
  const account=owner();
  if(account!==uid)reset(account);
  listeners.add(listener); listener(snapshot());
  if(account&&!background)void refresh({force:true});
  return ()=>{listeners.delete(listener);if(!listeners.size){generation++;stopTimer();}};
}
function pause() { background=true;generation++;stopTimer();state={...state,ready:false,syncing:false};emit(); }
function resume() {
  background=false;
  if(owner()!==uid)reset(owner());
  if(listeners.size)void refresh({force:true});
}
function invalidate() { return refresh({force:true}); }
function retryNow() { state={...state,forbidden:false};return refresh({force:true}); }
module.exports={subscribe,invalidate,pause,resume,retryNow};
