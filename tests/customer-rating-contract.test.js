"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const functionBody = (source, name, nextName) => {
  const start = source.indexOf(`function ${name}`);
  const asyncStart = source.indexOf(`async function ${name}`);
  const actualStart = start >= 0 ? start : asyncStart;
  assert.ok(actualStart >= 0, `missing function ${name}`);
  const markers = [`\nfunction ${nextName}`, `\nasync function ${nextName}`]
    .map((marker) => source.indexOf(marker, actualStart + 1))
    .filter((index) => index >= 0);
  return source.slice(actualStart, markers.length ? Math.min(...markers) : source.length);
};

const cloud = read("cloudfunctions/customerRating/index.js");
const migration = read("database/migrations/068_customer_work_order_ratings.sql");
const readonlyVerify = read("database/cloudbase-console/068-readonly-verify.sql");
const publicHtml = read("rating.html");
const publicJs = read("rating.js");
const webDetail = read("business-detail.js");
const webHtml = read("verification-detail.html");
const webReceipt = read("order-export.js");
const miniDetail = read("miniprogram-app/miniprogram/pages/order-detail/index.js");
const miniWxml = read("miniprogram-app/miniprogram/pages/order-detail/index.wxml");
const miniReceipt = read("miniprogram-app/miniprogram/services/order-receipt.js");
const miniApi = read("miniprogram-app/miniprogram/services/api.js");

test("migration 068 binds one immutable rating to a completed normal or experience verification", () => {
  for (const contract of [
    "UNIQUE (verification_id)",
    "verification_type NOT IN ('NORMAL', 'EXPERIENCE')",
    "work_order.record_status <> 'APPROVED'",
    "submitted customer ratings are immutable",
    "customer ratings are immutable audit evidence and cannot be deleted",
    "customer_comment IS NULL OR char_length(customer_comment) <= 500",
    "teacher_id IS NULL AND teacher_service_score IS NULL",
    "ENABLE ROW LEVEL SECURITY",
    "FROM PUBLIC, anon, authenticated",
    "TO service_role"
  ]) assert.ok(migration.includes(contract), `migration 068 missing ${contract}`);
  assert.match(readonlyVerify, /service role rating CRUD retained[\s\S]*privilege_type\) = 4/,
    "migration 068 handoff must verify the cloud function retains CRUD access");
});

