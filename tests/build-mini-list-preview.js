"use strict";
// Generate a cloud-free simulator project from the exact production UI.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "miniprogram-app/miniprogram");
const target = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), "lusizhuoer-list-ui-"));
if (process.argv[2] && (!target.startsWith(os.tmpdir()) || !path.basename(target).startsWith("lusizhuoer-list-ui-") || !fs.existsSync(path.join(target, "source-ui-manifest.json")))) throw new Error("Not an existing isolated preview project");
const pages = ["home", "customers", "records", "reviews", "teacher-customers", "store-detail", "hq-directory", "rating-analysis"];
const dashboard = require(path.join(source, "services/home-dashboard"));
const query = require(path.join(source, "services/query-tools"));
const customerAge = require(path.join(source, "services/customer-age"));
const manifest = [];
fs.copyFileSync(path.join(source, "app.wxss"), path.join(target, "app.wxss"));
fs.cpSync(path.join(source, "styles"), path.join(target, "styles"), { recursive: true });
fs.mkdirSync(path.join(target, "components"), { recursive: true });
fs.cpSync(path.join(source, "components/project-summary"), path.join(target, "components/project-summary"), { recursive: true });
const appid = JSON.parse(fs.readFileSync(path.join(root, "miniprogram-app/project.config.json"), "utf8")).appid;
if (appid !== "wxb053c1bd6c684d8b") throw new Error("Unexpected project identity");
fs.writeFileSync(path.join(target, "project.config.json"), JSON.stringify({ appid, projectname: "Lusizhuoer isolated list QA", compileType: "miniprogram", setting: { es6: true, enhance: true }, libVersion: "3.17.1" }, null, 2));
fs.writeFileSync(path.join(target, "app.json"), JSON.stringify({ pages: ["pages/launcher/index", ...pages.map(p => `pages/${p}/index`)], window: { navigationBarTitleText: "隔离排版验收", navigationBarBackgroundColor: "#302a22", navigationBarTextStyle: "white" }, style: "v2" }, null, 2));
fs.writeFileSync(path.join(target, "app.js"), "App({});\n");
fs.mkdirSync(path.join(target, "pages/launcher"), { recursive: true });
const links = [["总部客户查询", "customers", "hq"], ["门店客户查询", "customers", "store"], ["核销查询", "records", "hq"], ["充值查询", "records", "store"], ["审核", "reviews", "hq"], ["门店主页", "home", "store"], ["老师主页", "home", "teacher"], ["总部主页", "home", "hq"], ["老师客户", "teacher-customers", "teacher"], ["门店详情", "store-detail", "hq"], ["管理目录", "hq-directory", "hq"], ["评价分析", "rating-analysis", "hq"]];
fs.writeFileSync(path.join(target, "pages/launcher/index.json"), "{}");
fs.writeFileSync(path.join(target, "pages/launcher/index.wxml"), '<view class="page"><view class="card"><text>隔离 UI 样例，不连接云端</text>' + links.map(([label, page, role]) => `<button data-url="/pages/${page}/index?role=${role}" bindtap="open">${label}</button>`).join("") + '</view></view>');
fs.writeFileSync(path.join(target, "pages/launcher/index.wxss"), "button {margin:12rpx 0;}");
fs.writeFileSync(path.join(target, "pages/launcher/index.js"), "Page({open(e){wx.navigateTo({url:e.currentTarget.dataset.url})}});");
for (const page of pages) {
  const directory = path.join(target, "pages", page); fs.mkdirSync(directory, { recursive: true });
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(source, `pages/${page}/index.js`), "utf8"), {
    Page(value) { definition = value; },
    wx: { getWindowInfo: () => ({ windowWidth: 390, windowHeight: 844 }) },
    require(id) {
      if (id.endsWith("/home-dashboard")) return dashboard;
      if (id.endsWith("/query-tools")) return query;
      if (id.endsWith("/customer-age")) return customerAge;
      if (id.endsWith("/session")) return {};
      return {};
    }
  }, { filename: page });
  for (const ext of ["wxml", "wxss", "json"]) {
    const from = path.join(source, `pages/${page}/index.${ext}`);
    fs.copyFileSync(from, path.join(directory, `index.${ext}`));
    manifest.push({ file: `pages/${page}/index.${ext}`, sha256: crypto.createHash("sha256").update(fs.readFileSync(from)).digest("hex") });
  }
  const bindings = [...fs.readFileSync(path.join(directory, "index.wxml"), "utf8").matchAll(/(?:bind\w*|catch\w*)="(\w+)"/g)].map(m => m[1]);
  const runtime = `
const originalData=${JSON.stringify(definition.data)};
const definition={data:originalData,onLoad(options){this._role=options.role||'hq';this._page=1;this.render();},render(){
const p=this._page;const n=p===3?1:10;const customers=Array.from({length:n},(_,i)=>({customerCode:'QA-'+((p-1)*10+i+1),customerName:'样例客户'+((p-1)*10+i+1),storeName:'样例门店',ageLabel:'36 岁',birthDate:'1990-01-01',rechargeCount:20,verificationCount:2,createdAtLabel:'2026-10-31',statusLabel:'活跃',processLabel:'已充值并已有消费'}));
const records=Array.from({length:n},(_,i)=>({id:'QA-'+i,recordCode:'VE20261031000'+String((p-1)*10+i+1).padStart(2,'0'),customerCode:'QA-'+i,customerName:'样例客户'+(i+1),birthDate:'1990-01-01',ageLabel:'36 岁',storeName:'样例门店',productName:'魔法柔肤',unitCount:1,submittedAt:'2026-10-31 12:34:56',teacherName:'样例老师',typeLabel:'正常核销',statusLabel:'已完成',status:'PENDING',impact:'1 次',reviewedAt:'—'}));
const pg={page:p,total:21,pageSize:10,totalPages:3,previousDisabled:p===1,nextDisabled:p===3,pageInput:String(p)};
const group={...pg,rows:customers,viewportHeight:64+n*72,tabletVisibleRows:n,scrollable:false};
this.setData({session:{role:this._role,staffName:'隔离样例'},authorized:true,loading:false,error:false,message:'',roleTitle:'隔离排版样例',roleSubtitle:'不连接云端',rangeLabel:'今天',profileFacts:[],storeId:'QA',storeHero:{name:'样例门店'},profile:{},total:21,totalPages:3,page:p,pageJump:String(p),pageInput:String(p),customers,records,orders:records,searched:true,rows:records,group,counts:{ACTIVE:21,ARCHIVED:21},activeCustomers:group,archivedCustomers:group,businessRecords:records,businessType:'VERIFICATION',businessPage:pg,businessPageInput:String(p),businessViewportHeight:64+n*72,businessTabletVisibleRows:n,businessScrollable:false,businessLoading:false,recordType:'VERIFICATION',noun:'核销',type:'verification',mode:${JSON.stringify(page === 'reviews' ? 'filters' : 'browse')},activeRows:customers,archivedRows:customers,searchRows:customers,activePageRows:customers,archivedPageRows:customers,searchPageRows:customers,activePage:p,archivedPage:p,searchPage:p,activePages:3,archivedPages:3,searchPages:3,activePageInput:String(p),archivedPageInput:String(p),searchPageInput:String(p),hqRanking:customers.map((c,i)=>({entityId:c.customerCode,rank:(p-1)*10+i+1,name:c.customerName,recharge:20,verification:2,experience:1,refund:0})),hqRankingPage:pg,hqRankingInput:String(p),hqRankingVisibleRows:n,hqRankingViewportHeight:64+n*72,hqRankingScrollable:false,hqRankingLoading:false,hqRankingError:'',hqProjectSummaryLoading:false,hqProjectSummaryError:'',hqProjectSummaryRows:[],hqProjectSummaryPage:pg,summaryRows:[],totals:{recharge:20,verification:2,experience:1,refund:0},businessTabs:[{type:'VERIFICATION',label:'核销',total:21,active:true},{type:'RECHARGE',label:'充值',total:21},{type:'EXPERIENCE',label:'体验',total:21},{type:'REFUND',label:'退费',total:21}]});
},prev(){if(this._page>1){this._page--;this.render();}},next(){if(this._page<3){this._page++;this.render();}},input(e){this._jump=e.detail.value;},jump(){const n=Number(this._jump);if(Number.isInteger(n)&&n>=1&&n<=3){this._page=n;this.render();}}};
const handlers=${JSON.stringify(bindings)};for(const name of handlers)definition[name]=function(e){if(/previous|previousCustomer/.test(name))this.prev();else if(/next/.test(name))this.next();else if(/^input.*Page/.test(name)||name==='inputPageJump')this.input(e);else if(/^jump/.test(name))this.jump();else if(name==='customerPage'||name==='businessPage'||name==='directoryPage'){const d=Number(e.currentTarget.dataset.direction);if(d<0)this.prev();else if(d>0)this.next();else this.jump();}};Page(definition);`;
  fs.writeFileSync(path.join(directory, "index.js"), runtime);
}
fs.writeFileSync(path.join(target, "source-ui-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ project: target, routes: pages.length + 1, byteIdenticalUiFiles: manifest.length, mode: "local UI only, no cloud SDK or authentication" }));
