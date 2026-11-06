(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const params = new URLSearchParams(location.search);
  const pool = Array.from({length: 18}, (_, i) => ({id:i + 1, name:`示例老师${String.fromCharCode(65 + i)}`, phone:`0000000${String(i + 1).padStart(4,'0')}`}));
  const initialScene = ['basic','personnel','leader'].includes(params.get('scene')) ? params.get('scene') : 'basic';
  const state = {scene:initialScene, device:['phone','ipad','desktop'].includes(params.get('device')) ? params.get('device') : 'phone', leader:initialScene !== 'basic', members:new Set(initialScene !== 'basic' ? [2,3,4] : []), tab:'basic', view:'home', keyword:'', searched:false, memberPage:1, candidatePage:1, ops:false, selected:2, punch:'上班打卡', year:'2026', month:'11'};
  if(state.scene==='leader'&&state.device==='desktop') state.device='ipad';
  state.day='6';state.date='2026-11-06';state.trackingPages={};
  if(['home','operations','attendance','reports','activity','balance','members'].includes(params.get('view')))state.view=params.get('view');
  let confirmAction = null, toastTimer;
  const teacher = id => pool.find(t => t.id === Number(id));
  const memberRows = () => pool.filter(t => state.members.has(t.id));
  const trackingGroups = () => [
    {key:'complete',title:'完整打卡',empty:'所选日期暂无完整打卡老师',rows:[]},
    {key:'in',title:'仅上班打卡',empty:'所选日期暂无仅上班打卡老师',rows:[]},
    {key:'out',title:'仅下班打卡',empty:'所选日期暂无仅下班打卡老师',rows:[]},
    {key:'missing',title:'未打卡',empty:'全部在职成员均已有打卡记录',rows:[]}
  ].map((g,j)=>({...g,rows:memberRows().filter((t,i)=>[0,1,3,2][i%4]===j)}));
  const btn = (text, action, cls='secondary', attrs='') => `<button class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;
  const title = (text, back, extra='') => `<div class="page-heading"><div>${back ? btn('‹ '+back, 'back', 'back-link') : ''}<h2>${text}</h2>${extra}</div></div>`;
  const cardTitle = (text, badge='') => `<div class="card-heading"><h3>${text}</h3>${badge ? `<span class="badge">${badge}</span>` : ''}</div>`;
  const tabs = () => `<div class="tabs ${state.leader?'five':''}">${[['home','老师主页'],['basic','基本资料'],['projects','项目配置'],['work','考勤日报'],...(state.leader ? [['personnel','人员管理']] : [])].map(([id,label])=>`<button data-tab="${id}" class="${(state.scene==='personnel' ? id==='personnel' : id===state.tab)?'current':''}">${label}</button>`).join('')}</div>`;
  const shell = content => `<header class="app-brand"><span class="brand-back">‹</span>露思卓儿<span class="mini-menu">••• ◉</span></header><nav class="app-nav">${(state.scene==='leader'?['总览','办理','学习',...(state.leader?['小组运营']:[]),'退出']:['总览','查询','运营','管理','审核','退出']).map(n=>`<button data-action="nav" data-name="${n}" class="${n===(state.scene==='leader'?'总览':'管理')?'current':''}">${n}</button>`).join('')}</nav><div class="app-main">${content}</div>`;
  function profile(t=pool[0], readonly=false) {
    return `<section class="card profile-card"><div class="avatar">${esc(t.name.slice(-1))}</div><div class="profile-copy"><div class="profile-type">${readonly?'成员档案':'老师档案'}</div><div class="profile-name">${esc(t.name)}<span class="badge active">活跃</span>${t.id===1&&state.leader?'<span class="badge small">小组长</span>':''}</div><div class="profile-phone">联系电话 ${esc(t.phone)}</div></div>${readonly?'':btn(state.leader?'取消组长':'设为组长','role',`role-action ${state.leader?'cancel':''}`)}</section>`;
  }
  function projects() {
    return `<section class="card">${cardTitle('项目情况')}<table class="project-table"><thead><tr><th>项目</th><th>本人核销</th><th>体验余次</th></tr></thead><tbody>${['海洋之蕴','魔法柔肤','露思康辰'].map((p,i)=>`<tr><td>${p}</td><td>${[18,12,9][i]} 次</td><td><strong>${[16,20,12][i]} 次</strong></td></tr>`).join('')}</tbody></table></section>`;
  }
  function account() {
    return `<section class="card">${cardTitle('老师账号管理')}<label class="field-label" for="password">新临时密码</label><div class="password-field"><input id="password" type="password" placeholder="请输入新临时密码" autocomplete="off">${btn('显示','password','')}</div><p class="help">8–32 位，以字母或数字开头；大写、小写、数字、特殊字符中至少含三类。</p><div class="button-row">${btn('保存新临时密码','demo','secondary')}${btn('封存老师','demo','danger')}</div></section>`;
  }
  function pager(kind, count) {
    if (!count) return '';
    const pages = Math.ceil(count/10), page = state[kind+'Page'];
    if (pages===1) return `<div class="single-page">第 1 / 1 页 · 共 ${count} 位</div>`;
    return `<div class="pager"><div class="pager-line">${btn('上一页','page','',`data-kind="${kind}" data-step="-1" ${page===1?'disabled':''}`)}<span>第 ${page} / ${pages} 页 · 共 ${count} 位</span>${btn('下一页','page','',`data-kind="${kind}" data-step="1" ${page===pages?'disabled':''}`)}</div><div class="pager-line"><label for="jump-${kind}">跳至第</label><input id="jump-${kind}" inputmode="numeric" value="${page}" aria-label="跳转页码"><span>页</span>${btn('跳转','jump','jump-button',`data-kind="${kind}" data-pages="${pages}"`)}</div></div>`;
  }
  function memberList(hq) {
    const rows = memberRows(), page = Math.max(1,Math.min(state.memberPage,Math.ceil(rows.length/10)||1));
    state.memberPage=page;
    return `${rows.length ? `<div class="list">${rows.slice((page-1)*10,page*10).map((t,i)=>`<div class="person-row"><span class="row-number">${i+1}</span><div>${hq?`<strong>${esc(t.name)}</strong>`:btn(esc(t.name),'profile','person-name',`data-id="${t.id}"`)}<span class="person-meta">${esc(t.phone)}</span></div>${hq?btn('移除','remove','row-action',`data-id="${t.id}"`):'<span class="badge readonly small">查看 ›</span>'}</div>`).join('')}</div>` : '<div class="empty">尚未分配老师</div>'}${pager('member',rows.length)}`;
  }
  function candidates() {
    if(!state.searched) return '<p class="compact-help">按姓名模糊搜索普通老师。每位老师仅能加入一个小组。</p>';
    const rows = pool.filter(t=>t.id!==1&&t.id!==8&&t.name.toLowerCase().includes(state.keyword.toLowerCase()));
    state.candidatePage=Math.max(1,Math.min(state.candidatePage,Math.ceil(rows.length/10)||1));
    return `<div class="search-results"><p class="search-caption">找到 ${rows.length} 位普通老师</p>${rows.slice((state.candidatePage-1)*10,state.candidatePage*10).map((t,i)=>`<div class="person-row"><span class="row-number">${i+1}</span><div><strong>${esc(t.name)}</strong><span class="person-meta">${esc(t.phone)}</span></div>${t.id===6?'<span class="assigned">已分配给<br>另一位组长</span>':btn(state.members.has(t.id)?'已在本组':'添加','add','row-action add',`data-id="${t.id}" ${state.members.has(t.id)?'disabled':''}`)}</div>`).join('')||'<div class="empty">没有匹配的普通老师</div>'}${pager('candidate',rows.length)}</div>`;
  }
  function personnel() {
    return `${title('老师主页','返回老师管理')}${tabs()}${profile()}<div class="section-grid"><section class="card">${cardTitle('管理名单',`${state.members.size} 位老师`)}${memberList(true)}</section><section class="card">${cardTitle('添加老师')}<form class="search-row" id="searchForm"><input id="teacherSearch" value="${esc(state.keyword)}" placeholder="输入老师姓名" aria-label="搜索老师姓名"><button class="primary" type="submit">搜索</button></form>${candidates()}</section></div>`;
  }
  function hq() {
    if(state.scene==='personnel'&&state.leader) return personnel();
    return `${title('老师主页','返回老师管理')}${tabs()}${profile()}${state.tab==='basic'?account():state.tab==='projects'?projects():state.tab==='work'?work('attendance',pool[0]):`${projects()}<section class="card quiet-card">${btn('查看考勤日报 <span>›</span>','hq-work','quick-link')}</section>`}`;
  }
  const stat = (label,n,unit='') => `<div class="stat"><small>${label}</small><strong>${n}<span>${unit}</span></strong></div>`;
  function leaderHome() {
    return `${title('露思卓儿',null,'<span class="eyebrow">老师工作台</span>')}<section class="card">${cardTitle('我的基础信息')}<div class="teacher-facts"><div><small>老师姓名</small><strong>示例老师A</strong></div><div><small>联系电话</small><strong>00000000001</strong></div></div></section><section class="card">${cardTitle('体验项目剩余次数','3 个项目')}<div class="teacher-quotas">${['海洋之蕴','魔法柔肤','露思康辰'].map((p,i)=>`<div class="teacher-quota"><strong>${p}</strong>${[['可用',[16,20,12][i]],['每月基础',30],['本月已用',[14,10,18][i]]].map(([l,v])=>`<div><small>${l}</small><b>${v} 次</b></div>`).join('')}</div>`).join('')}</div></section><section class="card">${cardTitle('业务汇总','今天')}<div class="segmented teacher-range">${['今天','本周','本月','更多 ⌄'].map((r,i)=>btn(r,'own-range',i===0?'current':'')).join('')}</div><table class="project-table"><thead><tr><th>项目</th><th>核销</th><th>充值</th><th>体验</th><th>退费</th></tr></thead><tbody>${['海洋之蕴','魔法柔肤','露思康辰','合计'].map((p,i)=>`<tr><td>${p}</td><td>${[3,1,0,4][i]} 次</td><td>${[0,2,0,2][i]} 次</td><td>0 次</td><td>0 次</td></tr>`).join('')}</tbody></table></section><section class="card">${cardTitle('本人业务明细','共 2 条')}<div class="segmented">${['正常核销','充值','体验','退费'].map((r,i)=>btn(r,'own-type',i===0?'current':'')).join('')}</div><div class="tracking-scroll"><table class="tracking-table"><thead><tr><th>序号</th><th>单号</th><th>门店</th><th>客户</th><th>项目</th><th>次数</th><th>提交时间</th></tr></thead><tbody>${[1,2].map(i=>`<tr><td>${i}</td><td>${btn('示例工单'+i,'demo','person-name')}</td><td>示例门店</td><td>${btn('示例客户'+i,'demo','person-name')}</td><td>海洋之蕴</td><td>1 次</td><td>2026-11-06 10:0${i}:00</td></tr>`).join('')}</tbody></table></div><div class="single-page">第 1 / 1 页 · 共 2 条</div></section>`;
  }
  function operations() {
    return `${title('小组运营','返回老师工作台')}<section class="card">${cardTitle('管理名单',`${state.members.size} 位老师`)}${btn('查看成员主页 <span>›</span>','view','quick-link','data-view="members"')}</section><section class="card">${cardTitle('运营查询')}<div class="team-entry-list">${[['attendance','打卡追踪'],['reports','日报追踪'],['activity','活跃预警'],['balance','余次预警']].map(([v,n])=>btn(`${n}<span>›</span>`,'view','quick-link',`data-view="${v}"`)).join('')}</div></section>`;
  }
  function work(view, one=null) {
    const rows = one?[one]:memberRows();
    return `<section class="card">${cardTitle(view==='reports'?'工作日报':'考勤记录',`${rows.length} 位老师`)}<div class="date-controls"><select id="year" aria-label="选择年">${['2026','2025','2024'].map(y=>`<option ${state.year===y?'selected':''}>${y}</option>`).join('')}</select><select id="month" aria-label="选择月">${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${state.month===String(i+1)?'selected':''}>${i+1} 月</option>`).join('')}</select>${btn('查询','date','primary')}</div>${view==='attendance'?`<div class="segmented">${['上班打卡','下班打卡'].map(t=>btn(t,'punch',state.punch===t?'current':'',`data-punch="${t}"`)).join('')}</div>`:''}${rows.map((t,i)=>`<div class="record-row"><div class="record-row-head">${one?`<strong>${esc(t.name)}</strong>`:btn(esc(t.name),'profile','person-name',`data-id="${t.id}"`)}<span class="${view==='reports'?'report-badge':'badge readonly'}">${view==='reports'?'已提交':state.punch}</span></div>${view==='reports'?`<small>${state.year}-${state.month.padStart(2,'0')}-06 18:05</small><div class="report-copy">今日完成客户回访 ${i+3} 位，整理项目记录并跟进客户预约。</div>`:`<small>${state.year}-${state.month.padStart(2,'0')}-06 ${state.punch==='上班打卡'?'09:02:36':'18:10:24'}（北京时间）<br>示例门店 · 打卡照片已保存</small>${btn('查看打卡照片','demo','row-action')}`}</div>`).join('')||'<div class="empty">暂无成员记录</div>'}</section>`;
  }
  function warning(view) {
    const balance=view==='balance';
    return `<section class="card">${cardTitle(balance?'客户余次':'客户活跃度')}<form id="filterForm" class="filter-input"><label for="threshold">${balance?'余次不超过':'未核销超过'}</label><input id="threshold" value="${balance?5:30}" inputmode="numeric"><span>${balance?'次':'天'}</span><button class="primary">查询</button></form>${memberRows().map((t,i)=>`<div class="record-row"><div class="record-row-head"><strong>示例客户${i+1}</strong><span class="badge">${balance?[3,2,5,1][i%4]+' 次':[36,42,51,39][i%4]+' 天'}</span></div><small>归属老师：${esc(t.name)} · ${28+i} 岁<br>${balance?'海洋之蕴 · 当前可用余次':'最近正常核销：2026-09-25'}</small></div>`).join('')||'<div class="empty">暂无分配成员的数据</div>'}</section>`;
  }
  function tracking() {
    const groups=trackingGroups();
    return `<section class="card tracking-date"><label class="sr-only" for="trackingYear">年</label><select id="trackingYear">${['2026','2025','2024'].map(y=>`<option value="${y}" ${state.year===y?'selected':''}>${y}年</option>`).join('')}</select><label class="sr-only" for="trackingMonth">月</label><select id="trackingMonth">${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${state.month===String(i+1)?'selected':''}>${i+1}月</option>`).join('')}</select><label class="sr-only" for="trackingDay">日</label><select id="trackingDay">${Array.from({length:new Date(Number(state.year),Number(state.month),0).getDate()},(_,i)=>`<option value="${i+1}" ${state.day===String(i+1)?'selected':''}>${i+1}日</option>`).join('')}</select>${btn('确认','tracking-date','secondary')}</section><div class="tracking-summary"><div><strong>${state.date}</strong><small>本组在职老师考勤</small></div><div class="tracking-counts">${groups.map(g=>`<span>${g.title} ${g.rows.length}</span>`).join('')}</div></div><div class="tracking-groups">${groups.map(g=>{
      const pages=Math.ceil(g.rows.length/10)||1,page=Math.min(state.trackingPages[g.key]||1,pages);
      return `<section class="card tracking-status">${cardTitle(g.title,`${g.rows.length} 人`)}${g.rows.length?`<div class="tracking-scroll"><table class="tracking-table"><thead><tr><th>老师姓名</th><th>老师电话</th><th>上班时间（北京）</th><th>上班详情</th><th>下班时间（北京）</th><th>下班详情</th><th>工作时长</th></tr></thead><tbody>${g.rows.slice((page-1)*10,page*10).map(t=>`<tr><td>${btn(esc(t.name),'profile','person-name',`data-id="${t.id}"`)}</td><td>${esc(t.phone)}</td><td>${['complete','in'].includes(g.key)?state.date+' 09:02:36':'—'}</td><td>${['complete','in'].includes(g.key)?btn('查看详情','punch-detail','person-name',`data-id="${t.id}" data-kind="in"`):'—'}</td><td>${['complete','out'].includes(g.key)?state.date+' 18:10:24':'—'}</td><td>${['complete','out'].includes(g.key)?btn('查看详情','punch-detail','person-name',`data-id="${t.id}" data-kind="out"`):'—'}</td><td>${g.key==='complete'?'9小时7分钟':'—'}</td></tr>`).join('')}</tbody></table></div>${pages>1?`<div class="tracking-pager">${btn('上一页','tracking-page','row-action',`data-key="${g.key}" data-page="${page-1}" ${page===1?'disabled':''}`)}<span>第 ${page} / ${pages} 页</span>${btn('下一页','tracking-page','row-action',`data-key="${g.key}" data-page="${page+1}" ${page===pages?'disabled':''}`)}<label>跳至 <input id="trackingJump-${g.key}" inputmode="numeric" value="${page}"> 页</label>${btn('跳转','tracking-jump','row-action',`data-key="${g.key}" data-pages="${pages}"`)}</div>`:''}`:`<div class="tracking-empty">${g.empty}</div>`}</section>`;
    }).join('')}</div>`;
  }
  function openPunch(id,kind) {
    if(!state.leader||!state.members.has(id))return toast('该老师已不在管理名单中');
    const t=teacher(id),label=kind==='out'?'下班打卡':'上班打卡',time=kind==='out'?'18:10:24':'09:02:36';
    $('#attendanceContent').innerHTML=`<div class="card-heading"><div><h3 id="attendanceTitle">${label}详情</h3><small class="person-meta">${esc(t.name)} · ${esc(t.phone)}</small></div>${btn('关闭','close-punch','row-action')}</div><div class="punch-preview-body"><div class="punch-preview-location"><dl class="punch-meta">${[['老师姓名',t.name],['老师电话',t.phone],['打卡类型',label],['打卡时间（北京时间）',state.date+' '+time],['附近地点','示例门店'],['具体地址','示例地址，仅用于排版预览']].map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><div class="sample-map"><span>地图预览样例</span><b>●</b></div>${btn('在地图中打开','demo','secondary')}</div><div class="sample-photo"><span class="sample-photo-label">打卡照片样例</span><div class="sample-head"></div><div class="sample-body"></div><div class="photo-watermark"><strong>${label} 北京时间</strong><span>${state.date} ${time}</span></div></div></div>`;
    $('#attendanceModal').className=`modal-backdrop ${state.device==='phone'?'phone-modal':''}`;
    $('#attendanceModal').hidden=false;
  }
  function leader() {
    if(!state.leader) return leaderHome();
    if(state.view==='home') return leaderHome();
    if(state.view==='operations') return operations();
    if(state.view==='profile') {
      if(!state.members.has(state.selected)) return `${title('成员主页','返回管理名单')}<section class="card empty">该老师已不在管理名单中</section>`;
      return `${title('成员主页','返回管理名单')}${profile(teacher(state.selected),true)}<div class="segmented">${btn('老师主页','member-tab',state.memberTab!=='work'?'current':'','data-member-tab="home"')}${btn('考勤日报','member-tab',state.memberTab==='work'?'current':'','data-member-tab="work"')}</div>${state.memberTab==='work'?work('attendance',teacher(state.selected)):projects()}`;
    }
    const names={members:'管理名单',attendance:'成员打卡',reports:'成员日报',activity:'客户活跃度',balance:'客户余次'};
    return `${title(state.view==='attendance'?'打卡追踪':names[state.view],'返回小组运营')}<p class="readonly-note">示例老师A的小组 · ${state.members.size} 位成员</p>${state.view==='members'?`<section class="card">${cardTitle('管理名单',`${state.members.size} 位老师`)}${memberList(false)}</section>`:state.view==='attendance'?tracking():state.view==='reports'?work(state.view):warning(state.view)}`;
  }
  function render() {
    $('#deviceFrame').className=`device-frame ${state.device}`;
    $('#app').innerHTML=shell(state.scene==='leader'?leader():hq());
    if(state.scene==='leader'&&state.leader&&state.view!=='home'){document.querySelectorAll('.app-nav button[data-name]').forEach(b=>b.classList.toggle('current',b.dataset.name==='小组运营'));}
    document.querySelectorAll('[data-scene]').forEach(b=>b.classList.toggle('active',b.dataset.scene===state.scene));
    document.querySelectorAll('[data-device]').forEach(b=>b.classList.toggle('active',b.dataset.device===state.device));
    $('#designState').innerHTML=`当前身份：<strong>${state.leader?'小组长':'普通老师'}</strong><br>管理成员：<strong>${state.members.size} 位</strong><br>撤销组长后，成员全部释放。`;
  }
  function toast(text) { clearTimeout(toastTimer); $('#toast').textContent=text; $('#toast').hidden=false; toastTimer=setTimeout(()=>$('#toast').hidden=true,2600); }
  function modal(titleText,body,callback) {$('#modalTitle').textContent=titleText;$('#modalBody').textContent=body;$('#modal').hidden=false;confirmAction=callback;$('#modalConfirm').focus();}
  function closeModal() {$('#modal').hidden=true;confirmAction=null;}
  document.addEventListener('submit', e=>{e.preventDefault();if(e.target.id==='searchForm'){state.keyword=$('#teacherSearch').value.trim();state.searched=true;state.candidatePage=1;render();}else if(e.target.id==='filterForm'){toast('已更新本组成员的示例结果');}});
  document.addEventListener('change',e=>{if(['trackingYear','trackingMonth'].includes(e.target.id)){const day=$('#trackingDay'),previous=Number(day.value),max=new Date(Number($('#trackingYear').value),Number($('#trackingMonth').value),0).getDate();day.innerHTML=Array.from({length:max},(_,i)=>`<option value="${i+1}" ${i+1===Math.min(previous,max)?'selected':''}>${i+1}日</option>`).join('');}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.id==='modalConfirm'){const callback=confirmAction;closeModal();callback?.();return;}
    if(b.dataset.device){if(b.dataset.device==='desktop'&&state.scene==='leader'){toast('电脑网页版保持总部专用；组长请查看手机或 iPad');return;}state.device=b.dataset.device;render();return;}
    if(b.dataset.scene){if(b.dataset.scene==='personnel'&&!state.leader){state.scene='basic';state.tab='basic';render();toast('请先在资料卡中设置组长，或载入样例');return;}state.scene=b.dataset.scene;if(state.scene==='leader'&&state.device==='desktop')state.device='ipad';state.ops=false;state.view='home';if(state.scene==='basic')state.tab='basic';render();return;}
    if(b.dataset.tab){state.tab=b.dataset.tab;state.scene=state.tab==='personnel'?'personnel':'basic';render();return;}
    const a=b.dataset.action;
    if(a==='reset'){state.leader=true;state.members=new Set([2,3,4]);state.memberPage=1;state.searched=false;state.tab='basic';state.view='home';render();toast('已载入隔离样例');}
    else if(a==='role'){
      if(state.leader)modal('取消小组长？',`取消后，${state.members.size} 位成员将全部释放为未分配状态，可由总部重新分配。老师原有业务、打卡与日报保留。`,()=>{state.leader=false;state.members.clear();state.scene='basic';state.tab='basic';state.searched=false;render();toast('已取消组长，成员已全部释放');});
      else modal('设置为小组长？','设置后将显示“人员管理”，由总部分配普通老师。组长可查看成员运营数据。',()=>{state.leader=true;render();toast('已设置组长，请前往人员管理添加老师');});
    }
    else if(a==='add'){const id=Number(b.dataset.id);if(state.scene!=='personnel'||!state.leader||id===1||id===6||id===8)return;state.members.add(id);render();toast('已添加到管理名单');}
    else if(a==='remove'){const id=Number(b.dataset.id);modal('移除成员？',`${teacher(id).name} 将恢复为未分配状态，可重新加入其他小组。`,()=>{state.members.delete(id);render();toast('已移除，老师可重新分配');});}
    else if(a==='view'){state.view=b.dataset.view;state.ops=false;state.memberPage=1;render();}
    else if(a==='profile'){state.selected=Number(b.dataset.id);state.memberTab='home';state.view='profile';render();}
    else if(a==='member-tab'){state.memberTab=b.dataset.memberTab;render();}
    else if(a==='back'){if(state.scene==='leader')state.view=state.view==='profile'?'members':state.view==='operations'?'home':'operations';else toast('此处返回老师管理列表');render();}
    else if(a==='nav'){if(state.scene==='leader'&&b.dataset.name==='小组运营'){state.view='operations';render();}else if(state.scene==='leader'&&b.dataset.name==='总览'){state.view='home';render();}else toast('原老师功能沿用现有页面；此样板演示新增小组页面');}
    else if(a==='own-range'||a==='own-type'){const row=b.parentElement;row.querySelectorAll('button').forEach(button=>button.classList.toggle('current',button===b));toast('本人业务仍按原老师范围展示，此处仅为排版示例');}
    else if(a==='hq-work'){state.tab='work';render();}
    else if(a==='punch'){state.punch=b.dataset.punch;render();}
    else if(a==='date'){state.year=$('#year').value;state.month=$('#month').value;render();toast('已更新所选年月');}
    else if(a==='tracking-date'){const y=$('#trackingYear').value,m=$('#trackingMonth').value,d=$('#trackingDay').value,date=`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;if(date>'2026-11-06')return toast('不能查询未来日期');if(Number(d)>new Date(Number(y),Number(m),0).getDate())return toast('请选择有效日期');state.year=y;state.month=m;state.day=d;state.date=date;state.trackingPages={};render();}
    else if(a==='tracking-page'){state.trackingPages[b.dataset.key]=Number(b.dataset.page);render();}
    else if(a==='tracking-jump'){const page=Number($('#trackingJump-'+b.dataset.key).value);if(!Number.isInteger(page)||page<1||page>Number(b.dataset.pages))return toast('请输入有效页码');state.trackingPages[b.dataset.key]=page;render();}
    else if(a==='punch-detail')openPunch(Number(b.dataset.id),b.dataset.kind);
    else if(a==='close-punch')$('#attendanceModal').hidden=true;
    else if(a==='password'){const input=$('#password');input.type=input.type==='password'?'text':'password';b.textContent=input.type==='password'?'显示':'隐藏';}
    else if(a==='page'){state[b.dataset.kind+'Page']+=Number(b.dataset.step);render();}
    else if(a==='jump'){const page=Number($('#jump-'+b.dataset.kind).value);if(!Number.isInteger(page)||page<1||page>Number(b.dataset.pages))return toast('请输入有效页码');state[b.dataset.kind+'Page']=page;render();}
    else if(a==='close-modal')closeModal();
    else if(a==='own')toast('普通老师仅保留本人业务与客户');
    else if(a==='demo')toast('此操作为外观样例，不修改真实资料');
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();$('#attendanceModal').hidden=true;}});
  render();
})();
