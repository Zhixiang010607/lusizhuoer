const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

const mobileRules = css.slice(css.lastIndexOf("/* On phones the document owns vertical scrolling."));
assert(mobileRules.includes("body[data-customer-profile]"), "customer profile must opt into mobile document scrolling");
assert(mobileRules.includes("body[data-query]"), "record query pages must opt into mobile document scrolling");
assert(mobileRules.includes("body[data-customer-query]"), "customer query must opt into mobile document scrolling");
assert(/overflow-y:\s*auto/.test(mobileRules), "mobile document must allow vertical scrolling");
assert(/body\[data-query\] main,[\s\S]*?overflow:\s*visible/.test(mobileRules), "mobile query main content must not be clipped");
assert(/customer-profile-grid,[\s\S]*?customer-records-grid\s*\{\s*grid-template-columns:\s*1fr/.test(mobileRules), "customer profile and order records must stack on phones");
assert(/customer-project-panel[\s\S]*?customer-record-panel[\s\S]*?height:\s*auto[\s\S]*?max-height:\s*none/.test(mobileRules), "customer record panels must grow naturally on phones");
assert(/body\[data-customer-query\] \.customer-query-method-fields\s*\{\s*grid-template-columns:\s*1fr/.test(css), "mobile customer manual query must place name and birthday on separate rows");

for (const file of ["customer-detail.html", "customer-query.html", "recharge-query.html", "verification-query.html"]) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  const styleVersion = file === "customer-detail.html" ? "0.15.44" : "0.15.48";
  assert(html.includes(`styles.css?v=${styleVersion}`), `${file} must use the current stylesheet cache key`);
  assert(/<meta\s+name="viewport"/.test(html), `${file} must declare a mobile viewport`);
}

for (const file of ["customer-query.html", "recharge-query.html", "verification-query.html"]) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  assert(!html.includes("<colgroup>"), `${file} must let query result columns size from their content`);
}
assert(/customer-results-table\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;[^}]*table-layout:\s*auto/.test(css), "customer query columns must size responsively");
assert(/record-query-results-table\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;[^}]*table-layout:\s*auto/.test(css), "recharge and verification query columns must size responsively");

const businessMobileRules = css.slice(css.lastIndexOf("/* Tablet and phone business workflows"));
assert(businessMobileRules.includes("body[data-store-business]"), "business workflows must opt into tablet and phone document scrolling");
assert(/body\[data-store-business\][\s\S]*?height:\s*auto[\s\S]*?overflow-y:\s*auto/.test(businessMobileRules), "business workflow document must grow and scroll vertically");
assert(/workflow-lookup-panel \.service-customer-results[\s\S]*?flex:\s*0 0 auto[\s\S]*?overflow:\s*visible/.test(businessMobileRules), "customer result card must grow instead of clipping its final fact");
assert(/customer-core-preview[\s\S]*?max-height:\s*none[\s\S]*?overflow:\s*visible/.test(businessMobileRules), "customer confirmation preview must expose all facts");
assert(/customer-core-facts strong[\s\S]*?overflow-wrap:\s*anywhere/.test(businessMobileRules), "long customer numbers must wrap on narrow screens");
assert(/@media \(max-width:\s*560px\)[\s\S]*?customer-profile-layout[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/.test(businessMobileRules), "phone customer profile must use a true one-column layout");

const businessPages = [
  "customer-create.html",
  "recharge-create.html",
  "verification-create.html",
  "verification-experience.html"
];
const teacherBusinessPages = [
  "teacher-recharge-create.html",
  "teacher-verification-create.html",
  "teacher-verification-experience.html"
];
for (const file of businessPages) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  assert(html.includes('styles.css?v=0.15.44'), `${file} must use the current stylesheet cache key`);
  assert(html.includes("data-store-business"), `${file} must be a store business workflow`);
}
for (const file of teacherBusinessPages) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  assert(html.includes('styles.css?v=0.15.44'), `${file} must use the current stylesheet cache key`);
  assert(html.includes("data-store-business"), `${file} must be a store business workflow`);
}

const storeBusiness = fs.readFileSync(path.join(root, "store-business.js"), "utf8");
assert(storeBusiness.includes("<span>客户编号</span><strong>${escapeHtml(customer.id)}</strong>"), "customer confirmation card must render the full customer number");

const desktopRules = css.slice(css.lastIndexOf("/* Desktop pages normally fit within the viewport"));
assert(/@media \(min-width:\s*761px\)/.test(desktopRules), "desktop scroll fallback must start at the desktop breakpoint");
assert(/html\s*\{[\s\S]*?overflow-y:\s*auto/.test(desktopRules), "desktop document root must allow vertical scrolling");
assert(/body\.login-page\s*\{[\s\S]*?height:\s*auto[\s\S]*?overflow-y:\s*auto/.test(desktopRules), "desktop login must scroll when the sign-in card exceeds the viewport");
assert(/body\[data-query\],[\s\S]*?body\[data-store-business\]\s*\{[\s\S]*?height:\s*auto[\s\S]*?overflow-y:\s*auto/.test(desktopRules), "fixed-height app shells must use document scrolling on desktop");
assert(/body\[data-query\] main,[\s\S]*?overflow:\s*visible/.test(desktopRules), "desktop query main content must not be clipped");
assert(/body\[data-hq-create\] \.hq-create-main,[\s\S]*?overflow:\s*visible/.test(desktopRules), "desktop creation forms must not be clipped");
assert(/@media \(min-width:\s*981px\)[\s\S]*?store-business-main[\s\S]*?min-height:\s*max\(610px/.test(desktopRules), "desktop business workflows must grow beyond short viewports");

for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  if (!html.includes("styles.css")) continue;
  const expectedStyleVersion = ["staff-detail.html", "teacher-create.html"].includes(file)
    ? "0.15.53"
    : ["teacher-management.html", "teacher-detail.html"].includes(file)
    ? "0.15.50"
    : ["store-detail.html", "store-management.html"].includes(file)
    ? "0.15.49"
    : ["store-analysis.html", "project-detail.html", "project-management.html", "project-create.html"].includes(file)
    ? "0.15.48"
    : file === "verification-detail.html"
    ? "0.15.48"
    : file === "recharge-detail.html"
      ? "0.15.48"
    : ["customer-query.html", "recharge-query.html", "verification-query.html", "recharge-review.html", "refund-review.html", "verification-review.html"].includes(file)
        ? "0.15.48"
        : file === "index.html"
          ? "0.15.45"
        : "0.15.44";
  assert(html.includes(`styles.css?v=${expectedStyleVersion}`), `${file} must use the desktop-scroll stylesheet cache key`);
}

console.log("mobile scroll layout tests passed");
