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
  const webIndex = fs.readFileSync(path.join(root, "index.html"), "utf8");

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
  assert.match(js, /const DIMENSIONS = Object\.freeze\(\[\s*\{ value: "store", label: "门店" \},\s*\{ value: "teacher", label: "老师" \}\s*\]\)/,
    "project is a selectable scope, not a ranking object");
  assert.match(js, /const RANKING_METRICS = Object\.freeze/);
  assert.match(js, /chooseHqRankingMetric[\s\S]*loadHqRanking\(1\)/);
  assert.match(js, /chooseHqProduct[\s\S]*loadHqRanking\(1\)/);
  assert.match(js, /mode: "ranking", dimension, rankingMetric, productId/,
    "mini ranking requests must carry object, project, and business selections");
  assert.match(js, /previousHqPage[\s\S]*loadHqRanking/);
  assert.match(js, /nextHqPage[\s\S]*loadHqRanking/);
  assert.match(js, /jumpHqPage\(\)/);
  assert.match(js, /retryHqRanking\(\)/);
  assert.match(js, /async exportHqRanking\(\)/);
  assert.match(js, /REPORT_EXPORT_MAX_ROWS = 10000/);
  assert.match(js, /hqReport\.createReportPdf\(\{[\s\S]*productRows,[\s\S]*rankingRows,/,
    "mini vector PDF must include all project summary rows and the complete ranking");
  assert.match(js, /getFileSystemManager\(\)\.writeFile/);
  assert.match(js, /openPdfDocument\(filePath\)/);
  assert.doesNotMatch(js, /wx\.setClipboardData\(\{\s*data/,
    "retired CSV clipboard export must not return");
  assert.doesNotMatch(js, /shareFileMessage/,
    "ranking export must not call a TAP-only API after asynchronously fetching all pages");
  assert.doesNotMatch(js, /hqScopeDetailText|hqDetailOpen/,
    "the redesigned HQ home must not keep the retired statistics-range dialog state");
  assert.doesNotMatch(wxml, /\{\{hqScopeText\}\}/, "the filter card must not repeat an already visible scope sentence");
  assert.match(wxml, /class="hq-filter-actions"><button bindtap="resetHqRange">重置筛选<\/button><\/view>/);
  assert.match(wxml, /排名对象/);
  assert.match(wxml, /排序指标/);
  assert.match(wxml, /项目范围/);
  const hqFilterCard = wxml.slice(wxml.indexOf('<view class="web-panel hq-filters">'), wxml.indexOf('<view class="web-panel hq-project-summary-panel">'));
  assert.ok(hqFilterCard.indexOf("时间周期") < hqFilterCard.indexOf("排名对象")
    && hqFilterCard.indexOf("排名对象") < hqFilterCard.indexOf("项目范围")
    && hqFilterCard.indexOf("项目范围") < hqFilterCard.indexOf("排序指标"),
  "time, ranking object, project scope, and sorting metric must stay together in their exact query order");
  assert.match(js, /hqPeriod:\s*"TODAY", hqPeriodIndex:\s*0/,
    "HQ first entry must default to today");
  assert.match(js, /resetHqRange\(\)[\s\S]*hqPeriod:\s*"TODAY"[\s\S]*hqDimension:\s*"store"[\s\S]*hqProductId:\s*""[\s\S]*hqRankingMetric:\s*"recharge"/,
    "HQ reset must restore today, store, all products, and recharge");
  assert.equal(dashboard.HQ_PERIOD_OPTIONS[0].value, "TODAY");
  assert.deepEqual(dashboard.hqRange("TODAY"), { startDate: dashboard.today(), endDate: dashboard.today() });
  assert.match(wxml, /class="hq-dimension-tabs"/);
  assert.match(wxml, /class="hq-ranking-list"/);
  assert.match(wxml, /项目汇总/);
  assert.match(wxml, /当前时间范围内的全部项目/);
  for (const label of ["项目", "充值", "核销", "体验", "退费", "合计"]) assert.match(wxml, new RegExp(label));
  assert.match(wxml, /previousHqProductSummaryPage/);
  assert.match(wxml, /nextHqProductSummaryPage/);
  assert.match(js, /mode:\s*"product-summary", pageNumber:\s*1, pageSize:\s*PRODUCT_SUMMARY_PAGE_SIZE/,
    "mini HQ must read a dedicated all-project summary instead of reusing Top 10 rows");
  assert.match(js, /async loadHqProjectSummary\(pageNumber\)/);
  assert.doesNotMatch(wxml, /class="metric-grid"|hq-analysis-card|分类统计|前 10 名/,
    "the retired six metrics and duplicate Top 10 classification card must stay off the HQ home");
  assert.doesNotMatch(webIndex, /class="metric-grid"|id="analysisGrid"|分类统计|前 10 名/,
    "web and mini HQ home must retire the same duplicate summary sections");
  assert.match(wxml, /导出完整报表 PDF/);
  assert.match(wxml, /跳至/);
  assert.match(wxml, /class="menu-backdrop" bindtap="closeMenus"/);
  assert.match(wxml, /class="business-popover[^\"]*" catchtap="noop"/);
  assert.match(wxss, /\.business-popover\s*\{[^}]*position:\s*fixed;[^}]*top:\s*90rpx;[^}]*max-width:\s*560rpx;/s);
  assert.match(wxss, /\.popover-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(wxss, /\.popover-grid\s*\{[^}]*repeat\(2,/s);
  assert.match(wxss, /\.table-pagination button\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*font-size:\s*18rpx;[^}]*line-height:\s*1;/s);
  assert.match(wxss, /\.hq-ranking-pagination\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto;/s);
  assert.match(wxss, /\.hq-dimension-tabs button\s*\{[^}]*width:\s*100%\s*!important;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden/s,
    "four metric controls must remain centered and contained on narrow screens");
  assert.match(wxss, /\.hq-ranking-card/);
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
  const directoryWxss = read("pages", "hq-directory", "index.wxss");
  const storeCreate = read("pages", "store-create", "index.js");
  const teacherCreate = read("pages", "teacher-create", "index.js");
  const storeDetail = read("pages", "store-detail", "index.js");
  const teacherDetail = read("pages", "teacher-detail", "index.js");
  const teacherDetailWxml = read("pages", "teacher-detail", "index.wxml");
  const api = read("services", "api.js");
  const env = read("config", "env.js");

  for (const action of ["listStores", "listStaff"]) assert.match(directoryJs, new RegExp(action));
  for (const retiredDirectoryMutation of ["setMasterStatus", "setStaffStatus"]) {
    assert.doesNotMatch(directoryJs, new RegExp(retiredDirectoryMutation),
      "directory rows are read-only; status mutations belong on the dedicated detail pages");
  }
  assert.match(storeCreate, /createStoreWithAccount/);
  assert.match(teacherCreate, /callTeacherCreate/);
  assert.match(api, /config\.teacherCreateFunction/);
  assert.match(env, /teacherCreateFunction:\s*"teacherCreate"/);
  assert.match(teacherCreate, /result && result\.ok === true && result\.completed === true && proof\.complete === true/);
  for (const label of ["查询结果", "活跃", "封存", "新增"]) assert.match(directoryWxml, new RegExp(label));
  assert.doesNotMatch(directoryWxml, /<text>查看<\/text>|进入主页/);
  for (const label of ["老师姓名", "老师编号", "联系电话", "状态"]) assert.match(directoryWxml, new RegExp(label));
  for (const removed of ["体验额度", "账号操作", "配置／充值"]) assert.doesNotMatch(directoryWxml, new RegExp(removed));
  assert.equal((directoryWxml.match(/class="table-row table-head store"/g) || []).length, 3,
    "all store table headers must use the same horizontal column grid as store data rows");
  assert.equal((directoryWxml.match(/class="table-row table-head teacher"/g) || []).length, 3,
    "all teacher table headers must use the same horizontal column grid as teacher data rows");
  assert.match(directoryWxml, /class="table-row teacher">\s*<text class="link"[^>]*bindtap="openDetail">\{\{item\.name\}\}<\/text><text>\{\{item\.code\}\}<\/text><text>\{\{item\.phone\}\}<\/text><text><text class="status/);
  assert.equal((directoryWxml.match(/class="table-section(?: archived-section)? \{\{type\}\}"/g) || []).length, 3,
    "all three directory cards receive the role-specific gutter rule");
  assert.match(directoryWxss, /\.table-section\.teacher\s*\{\s*padding-right:\s*24rpx;\s*\}/,
    "teacher tables keep the same inner gutter on both sides");
  assert.match(directoryWxss, /\.data-table\.teacher\s*\{\s*width:\s*100%;\s*min-width:\s*100%;\s*\}/,
    "the four teacher columns expand to the full available card width");
  assert.match(directoryWxss, /\.table-row\.teacher\s*\{\s*grid-template-columns:\s*minmax\(0, 1\.05fr\) minmax\(0, 0\.9fr\) minmax\(0, 1\.25fr\) minmax\(0, 0\.8fr\);\s*\}/,
    "teacher columns distribute the available width without a trailing blank strip");
  assert.match(directoryWxss, /\.data-table\.store\s*\{\s*width:\s*910rpx;\s*min-width:\s*910rpx;\s*\}/,
    "the five-column store directory keeps its contained horizontal scroll width");
  assert.match(directoryWxss, /\.table-row\.store\s*\{\s*grid-template-columns:\s*180rpx 140rpx 180rpx 300rpx 110rpx;\s*\}/,
    "the store directory width remains equal to its five declared columns");
  assert.equal(180 + 140 + 180 + 300 + 110, 910);
  assert.doesNotMatch(directoryWxml, /class="modal|detail-mask/, "directory must route to dedicated pages instead of opening a generic detail modal");
  for (const action of ["getStoreDashboard", "getStoreBusinessAnalytics", "queryStoreBusinessRecords", "setMasterStatus"]) assert.match(storeDetail, new RegExp(action));
  assert.match(storeDetail, /storeId[\s\S]*queryStoreBusinessRecords/);
  for (const action of ["getTeacherExperienceEntitlements", "upsertTeacherExperienceEntitlement", "rechargeTeacherExperienceEntitlement", "deleteTeacherExperienceEntitlement", "resetPassword", "setStaffStatus"]) assert.match(teacherDetail, new RegExp(action));
  assert.match(teacherDetail, /const refreshed = await this\.refreshStaff\(\);[\s\S]*archived\(refreshed\) !== \(next === "ARCHIVED"\)/,
    "teacher status changes must be confirmed by a fresh database read on the dedicated detail page");
  for (const label of ["老师账号管理", "保存新临时密码", "体验项目额度", "项目体验汇总", "已配置产品", "配置新产品", "单独充值体验次数", "额度变更记录"]) assert.match(teacherDetailWxml, new RegExp(label));

  for (const page of ["hq-directory", "store-create", "store-detail", "teacher-create", "teacher-detail"]) {
    const pageJson = JSON.parse(read("pages", page, "index.json"));
    const pageWxml = read("pages", page, "index.wxml");
    assert.equal(pageJson.usingComponents && pageJson.usingComponents["hq-rail"], undefined,
      `${page} must not register the repeated HQ rail inside management`);
    assert.doesNotMatch(pageWxml, /<hq-rail\b/, `${page} must rely on native back navigation`);
  }
});

test("HQ review workbenches match web filters, pagination, exact links, and guarded decisions", () => {
  const js = read("pages", "reviews", "index.js");
  const wxml = read("pages", "reviews", "index.wxml");
  const wxss = read("pages", "reviews", "index.wxss");

  assert.match(js, /const PAGE_SIZE = 100/);
  assert.match(js, /callStaff\("listReviewOrders"/);
  assert.match(js, /const mode = this\.data\.mode;/);
  assert.match(js, /paged:\s*mode === "filters"/);
  assert.match(js, /pageNumber:\s*mode === "filters" \? page/);
  assert.match(js, /if \(epoch !== this\._requestEpoch\) return;/,
    "review filters must reject a stale response after the user changes scope");
  assert.match(js, /type === "recharge" \? "NEW" : type === "refund" \? "REFUND" : "SUPPLEMENT"/,
    "review requests must derive the application type from the immutable request snapshot");
  assert.match(js, /callStaff\("reviewOrder"/);
  assert.match(js, /decision:\s*this\.data\.decision/);
  assert.match(js, /note:\s*text\(this\.data\.reviewNote\)/);
  assert.match(js, /pages\/order-detail\/index/);
  assert.match(js, /const category = recharge[\s\S]*isRefund \? "REFUND" : isVoid \? "VOID" : "RECHARGE"[\s\S]*: "SUPPLEMENT"/,
    "review rows preserve the exact category required by the shared detail page");
  assert.match(js, /category=\$\{encodeURIComponent\(row\.category\)\}/,
    "review detail links carry the exact server-derived category");
  assert.match(js, /pages\/customer-detail\/index/);
  for (const label of ["充值审核", "退费审核", "按条件查询", "按工单编号", "门店范围", "审核状态", "工单类型", "上一页", "下一页", "跳至", "通过", "驳回", "审核留言（可选）"]) {
    assert.match(wxml, new RegExp(label), `HQ review UI is missing ${label}`);
  }
  assert.match(wxss, /\.review-table\s*\{\s*width:\s*2050rpx;/,
    "review table width must exactly equal the declared column total");
  assert.match(wxss, /grid-template-columns:\s*230rpx 150rpx 230rpx 220rpx 210rpx 180rpx 150rpx 230rpx 250rpx 200rpx/);
  assert.equal(230 + 150 + 230 + 220 + 210 + 180 + 150 + 230 + 250 + 200, 2050);
  assert.match(wxss, /\.review-row > text, \.review-row > view\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*text-align:\s*center[^}]*white-space:\s*nowrap/s,
    "review headers and values must stay centered on one line");
  assert.match(wxss, /\.review-row > text:last-child, \.review-row > view:last-child\s*\{\s*border-right:\s*0;/,
    "the final review column must not leave a trailing border sliver");
  for (const selector of ["review-type-tabs button", "mode-tabs button", "review-action button"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(wxss, new RegExp(`\\.${escaped}\\s*\\{[^}]*align-items:\\s*center;[^}]*justify-content:\\s*center;[^}]*white-space:\\s*nowrap;`, "s"),
      `${selector} must center its wording instead of relying on native button line-height`);
  }
});

test("mini internal palette is isolated warm ivory, champagne gold, and espresso", () => {
  const app = read("app.wxss");
  const appJson = JSON.parse(read("app.json"));
  const registeredPages = [
    ...appJson.pages,
    ...(appJson.subPackages || []).flatMap((subpackage) =>
      subpackage.pages.map((page) => `${subpackage.root}/${page}`))
  ];
  const context = fs.readFileSync(path.join(root, "PROJECT_CONTEXT.md"), "utf8");
  for (const color of ["#f3ede2", "#fffaf3", "#6f532e", "#a98243", "#302a22"]) assert.match(app, new RegExp(color, "i"));
  assert.equal(appJson.window.navigationBarBackgroundColor, "#2f2921");
  assert.ok(registeredPages.includes("pages/hq-directory/index"));
  assert.ok(registeredPages.includes("pages/product-management/index"));
  assert.ok(registeredPages.includes("pages/product-create/index"));
  assert.ok(registeredPages.includes("pages/product-detail/index"));
  for (const route of ["pages/store-create/index", "pages/store-detail/index", "pages/teacher-create/index", "pages/teacher-detail/index"]) assert.ok(registeredPages.includes(route));
  assert.ok(registeredPages.includes("pages/reviews/index"));
  assert.match(context, /不得恢复旧版高饱和蓝色工作台主题/);
  assert.match(context, /只修改小程序 WXML／WXSS，不反向覆盖网页版客户端样式/);
});
