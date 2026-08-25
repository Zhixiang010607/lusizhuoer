"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");
const dashboard = require(path.join(mini, "services", "home-dashboard.js"));

test("HQ home exposes the complete web mobile rail and isolated ranking interactions", () => {
  const js = read("pages", "home", "index.js");
  const wxml = read("pages", "home", "index.wxml");
  const wxss = read("pages", "home", "index.wxss");

  for (const label of ["客户查询", "充值查询", "核销查询", "产品管理", "门店管理", "老师管理", "充值审核", "核销审核"]) {
    assert.match(wxml, new RegExp(label), `HQ mobile rail is missing ${label}`);
  }
  for (const route of ["pages/product-management/index", "pages/hq-directory/index", "pages/reviews/index"]) assert.match(js, new RegExp(route));
  assert.match(wxml, /class="rail-current" aria-label="\{\{roleTitle\}\}"/);
  assert.match(js, /hq:\s*\{\s*title:\s*"总部数据看板"/);
  assert.match(wxml, /aria-label="业务查询"/);
  assert.match(wxml, /aria-label="管理"/);
  assert.match(wxml, /aria-label="审核"/);
  assert.match(wxml, /aria-label="退出登录"/);
  assert.match(js, /async loadHqRanking\(pageNumber = 1\)/);
  assert.match(js, /chooseHqDimension[\s\S]*this\.loadHqRanking\(1\)/);
  assert.match(js, /previousHqPage[\s\S]*loadHqRanking/);
  assert.match(js, /nextHqPage[\s\S]*loadHqRanking/);
  assert.match(js, /jumpHqPage\(\)/);
  assert.match(js, /retryHqRanking\(\)/);
  assert.match(js, /async exportHqRanking\(\)/);
  assert.match(js, /RANKING_EXPORT_MAX_ROWS = 10000/);
  assert.match(js, /hqScopeDetailText/);
  assert.doesNotMatch(wxml, /\{\{hqScopeText\}\}/, "the filter card must not repeat an already visible scope sentence");
  assert.match(wxml, /class="hq-filter-actions"><button bindtap="resetHqRange">重置筛选<\/button><\/view>/);
  assert.match(wxml, /导出当前数据/);
  assert.match(wxml, /跳至/);
  assert.match(wxml, /class="menu-backdrop" bindtap="closeMenus"/);
  assert.match(wxml, /class="business-popover[^\"]*" catchtap="noop"/);
  assert.match(wxss, /\.business-popover\s*\{[^}]*position:\s*fixed;[^}]*top:\s*90rpx;[^}]*max-width:\s*560rpx;/s);
  assert.match(wxss, /\.popover-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(wxss, /\.popover-grid\s*\{[^}]*repeat\(2,/s);
  assert.match(wxss, /\.table-pagination button\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*font-size:\s*18rpx;[^}]*line-height:\s*1;/s);
  assert.match(wxss, /\.hq-ranking-pagination\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto;/s);
  assert.match(wxss, /\.metric-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(wxss, /\.bar-y-axis/);
  assert.match(wxss, /\.bar-grid-line/);
});

test("HQ chart mapper produces the same dynamic signed axis used by the web chart", () => {
  const chart = dashboard.hqChart([
    { entityId: "1", entityName: "中心店", recharge: 12, verification: 7, experience: 2, refund: -3 },
    { entityId: "2", entityName: "分店", recharge: 4, verification: 1, experience: 0, refund: 0 }
  ], "store");
  assert.equal(chart.rows.length, 2);
  assert.ok(chart.axis.min < 0);
  assert.ok(chart.axis.max >= 12);
  assert.ok(chart.axis.ticks.some((tick) => tick.zero && tick.value === 0));
  assert.deepEqual(chart.rows[0].bars.map((bar) => bar.metric), ["recharge", "verification", "experience", "refund"]);
  assert.equal(chart.rows[0].bars[3].valueClass, "negative");
});

test("HQ store and teacher workspaces reuse authoritative services without a generic detail modal", () => {
  const directoryJs = read("pages", "hq-directory", "index.js");
  const directoryWxml = read("pages", "hq-directory", "index.wxml");
  const storeCreate = read("pages", "store-create", "index.js");
  const teacherCreate = read("pages", "teacher-create", "index.js");
  const storeDetail = read("pages", "store-detail", "index.js");
  const teacherDetail = read("pages", "teacher-detail", "index.js");
  const teacherDetailWxml = read("pages", "teacher-detail", "index.wxml");
  const api = read("services", "api.js");
  const env = read("config", "env.js");

  for (const action of ["listStores", "listStaff", "setMasterStatus", "setStaffStatus"]) assert.match(directoryJs, new RegExp(action));
  assert.match(storeCreate, /createStoreWithAccount/);
  assert.match(teacherCreate, /callTeacherCreate/);
  assert.match(api, /config\.teacherCreateFunction/);
  assert.match(env, /teacherCreateFunction:\s*"teacherCreate"/);
  assert.match(teacherCreate, /result && result\.ok === true && result\.completed === true && proof\.complete === true/);
  assert.match(directoryJs, /await this\.load\(\)[\s\S]*current\.archived !== \(next === "ARCHIVED"\)/,
    "status changes must be confirmed by a fresh database read");
  for (const label of ["查询结果", "活跃", "封存", "新增", "进入主页", "配置／充值"]) assert.match(directoryWxml, new RegExp(label));
  assert.equal((directoryWxml.match(/class="table-row table-head store"/g) || []).length, 3,
    "all store table headers must use the same horizontal column grid as store data rows");
  assert.equal((directoryWxml.match(/class="table-row table-head teacher"/g) || []).length, 3,
    "all teacher table headers must use the same horizontal column grid as teacher data rows");
  assert.doesNotMatch(directoryWxml, /class="modal|detail-mask/, "directory must route to dedicated pages instead of opening a generic detail modal");
  for (const action of ["getStoreDashboard", "getStoreBusinessAnalytics", "queryStoreBusinessRecords", "setMasterStatus"]) assert.match(storeDetail, new RegExp(action));
  assert.match(storeDetail, /storeId[\s\S]*queryStoreBusinessRecords/);
  for (const action of ["getTeacherExperienceEntitlements", "upsertTeacherExperienceEntitlement", "rechargeTeacherExperienceEntitlement", "deleteTeacherExperienceEntitlement", "resetPassword", "setStaffStatus"]) assert.match(teacherDetail, new RegExp(action));
  for (const label of ["老师账号管理", "保存新临时密码", "体验项目额度", "项目体验汇总", "已配置产品", "配置新产品", "单独充值体验次数", "额度变更记录"]) assert.match(teacherDetailWxml, new RegExp(label));
});

test("HQ review workbenches match web filters, pagination, exact links, and guarded decisions", () => {
  const js = read("pages", "reviews", "index.js");
  const wxml = read("pages", "reviews", "index.wxml");

  assert.match(js, /const PAGE_SIZE = 100/);
  assert.match(js, /callStaff\("listReviewOrders"/);
  assert.match(js, /paged:\s*this\.data\.mode === "filters"/);
  assert.match(js, /pageNumber:\s*this\.data\.mode === "filters" \? page/);
  assert.match(js, /this\.data\.type === "recharge" \? "NEW" : this\.data\.type === "refund" \? "REFUND" : "SUPPLEMENT"/);
  assert.match(js, /callStaff\("reviewOrder"/);
  assert.match(js, /decision:\s*this\.data\.decision/);
  assert.match(js, /note:\s*text\(this\.data\.reviewNote\)/);
  assert.match(js, /pages\/order-detail\/index/);
  assert.match(js, /pages\/customer-detail\/index/);
  for (const label of ["充值审核", "退费审核", "按条件查询", "按工单编号", "门店范围", "审核状态", "工单类型", "上一页", "下一页", "跳至", "通过", "驳回", "审核留言（可选）"]) {
    assert.match(wxml, new RegExp(label), `HQ review UI is missing ${label}`);
  }
});

test("mini internal palette is isolated warm ivory, champagne gold, and espresso", () => {
  const app = read("app.wxss");
  const appJson = JSON.parse(read("app.json"));
  const context = fs.readFileSync(path.join(root, "PROJECT_CONTEXT.md"), "utf8");
  for (const color of ["#f3ede2", "#fffaf3", "#6f532e", "#a98243", "#302a22"]) assert.match(app, new RegExp(color, "i"));
  assert.equal(appJson.window.navigationBarBackgroundColor, "#2f2921");
  assert.ok(appJson.pages.includes("pages/hq-directory/index"));
  assert.ok(appJson.pages.includes("pages/product-management/index"));
  assert.ok(appJson.pages.includes("pages/product-create/index"));
  assert.ok(appJson.pages.includes("pages/product-detail/index"));
  for (const route of ["pages/store-create/index", "pages/store-detail/index", "pages/teacher-create/index", "pages/teacher-detail/index"]) assert.ok(appJson.pages.includes(route));
  assert.ok(appJson.pages.includes("pages/reviews/index"));
  assert.match(context, /不得恢复旧版高饱和蓝色工作台主题/);
  assert.match(context, /只修改小程序 WXML／WXSS，不反向覆盖网页版客户端样式/);
});
