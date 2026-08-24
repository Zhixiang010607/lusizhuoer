const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");

const app = JSON.parse(read("app.json"));
for (const page of ["login", "home", "customers", "customer-detail", "customer-create", "recharge", "verification"]) {
  assert.ok(app.pages.includes(`pages/${page}/index`), `missing mini-program page ${page}`);
  for (const extension of ["js", "json", "wxml", "wxss"]) assert.ok(fs.existsSync(path.join(mini, "pages", page, `index.${extension}`)), `${page}.${extension} missing`);
}

const allClientSource = [...fs.readdirSync(path.join(mini, "services")).map((file) => read("services", file)),
  ...app.pages.map((page) => read(`${page}.js`)), read("config", "env.js")].join("\n");
for (const forbidden of ["FACE_SECRET_ID", "FACE_SECRET_KEY", "CLOUDBASE_APIKEY", "PGPASSWORD", "ExecutePGSql", "SELECT * FROM", "INSERT INTO public."]) {
  assert.ok(!allClientSource.includes(forbidden), `client must not contain ${forbidden}`);
}
for (const wxml of app.pages.map((page) => read(`${page}.wxml`))) assert.doesNotMatch(wxml, /<\/?(?:small|div|span|p)(?:\s|>)/, "WXML must use mini-program built-in elements");

const session = read("services", "session.js");
assert.match(session, /signInWithPassword\(\{ phone, password \}\)/);
assert.match(session, /callStaff\("session", \{ phone \}\)/);
assert.match(session, /String\(staff\.uid \|\|/);
assert.match(session, /if \(session\.role === "store" && !session\.storeId\)/);

const home = read("pages", "home", "index.wxml");
assert.match(home, /wx:if="\{\{session\.role !== 'hq'\}\}" class="card"/);
assert.match(home, /session\.role === 'teacher'.*EXPERIENCE/s);

const customerCreate = read("pages", "customer-create", "index.js");
assert.ok(customerCreate.indexOf('callFace("validateCapture"') < customerCreate.indexOf('callFace("registerCustomer"'));
assert.match(customerCreate, /if \(!code\) throw new Error/);

const recharge = read("pages", "recharge", "index.js");
for (const token of ["listActiveProducts", "getCustomerProductBalances", "listActiveTeachers", "createRechargeApplication", "recoverBusinessSubmission"]) assert.ok(recharge.includes(token) || read("services", "submission.js").includes(token));
assert.ok(recharge.indexOf('submission.begin("RECHARGE"') < recharge.indexOf('callFace("createRechargeApplication"'));
assert.match(recharge, /submission\.markUncertain\("RECHARGE"\)/);

const verification = read("pages", "verification", "index.js");
for (const token of ["getTeacherExperienceEntitlements", "getCustomerProductBalances", "verifyCustomerFace", "createVerificationApplication"]) assert.ok(verification.includes(token));
assert.match(verification, /experience && session\.role !== "teacher"/);
assert.match(verification, /verificationType: this\.data\.experience \? "EXPERIENCE" : "NORMAL"/);
assert.ok(verification.indexOf('callFace("verifyCustomerFace"') < verification.indexOf('callFace("createVerificationApplication"'));
assert.ok(verification.indexOf('submission.begin("VERIFICATION"') < verification.indexOf('callFace("createVerificationApplication"'));
assert.doesNotMatch(verification, /verifyTeacherFace|identifyFace|SearchPersons|1:N/);

const photo = read("pages", "customer-detail", "index.js");
assert.match(photo, /photoFailed\(\).*photoUrl: ""/s);
assert.match(photo, /saveImageToPhotosAlbum/);
assert.doesNotMatch(read("pages", "customer-detail", "index.wxml"), /binderror="reloadPhoto"/);

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
  assert.equal(guard.read("RECHARGE"), null, "complete database recovery must clear the local lock");
  console.log("mini-program contract tests passed");
}).catch((error) => { console.error(error); process.exitCode = 1; });
