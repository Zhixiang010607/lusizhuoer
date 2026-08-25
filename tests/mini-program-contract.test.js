const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");

const project = JSON.parse(fs.readFileSync(path.join(root, "miniprogram-app", "project.config.json"), "utf8"));
assert.match(project.appid, /^wx[a-z0-9]{16}$/i, "a real mini-program AppID must replace touristappid");
const packageManifest = JSON.parse(read("package.json"));
assert.equal(packageManifest.packageManager, "pnpm@9.15.9");
assert.equal(packageManifest.engines.node, ">=20.19.0");
assert.equal(read(".npmrc").trim(), "node-linker=hoisted");
assert.match(read("services", "cloudbase.js"), /pnpm install --frozen-lockfile/);

const app = JSON.parse(read("app.json"));
assert.ok(!(app.requiredPrivateInfos || []).includes("chooseMedia"), "chooseMedia is not a valid requiredPrivateInfos entry");
const expectedPages = [
  "login", "password-reset", "home", "product-management", "product-create", "product-detail",
  "hq-directory", "store-create", "store-detail", "teacher-create", "teacher-detail", "reviews",
  "customers", "customer-detail", "customer-create", "recharge", "verification", "records", "order-detail"
];
assert.deepEqual(app.pages, [
  "pages/login/index", "pages/password-reset/index", "pages/home/index",
  "pages/store-create/index", "pages/store-detail/index", "pages/teacher-create/index", "pages/teacher-detail/index"
], "only startup pages and pages sharing main-package WXSS may remain in the two-megabyte main package");
const subpackagePages = (app.subPackages || []).flatMap((subpackage) =>
  subpackage.pages.map((page) => `${subpackage.root}/${page}`));
const registeredPages = [...app.pages, ...subpackagePages];
assert.deepEqual([...registeredPages].sort(), expectedPages.map((page) => `pages/${page}/index`).sort(),
  "the complete isolated mini-program page inventory must remain registered");
assert.equal(new Set((app.subPackages || []).map(({ root: packageRoot }) => packageRoot)).size,
  (app.subPackages || []).length, "business subpackage roots must be unique");
assert.equal((app.subPackages || []).length, 12, "business pages must stay outside the main package unless they share main-package WXSS");
for (const page of expectedPages) {
  assert.ok(registeredPages.includes(`pages/${page}/index`), `missing mini-program page ${page}`);
  for (const extension of ["js", "json", "wxml", "wxss"]) assert.ok(fs.existsSync(path.join(mini, "pages", page, `index.${extension}`)), `${page}.${extension} missing`);
}

assert.equal(project.setting.uploadWithSourceMap, false, "production uploads must exclude sourcemaps from the two-megabyte source limit");
assert.equal(project.setting.ignoreUploadUnusedFiles, true, "production uploads must filter unused files");
for (const suffix of [".map", ".d.ts"]) {
  assert.ok(project.packOptions?.ignore?.some((rule) => rule.type === "suffix" && rule.value === suffix),
    `production uploads must ignore ${suffix} files`);
}
assert.ok(project.packOptions?.ignore?.some((rule) => rule.type === "folder" && rule.value === "node_modules"),
  "source node_modules must not be uploaded alongside miniprogram_npm");
for (const file of [".npmrc", "package.json", "pnpm-lock.yaml"]) {
  assert.ok(project.packOptions?.ignore?.some((rule) => rule.type === "file" && rule.value === file),
    `local dependency metadata ${file} must not be uploaded`);
}

const subpackageRoots = new Set((app.subPackages || []).map(({ root: packageRoot }) => path.join(mini, packageRoot)));
const excludedUploadFiles = new Set([".npmrc", "package.json", "pnpm-lock.yaml"]);
let mainApplicationBytes = 0;
function measureMainPackage(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "miniprogram_npm" || subpackageRoots.has(file)) continue;
      measureMainPackage(file);
    } else if (!entry.name.endsWith(".map") && !entry.name.endsWith(".d.ts") && !excludedUploadFiles.has(entry.name)) {
      mainApplicationBytes += fs.statSync(file).size;
    }
  }
}
measureMainPackage(mini);
const reachableNpmBytes = ["@cloudbase/js-sdk/index.js", "@cloudbase/adapter-wx_mp/index.js"]
  .reduce((total, file) => total + fs.statSync(path.join(mini, "miniprogram_npm", file)).size, 0);