test("customerRating v1 keeps public links signed, stable, scoped, and one-time", () => {
  assert.match(cloud, /const FUNCTION_VERSION = "v1"/);
  assert.match(cloud, /CUSTOMER_RATING_SIGNING_KEY/);
  assert.match(cloud, /缺少 CUSTOMER_RATING_BASE_URL/);
  assert.match(cloud, /Buffer\.byteLength\(value, "utf8"\) >= 32/);
  assert.match(cloud, /createHmac\("sha256", ratingSigningKey\(\)\)/);
  assert.match(cloud, /timingSafeEqual/);
  assert.match(cloud, /createHash\("sha256"\)\.update\(token, "utf8"\)\.digest\("hex"\)/);
  assert.doesNotMatch(cloud, /verified_at/,
    "rating eligibility must use the real approved work-order status, not the retired draft field");

  const issue = functionBody(cloud, "issueForStore", "publicRow");
  assert.match(issue, /staff\.role_code !== "store"/);
  assert.match(issue, /order\.record_status !== "APPROVED"/);
  assert.match(issue, /signedRatingToken\(rating\)/,
    "repeat exports must derive the same token from the rating id and token version");
  assert.match(issue, /publicUrl\.searchParams\.set\("token", token\)/,
    "configured rating page queries and fragments must receive the token safely");
  assert.match(issue, /ON CONFLICT \(verification_id\) DO NOTHING/);
  assert.doesNotMatch(`${issue}\n${functionBody(cloud, "publicRow", "getPublic")}`,
    /expires?_at|expiry|token_ttl|Date\.now\(\)/i,
    "an unsubmitted rating QR must not expire");
  assert.doesNotMatch(migration, /token_expires|expires?_at|token_ttl/i,
    "migration 068 must not add an expiry to an open rating link");

  const staffRead = functionBody(cloud, "canReadRating", "getForStaff");
  assert.match(staffRead, /staff\.role_code === "hq"/);
  assert.match(staffRead, /staff\.role_code === "store"/);
  assert.match(staffRead, /staff\.role_code === "teacher"/);

  const submit = functionBody(cloud, "submitPublic", "health");
  assert.match(submit, /rating_status = 'OPEN'/);
  assert.match(submit, /submitted_at IS NULL/);
  assert.match(submit, /alreadySubmitted: true/,
    "a submitted rating must be returned read-only instead of being updated again");
  assert.match(submit, /COMMENT_TOO_LONG/);
  assert.match(submit, /row\.teacher_id[\s\S]*numberScore\(event\.teacherServiceScore/);
});

test("public rating page provides three accessible star groups and optional text without staff login", () => {
  for (const label of ["门店环境", "老师服务", "整体体验", "想对我们说的话"]) {
    assert.ok(publicHtml.includes(label), `public rating page missing ${label}`);
  }
  assert.equal((publicHtml.match(/class="star-picker" role="radiogroup"/g) || []).length, 3);
  assert.match(publicHtml, /maxlength="500"/);
  assert.match(publicHtml, /cloudbase\.auth\.js/);
  assert.match(publicJs, /for \(let score = 1; score <= 5; score \+= 1\)/);
  assert.match(publicJs, /auth\.getLoginState\(\)/);
  assert.match(publicJs, /auth\.anonymousAuthProvider\(\)\.signIn\(\)/);
  assert.match(publicJs, /callRating\("submitPublic"/);
  assert.match(publicJs, /teacherRatingQuestion"\)\.hidden = !data\.requiresTeacherScore/);
  assert.doesNotMatch(publicJs, /auth-ui|location\.href\s*=\s*["']login/,
    "customer QR page must not redirect anonymous customers to staff login");
});

test("web work-order detail shows no-rating or submitted stars and only store exports request a QR", () => {
  assert.match(webHtml, /id="customerRatingPanel"[\s\S]*id="customerRatingBody"/);
  assert.ok(webHtml.indexOf('id="customerRatingPanel"') > webHtml.indexOf('id="verificationPhotoPanel"'),
    "customer rating must be appended at the bottom of the work-order content");
  assert.match(webDetail, /body\.textContent = "暂无评价"/);
  assert.match(webDetail, /!\["NORMAL", "EXPERIENCE"\]\.includes\(verificationKind\)/,
    "legacy supplement records must show no rating instead of a service error");
  assert.match(webDetail, /"★"\.repeat\(value\)/);
  assert.match(webDetail, /rating\.customerComment/);
  const exportBody = functionBody(webDetail, "exportCurrentOrder", "isVoidableOriginalType");
  assert.match(exportBody, /readSession\(\)\?\.role\)\.toLowerCase\(\) === "store"/);
  assert.match(exportBody, /\["NORMAL", "EXPERIENCE"\]\.includes/);
  assert.match(exportBody, /callCustomerRating\("issueForStore"/);
  assert.doesNotMatch(exportBody, /role[^\n]+(?:teacher|hq)[\s\S]*issueForStore/i,
    "teacher and HQ export paths must never issue a QR");
  assert.match(webReceipt, /if \(!ratingQr\?\.enabled\) return y/);
  assert.match(webReceipt, /if \(!source\) return \{ enabled: false, image: null \}/);
});

test("mini-program phone and iPad detail use the same rating and store-only QR contract", () => {
  assert.match(miniApi, /Object\.prototype\.hasOwnProperty\.call\(value, "success"\)/,
    "mini-program must parse the customerRating success/data response contract");
  assert.match(miniWxml, /wx:elif="\{\{!rating\.submitted\}\}" class="rating-empty">暂无评价<\/view>/);
  assert.match(miniWxml, /rating\.storeEnvironmentStars/);
  assert.match(miniWxml, /rating\.teacherServiceStars/);
  assert.match(miniWxml, /rating\.overallExperienceStars/);
  assert.match(miniWxml, /rating\.customerComment/);
  assert.match(miniDetail, /!\["NORMAL", "EXPERIENCE"\]\.includes\(clean\(this\.data\.order\.originalType\)/,
    "legacy supplement records must show no rating instead of a service error");
  const exportStart = miniDetail.indexOf("  async exportOrder(format) {");
  const exportEnd = miniDetail.indexOf("\n  exportPdf()", exportStart);
  assert.ok(exportStart >= 0 && exportEnd > exportStart, "missing mini-program exportOrder method");
  const exportBody = miniDetail.slice(exportStart, exportEnd);
  assert.match(exportBody, /session\?\.role\)\.toLowerCase\(\) === "store"/);
  assert.match(exportBody, /\["NORMAL", "EXPERIENCE"\]\.includes/);
  assert.match(exportBody, /callRating\("issueForStore"/);
  assert.match(miniReceipt, /if \(!ratingQr\?\.enabled\) return y/);
  assert.match(miniReceipt, /if \(!source\) return \{ enabled: false, image: null \}/);
});
