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

for (const file of ["customer-detail.html", "customer-query.html", "recharge-query.html", "verification-query.html"]) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  assert(html.includes('styles.css?v=0.15.13'), `${file} must use the mobile-scroll stylesheet cache key`);
  assert(/<meta\s+name="viewport"/.test(html), `${file} must declare a mobile viewport`);
}

console.log("mobile scroll layout tests passed");
