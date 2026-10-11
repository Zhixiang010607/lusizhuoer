"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const auth = read("auth-ui.js");
const theme = read("web-tablet-parity.css");
const login = read("login.html");
const rating = read("rating.html");
const common = read("web-work-common.js");
const calendarHtml = read("work-calendar.html");
const calendarJs = read("work-calendar.js");
const attendanceHtml = read("attendance.html");
const attendanceJs = read("attendance.js");
const trackingHtml = read("attendance-tracking.html");
const trackingJs = read("attendance-tracking.js");
const context = read("PROJECT_CONTEXT.md");
const teacherManagement = read("teacher-management.js");
const teacherDetail = read("staff-detail.js");
const customerQuery = read("customer-query.js");
const customerProfile = read("customer-profile.js");
const projectDetailHtml = read("project-detail.html");
const projectDetailJs = read("project-detail.js");

test("Web uses the warm tablet visual language without importing Mini Program source", () => {
  for (const color of ["#f3ede2", "#fffaf3", "#6f532e", "#a98243", "#302a22", "#2f2921"]) assert.match(theme, new RegExp(color, "i"));
  assert.match(theme, /width: min\(1120px/);
  assert.match(theme, /\.side-project-bar[\s\S]*position: sticky/);
  assert.match(auth, /web-tablet-parity\.css\?v=1\.0\.8/);
  assert.match(theme, /button, \.button-link,[\s\S]{0,220}min-height: 44px !important;[\s\S]{0,220}text-align: center !important;/);
  assert.doesNotMatch(`${theme}\n${auth}`, /miniprogram-app|\.wxss|\.wxml/);
  assert.match(context, /网页版也采用同一套平板横屏视觉与功能信息架构/);
  assert.match(context, /只扩展网页入口，不改变正常／体验／补录核销/);
});

test("public login and rating pages load the current tablet stylesheet", () => {
  assert.match(login, /web-tablet-parity\.css\?v=1\.0\.8/);
  assert.match(rating, /web-tablet-parity\.css\?v=1\.0\.8/);
  assert.match(theme, /body\.login-page \.password-field button[\s\S]{0,220}min-height: 32px !important;[\s\S]{0,220}transform: translateY\(-50%\)/);
  assert.match(theme, /body\.login-page \.login-shell[\s\S]{0,160}width: min\(590px, calc\(100% - 32px\)\) !important;[\s\S]{0,120}max-width: 590px !important;/);
  assert.match(theme, /@media \(max-width: 600px\)[\s\S]*body\.login-page \.login-shell[\s\S]{0,120}width: 100% !important;/);
});

test("neighbouring Web actions keep a visible gap instead of sticking together", () => {
  for (const selector of ["review-query-mode", "camera-actions", "product-preview-tabs", "review-filter-fields"]) {
    assert.match(theme, new RegExp(`\\.${selector}[\\s\\S]{0,260}gap: (?:12|14)px !important;`));
  }
  assert.match(theme, /\.product-logo-actions[\s\S]{0,180}grid-template-columns: minmax\(0, 1\.4fr\) minmax\(0, \.8fr\) !important;/);
  assert.match(theme, /\.product-logo-actions > button \{ padding-inline: 10px !important;/);
  assert.match(theme, /\.workflow-capture-panel \{ overflow: visible !important; \}/);
  assert.match(theme, /\.dashboard-ranking-controls:empty \{ display: none !important; \}/);
  assert.match(theme, /body\[data-review\] main,[\s\S]{0,120}\.review-main \{[\s\S]{0,120}gap: 16px !important;/);
  assert.match(theme, /body:not\(\.login-page\) \*,[\s\S]{0,150}box-sizing: border-box;/);
  assert.match(theme, /\.panel, \.chart-card, \.table-card,[\s\S]{0,240}min-width: 0 !important;[\s\S]{0,80}max-width: 100% !important;/);
});

test("review result counts use a separated warm compact badge", () => {
  assert.match(theme, /\.review-toolbar \{[\s\S]{0,260}grid-template-areas: "mode mode" "query count" !important;[\s\S]{0,180}gap: 12px 16px !important;[\s\S]{0,100}padding: 16px 18px !important;/);
  assert.match(theme, /\.review-filters \{[\s\S]{0,180}grid-template-columns: minmax\(0, 1fr\) auto !important;[\s\S]{0,140}gap: 16px !important;/);
  assert.match(theme, /body\[data-review="recharge"\] \.review-filter-row,[\s\S]{0,120}grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) minmax\(150px, \.85fr\) !important;/);
  assert.match(theme, /\.review-count \{[\s\S]{0,520}justify-self: end !important;[\s\S]{0,260}margin: 0 !important;[\s\S]{0,260}background: #f4e7d0 !important;[\s\S]{0,180}border: 1px solid #dfcfb4 !important;/);
  assert.match(theme, /\.review-table \{ margin: 0 !important; \}/);
  assert.match(theme, /\.review-table \.table-scroll \{[\s\S]{0,180}overflow-x: auto !important;/);
  assert.match(theme, /\.review-table table \{ width: max-content !important; min-width: 100% !important; \}/);
  assert.match(theme, /\.review-table th,[\s\S]{0,50}\.review-table td \{ white-space: nowrap !important; \}/);
  assert.match(theme, /\.query-empty \{ padding: 24px 16px !important; \}/);
  assert.doesNotMatch(theme.match(/\.review-count \{[\s\S]*?\}/)?.[0] || "", /#f4f7fa|#edf|#eef/);
});

test("tablet-width Web navigation and customer query remain readable", () => {
  assert.match(theme, /@media \(max-width: 1100px\)[\s\S]*\.side-nav > a span:last-child,[\s\S]*display: inline !important;/);
  assert.match(theme, /body\[data-customer-query\] \.customer-query-filters[\s\S]{0,160}grid-template-columns: minmax\(0, 1fr\) !important;/);
  assert.match(theme, /body\[data-customer-query\] \.customer-query-methods[\s\S]{0,200}grid-template-columns: minmax\(0, 1\.4fr\) minmax\(0, 1fr\) !important;/);
  assert.match(theme, /@media \(max-width: 700px\)[\s\S]*\.side-nav > a span:last-child,[\s\S]*display: none !important;/);
  assert.match(theme, /body\[data-customer-query\] \.customer-query-methods \{ grid-template-columns: 1fr !important; \}/);
  assert.match(theme, /body\[data-customer-query\] \.customer-query-method-fields[\s\S]{0,120}grid-template-columns: minmax\(0, 1fr\) !important;/);
  assert.match(theme, /body\[data-customer-query\] \.chinese-birthday-input[\s\S]{0,220}grid-template-columns: minmax\(0, 1\.35fr\) auto minmax\(0, 1fr\) auto minmax\(0, 1fr\) auto !important;/);
  assert.match(theme, /body\[data-customer-query\] \.customer-query-method-heading[\s\S]{0,180}background: transparent !important;/);
});

test("HQ dashboard aligns filter controls and centers every project-summary name", () => {
  assert.match(theme, /body\[data-view="global"\] \.dashboard-ranking-controls[\s\S]{0,220}align-items: start !important;/);
  assert.match(theme, /body\[data-view="global"\] \.hq-project-summary-row > :first-child[\s\S]{0,180}justify-content: center !important;[\s\S]{0,180}text-align: center !important;/);
});

test("every review menu receives the shared horizontal navigation layout", () => {
  assert.match(read("product-purchase-review.html"), /<details class="side-menu-group" data-menu="review"/);
  assert.match(auth, /reviewMenu\.classList\.add\("side-menu-group"\)/);
});

test("role navigation exposes Web work calendars and tracking only to authorized roles", () => {
  const hq = auth.slice(auth.indexOf("hq: new Set"), auth.indexOf("store: new Set"));
  const store = auth.slice(auth.indexOf("store: new Set"), auth.indexOf("teacher: new Set"));
  const teacher = auth.slice(auth.indexOf("teacher: new Set"), auth.indexOf("};", auth.indexOf("teacher: new Set")));
  assert.match(hq, /attendance-tracking\.html/);
  assert.doesNotMatch(store, /attendance-tracking|work-calendar|attendance\.html/);
  assert.match(teacher, /work-calendar\.html/);
  assert.match(teacher, /attendance\.html/);
  assert.doesNotMatch(teacher, /attendance-tracking\.html/);
  assert.match(auth, /日报追踪[\s\S]*打卡追踪/);
});

test("teacher Web calendar keeps attendance and reports as separate modes", () => {
  for (const label of ["考勤月历", "日报月历", "上一年", "上月", "下月", "下一年"]) assert.match(calendarHtml, new RegExp(label));
  assert.match(calendarJs, /getOwnTeacherWorkMonth/);
  assert.match(calendarJs, /employmentStartDate/);
  assert.match(calendarJs, /CLOCK_IN/);
  assert.match(calendarJs, /CLOCK_OUT/);
  assert.match(calendarJs, /daily-report\.html/);
  assert.match(calendarJs, /attendance\.html/);
});

test("teacher Web attendance requires live location and front camera", () => {
  assert.match(attendanceJs, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(attendanceJs, /getUserMedia\(\{ video: \{ facingMode: "user"/);
  assert.match(attendanceJs, /resolveTeacherAttendanceLocation/);
  assert.match(attendanceJs, /clockInTeacherAttendance/);
  assert.match(attendanceJs, /Date\.now\(\) - state\.preview\.capturedAt > 120000/);
  assert.match(attendanceJs, /getOwnAttendanceMonth/);
  assert.match(attendanceJs, /toDataURL\("image\/jpeg"/);
  assert.doesNotMatch(`${attendanceHtml}\n${attendanceJs}`, /<input[^>]+type="file"|showOpenFilePicker|FileReader/);
  assert.match(common, /timeZone: "Asia\/Shanghai"/);
  assert.match(auth, /data-attendance-tracking/);
  assert.match(auth, /timeZone: "Asia\/Shanghai"/);
  assert.match(attendanceHtml, /现场照片只发送给人脸验证接口|实时定位与前置摄像头/);
});

test("HQ Web tracking preserves four states and seven fixed columns", () => {
  assert.match(trackingJs, /getHqAttendanceTrackingDay/);
  for (const label of ["完整打卡", "仅上班打卡", "仅下班打卡", "未打卡"]) assert.match(trackingJs, new RegExp(label));
  for (const label of ["老师姓名", "老师电话", "上班时间", "上班详情", "下班时间", "下班详情", "工作时长"]) assert.match(trackingJs, new RegExp(label));
  assert.match(trackingJs, /teacher\.clockIn && teacher\.clockOut \? C\.duration/);
  assert.match(trackingHtml, /总部只读/);
});

test("teacher and customer Web directories keep internal IDs out of visible profiles", () => {
  assert.doesNotMatch(teacherManagement, /data-label="老师编号"/);
  assert.doesNotMatch(teacherDetail, /<dt>老师编号<\/dt>/);
  assert.doesNotMatch(customerQuery, /<th>客户编号<\/th>/);
  assert.doesNotMatch(customerProfile, /<dt>客户编号<\/dt>/);
  assert.match(teacherManagement, /staff-detail\.html\?role=teacher&id=/);
  assert.match(customerQuery, /customer-detail\.html\?customerId=/);
  assert.match(context, /内部编号继续只用于数据库识别、权限校验和链接参数/);
});

test("Web project logo uses two actions and uploads immediately after selection", () => {
  assert.match(projectDetailHtml, /选择或替换图片/);
  assert.match(projectDetailHtml, /移除图片/);
  assert.doesNotMatch(projectDetailHtml, /id="uploadProductLogo"|上传并保存/);
  assert.match(projectDetailJs, /已选择原图，正在上传并保存/);
  assert.match(projectDetailJs, /void renderPreview\(\);\s*await uploadLogo\(\);/);
  assert.doesNotMatch(projectDetailJs, /\$\("uploadProductLogo"\)/);
});
