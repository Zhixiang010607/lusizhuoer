"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=p=>fs.readFileSync(require('node:path').join(__dirname,'..',p),'utf8');
test('Web ranking puts project range before ranking object without changing filter values',()=>{
  const src=read('app.js');
  const block=src.slice(src.indexOf('  function rankingControlsMarkup('),src.indexOf('  function renderAnalysis('));
  const render=new Function('state','escapeHtml','dimensionLabels','rankingMetricLabels',block+';return rankingControlsMarkup("teacher")');
  const markup=render({rankingProducts:[],rankingProductId:'',rankingMetric:'recharge'},s=>s,{store:'门店',teacher:'老师'},{recharge:'充值',verification:'核销',experience:'体验',refund:'退费'});
  assert.ok(markup.indexOf('项目范围')<markup.indexOf('排名对象'));
  for(const attr of ['data-dashboard-dimension="teacher"','data-dashboard-metric="recharge"','id="dashboardRankingProduct"'])assert.ok(markup.includes(attr));
});
test('all Web dropdowns reserve space for an inset arrow while native selection remains intact',()=>{
  const css=read('web-tablet-parity.css');
  assert.match(css,/select:not\(\[multiple\]\):not\(\[size\]\)[\s\S]{0,900}padding-inline: 14px 42px !important/);
  assert.match(css,/background-position: right 14px center !important/);
  assert.match(css,/body\.login-page \.password-field button[\s\S]{0,800}justify-content: center !important/);
});
test('Web attendance expands complete photos and opens only the requested punch',()=>{
  assert.match(read('attendance-photo.css'),/attendance-evidence-image \{[^}]*height: auto;[^}]*object-fit: contain/);
  assert.doesNotMatch(read('attendance-photo.css'),/height: 200px/);
  assert.match(read('attendance-tracking.js'),/innerHTML = kind === "clockOut" \? punch\("下班打卡", teacher.clockOut, teacher\) : punch\("上班打卡", teacher.clockIn, teacher\)/);
  assert.match(read('web-attendance.css'),/punch-record-layout[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
});
test('staff temporary password is an inline protected form, not a browser prompt',()=>{
  const js=read('staff-detail.js'),html=read('staff-detail.html');
  assert.doesNotMatch(js,/window\.prompt/);
  assert.match(html,/id="staffNewPassword" type="password" autocomplete="new-password"/);
  assert.match(js,/if \(passwordSaving\) return/);
  assert.match(js,/CloudBasePhoneAuth.resetStaffPassword\(\{ uid: staff.auth_uid, newPassword \}\)/);
  assert.match(js,/const newPassword = \$\("staffNewPassword"\).value/);
  assert.match(js,/closePasswordForm\(\);[\s\S]{0,100}临时密码已保存/);
  assert.match(js,/window.confirm\(`确认\$\{text\}/); // Archive still requires explicit confirmation.
});
test('public company navigation changes presentation only and handles hashes/back',()=>{
  const ids=['overview','about','values','services','partners','projects','login'];
  const sections=ids.map(id=>({dataset:{companySection:id},hidden:false}));
  const links=ids.map(id=>({dataset:{companyNav:id},attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}}));
  const location={hash:'',search:''},document={title:'',querySelectorAll:s=>s.includes('section')?sections:links};let handler;
  vm.runInNewContext(read('company-portal.js'),{location,document,URLSearchParams,window:{addEventListener:(name,f)=>{assert.equal(name,'hashchange');handler=f;}}});
  assert.deepEqual(sections.filter(s=>!s.hidden).map(s=>s.dataset.companySection),['overview']);
  for(const id of [...ids,'unknown']){location.hash='#'+id;handler();assert.deepEqual(sections.filter(s=>!s.hidden).map(s=>s.dataset.companySection),[ids.includes(id)?id:'overview']);}
  location.hash='';location.search='?reason=登录';handler();assert.equal(sections[6].hidden,false);
  location.search='?mode=reset';handler();assert.equal(sections[6].hidden,false);
  const html=read('login.html');for(const id of ids)assert.ok(html.includes(`data-company-nav="${id}"`));
  assert.match(html,/10000\+/);assert.match(html,/300000\+/);
  assert.doesNotMatch(read('company-portal.js'),/CloudBase|fetch\(|localStorage|sessionStorage/);
});

test('each public project has complete whitelisted chapters, real navigation and no business SDK',()=>{
  for (const [key,name] of [['ocean','海洋之蕴'],['skin','魔法柔肤'],['warmth','露思康辰']]) {
    let html='',title='',active=false;
    const tabs=Array.from({length:3},()=>({attrs:{},events:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this.events[k]=v;},focus(){this.focused=true;}}));
    const panels=Array.from({length:3},()=>({hidden:false}));
    vm.runInNewContext(read('public-project.js'),{URLSearchParams,location:{search:'?project='+key},document:{set title(v){title=v;},querySelectorAll:s=>s==='[data-chapter]'?tabs:panels,querySelector:()=>({setAttribute(){active=true;}}),getElementById:()=>({set innerHTML(v){html=v;}})}});
    assert.ok(title.includes(name));assert.equal(active,true);assert.equal((html.match(/class="public-project-chapter"/g)||[]).length,3);
    assert.ok(html.includes('返回公司主页'));assert.ok(html.includes('下一个项目'));assert.ok(html.includes('aria-controls="chapter-3"'));
    assert.deepEqual(panels.map(p=>p.hidden),[false,true,true]);
    for(let i=0;i<3;i++){tabs[i].events.click();assert.deepEqual(panels.map(p=>p.hidden),panels.map((_,j)=>j!==i));assert.equal(tabs[i].attrs['aria-selected'],'true');}
    tabs[2].events.keydown({key:'ArrowRight',preventDefault(){}});assert.equal(panels[0].hidden,false);assert.equal(tabs[0].focused,true);
    for(const m of html.matchAll(/src="([^"]+)"/g))assert.ok(fs.existsSync(require('node:path').join(__dirname,'..',m[1])));
  }
});