assert.ok(mainApplicationBytes + reachableNpmBytes < 1.8 * 1024 * 1024,
  "estimated raw main package must retain at least a 200KB margin below WeChat's 2MB limit");

const allClientSource = [...fs.readdirSync(path.join(mini, "services")).map((file) => read("services", file)),
  ...registeredPages.map((page) => read(`${page}.js`)), read("config", "env.js")].join("\n");
for (const forbidden of ["FACE_SECRET_ID", "FACE_SECRET_KEY", "CLOUDBASE_APIKEY", "PGPASSWORD", "ExecutePGSql", "SELECT * FROM", "INSERT INTO public."]) {
  assert.ok(!allClientSource.includes(forbidden), `client must not contain ${forbidden}`);
}
for (const wxml of registeredPages.map((page) => read(`${page}.wxml`))) assert.doesNotMatch(wxml, /<\/?(?:small|div|span|p)(?:\s|>)/, "WXML must use mini-program built-in elements");

const session = read("services", "session.js");
assert.match(session, /signInWithPhoneAuth\(\{ phoneCode \}\)/);
assert.match(session, /callStaff\("session"\)/,
  "WeChat phone authorization must resolve the business identity from the authenticated UID");
assert.doesNotMatch(session, /callStaff\("session"\s*,/,
  "the mini-program must never send a phone to the public staff session action");
assert.match(session, /String\(staff\.uid \|\|/);
assert.match(session, /if \(session\.role === "store" && !session\.storeId\)/);

const loginWxml = read("pages", "login", "index.wxml");
for (const removedClass of ["brand-note", "description", "wechat-note", "security-note"]) {
  assert.ok(!loginWxml.includes(`class="${removedClass}"`), `login must not restore explanatory ${removedClass} copy`);
}
const phoneAuthorizationButton = loginWxml.match(/<button\b[^>]*open-type="getPhoneNumber"[^>]*>/)?.[0] || "";
assert.ok(phoneAuthorizationButton, "login must use the WeChat getPhoneNumber authorization button");
assert.match(phoneAuthorizationButton, /bindgetphonenumber="submitWechatPhone"/);
const loginPage = read("pages", "login", "index.js");
assert.match(loginPage, /wechatPhoneLogin/);
assert.match(loginPage, /submitWechatPhone\s*\(/);
assert.match(loginPage, /event\.detail\.code/);

const home = read("pages", "home", "index.wxml");
assert.match(home, /wx:if="\{\{session\.role !== 'hq'\}\}">/);
assert.match(home, /session\.role === 'teacher'.*EXPERIENCE/s);

const customerCreate = read("pages", "customer-create", "index.js");
assert.ok(customerCreate.indexOf('callFace("validateCapture"') < customerCreate.indexOf('callFace("registerCustomer"'));
assert.match(customerCreate, /if \(!code\) throw new Error/);

const recharge = read("pages", "recharge", "index.js");
for (const token of ["listActiveProducts", "getCustomerProductBalances", "listActiveTeachers", "createRechargeApplication", "recoverBusinessSubmission"]) assert.ok(recharge.includes(token) || read("services", "submission.js").includes(token));
assert.ok(recharge.indexOf('submission.begin("RECHARGE"') < recharge.indexOf('callFace("createRechargeApplication"'));
assert.match(recharge, /submission\.markUncertain\("RECHARGE"\)/);
assert.match(recharge, /pages\/order-detail\/index\?type=recharge/);
assert.match(recharge, /openSubmittedOrder\(result, intent\)[\s\S]*wx\.redirectTo\(\{/);
assert.match(recharge, /category=\$\{category\}/);
assert.match(recharge, /showRecovered\(result\)[\s\S]*submission\.confirm\("RECHARGE", result\.rechargeId\)[\s\S]*this\.openSubmittedOrder\(result, confirmedIntent\)/);

const verification = read("pages", "verification", "index.js");
for (const token of ["getTeacherExperienceEntitlements", "getCustomerProductBalances", "verifyCustomerFace", "createVerificationApplication"]) assert.ok(verification.includes(token));
assert.match(verification, /experience && session\.role !== "teacher"/);
assert.match(verification, /verificationType: this\.data\.experience \? "EXPERIENCE" : "NORMAL"/);
assert.ok(verification.indexOf('callFace("verifyCustomerFace"') < verification.indexOf('callFace("createVerificationApplication"'));
assert.ok(verification.indexOf('submission.begin("VERIFICATION"') < verification.indexOf('callFace("createVerificationApplication"'));
assert.match(verification, /pages\/order-detail\/index\?type=verification/);
assert.match(verification, /openSubmittedOrder\(result, intent\)[\s\S]*wx\.redirectTo\(\{/);
assert.match(verification, /category=\$\{category\}/);
assert.match(verification, /showRecovered\(result\)[\s\S]*submission\.confirm\("VERIFICATION", result\.verificationId\)[\s\S]*this\.openSubmittedOrder\(result, confirmedIntent\)/);
assert.doesNotMatch(verification, /verifyTeacherFace|identifyFace|SearchPersons|1:N/);

function submissionPageHarness(source) {
  let definition;
  const redirects = [];
  vm.runInNewContext(source, {
    Page(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callFace: async () => ({}) };
      if (id === "../../services/session") return { requireSession: () => null, getSelectedStore: () => null };
      if (id === "../../services/submission") return {};
      throw new Error(`unexpected page dependency ${id}`);
    },
    wx: {
      redirectTo(options) { redirects.push(options.url); },
      showModal() {},
      reLaunch() {}
    },
    encodeURIComponent, String, Number, Boolean, Math, Date, Promise
  });
  assert.ok(definition, "submission page must register itself");
  return { definition, redirects };
}

const rechargeNavigation = submissionPageHarness(recharge);
rechargeNavigation.definition.data.refund = false;
rechargeNavigation.definition.openSubmittedOrder.call(rechargeNavigation.definition, { rechargeId: "31", rechargeCode: "RC31", rechargeType: "NEW" }, { clientRequestId: "request_recharge_31" });
rechargeNavigation.definition.openSubmittedOrder.call(rechargeNavigation.definition, { rechargeId: "32", rechargeCode: "RF32", rechargeType: "REFUND" }, { clientRequestId: "request_refund_32" });
assert.deepEqual(rechargeNavigation.redirects, [
  "/pages/order-detail/index?type=recharge&category=RECHARGE&recordId=31&recordCode=RC31&submissionClientRequestId=request_recharge_31",
  "/pages/order-detail/index?type=recharge&category=REFUND&recordId=32&recordCode=RF32&submissionClientRequestId=request_refund_32"
]);

const verificationNavigation = submissionPageHarness(verification);
verificationNavigation.definition.data.experience = false;
verificationNavigation.definition.openSubmittedOrder.call(verificationNavigation.definition, { verificationId: "41", verificationCode: "VE41", verificationType: "NORMAL" }, { clientRequestId: "request_verification_41" });
verificationNavigation.definition.openSubmittedOrder.call(verificationNavigation.definition, { verificationId: "42", verificationCode: "EX42", verificationType: "EXPERIENCE" }, { clientRequestId: "request_experience_42" });
assert.deepEqual(verificationNavigation.redirects, [
  "/pages/order-detail/index?type=verification&category=VERIFICATION&recordId=41&recordCode=VE41&submissionClientRequestId=request_verification_41",
  "/pages/order-detail/index?type=verification&category=EXPERIENCE&recordId=42&recordCode=EX42&submissionClientRequestId=request_experience_42"
]);

const orderDetail = read("pages", "order-detail", "index.js");
assert.match(orderDetail, /function exactOrderKind/);
assert.match(orderDetail, /exact === "EXPERIENCE" \? "体验核销" : "核销"/);
assert.match(orderDetail, /exact === "REFUND" \? "退费" : "充值"/);
assert.match(orderDetail, /submission\.acknowledge\(this\.data\.baseType, this\.data\.recordId, this\.data\.submissionClientRequestId\)/);
assert.match(read("pages", "order-detail", "index.wxml"), /baseType === 'RECHARGE' \|\| order\.originalType === 'SUPPLEMENT'/,
  "normal and experience verification records must not render a review time");

const photo = read("pages", "customer-detail", "index.js");
const photoAlbum = read("services", "photo-album.js");
assert.match(photo, /photoFailed\(\).*photoUrl: ""/s);
assert.doesNotMatch(photo, /saveImageToAlbum|savePhoto|reloadPhoto/);
assert.match(photoAlbum, /saveImageToPhotosAlbum/);
assert.doesNotMatch(read("pages", "customer-detail", "index.wxml"), /重读原图|保存到相册|bindtap="savePhoto"|bindtap="reloadPhoto"/);

// Execute the idempotency helper with isolated wx/session/callFunction mocks.
const submissionSource = read("services", "submission.js");
const storage = new Map();
let recovered = { ok: true, found: false, complete: false };
const sandbox = {
  module: { exports: {} }, exports: {}, Date, Math,
  wx: {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key)
  },
  require(id) {
    if (id === "./api") return { callFace: async (action, payload) => { assert.equal(action, "recoverBusinessSubmission"); assert.ok(payload.clientRequestId); return recovered; } };
    if (id === "./session") return { readSession: () => ({ uid: "uid-test" }) };
    throw new Error(`unexpected require ${id}`);
  }
};
vm.runInNewContext(submissionSource, sandbox, { filename: "submission.js" });
const guard = sandbox.module.exports;
const first = guard.begin("RECHARGE", { storeId: "7", unitCount: 10 });
const replay = guard.begin("RECHARGE", { storeId: "7", unitCount: 10 });
assert.equal(first.clientRequestId, replay.clientRequestId, "same unresolved payload must reuse the original idempotency key");
assert.throws(() => guard.begin("RECHARGE", { storeId: "7", unitCount: 11 }), /\u4e0a一次提交结果尚未确认/);
guard.markUncertain("RECHARGE");
assert.equal(guard.read("RECHARGE").state, "UNCERTAIN");
guard.recover("RECHARGE").then((missing) => {
  assert.equal(missing.found, false);
  assert.equal(guard.read("RECHARGE").clientRequestId, first.clientRequestId, "an uncertain missing result must remain locked");
  recovered = { ok: true, found: true, complete: true, rechargeId: "99" };
  return guard.recover("RECHARGE");
}).then((result) => {
  assert.equal(result.rechargeId, "99");
  assert.ok(guard.read("RECHARGE"), "complete recovery must retain the lock until the detail page acknowledges the exact order");
  const confirmed = guard.confirm("RECHARGE", result.rechargeId);
  assert.equal(confirmed.state, "CONFIRMED");
  assert.equal(guard.acknowledge("RECHARGE", "98", confirmed.clientRequestId), false, "another order cannot clear the lock");
  assert.ok(guard.read("RECHARGE"));
  assert.equal(guard.acknowledge("RECHARGE", "99", confirmed.clientRequestId), true, "the exact detail read can acknowledge the submission");
  assert.equal(guard.read("RECHARGE"), null, "the exact detail acknowledgement clears the local lock");
  console.log("mini-program contract tests passed");
}).catch((error) => { console.error(error); process.exitCode = 1; });
