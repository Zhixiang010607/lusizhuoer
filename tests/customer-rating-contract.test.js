"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
const publicCss = read("rating.css");
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

test("customerRating v7 keeps public links signed, stable, scoped, and one-time", () => {
  assert.match(cloud, /const FUNCTION_VERSION = "v7"/);
  assert.match(cloud, /CUSTOMER_RATING_SIGNING_KEY/);
  assert.match(cloud, /缺少 CUSTOMER_RATING_BASE_URL/);
  assert.match(cloud, /Buffer\.byteLength\(value, "utf8"\) >= 32/);
  assert.match(cloud, /createHmac\("sha256", ratingSigningKey\(\)\)/);
  assert.match(cloud, /timingSafeEqual/);
  assert.match(cloud, /createHash\("sha256"\)\.update\(token, "utf8"\)\.digest\("hex"\)/);
  assert.doesNotMatch(cloud, /verified_at/,
    "rating eligibility must use the real approved work-order status, not the retired draft field");

  const issuePolicy = functionBody(cloud, "canIssueRating", "getForStaff");
  assert.match(issuePolicy, /staff\.role_code === "hq"/);
  assert.match(issuePolicy, /staff\.role_code === "store"/);
  assert.doesNotMatch(issuePolicy, /staff\.role_code === "teacher"/);
  const issue = functionBody(cloud, "issueForReceipt", "publicRow");
  assert.match(issue, /!canIssueRating\(staff, order\)/);
  assert.match(issue, /仅总部或工单所属门店可以生成评价二维码/);
  assert.match(issue, /order\.record_status !== "APPROVED"/);
  assert.match(issue, /signedRatingToken\(rating\)/,
    "repeat exports must derive the same token from the rating id and token version");
  assert.match(issue, /publicUrl\.searchParams\.set\("token", token\)/,
    "configured rating page queries and fragments must receive the token safely");
  assert.match(issue, /ON CONFLICT \(verification_id\) DO NOTHING/);
  assert.match(issue, /RETURNING id, verification_id, store_id, teacher_id, token_version,[\s\S]*rating_status, submitted_at AS rating_submitted_at/,
    "the first export should use the insert row whenever CloudBase exposes it");
  assert.match(issue, /rating = created\[0\] \|\| await readRatingAfterWrite\(verificationId\)/,
    "an empty CloudBase RETURNING envelope must fall back to bounded durable readback");
  assert.match(cloud, /const DURABLE_READ_DELAYS_MS = Object\.freeze\(\[0, 25, 75, 150, 300\]\)/);
  assert.match(cloud, /r\.token_hash, r\.rating_status/,
    "post-write confirmation must read the persisted token digest");
  assert.match(issue, /String\(row\.token_hash \|\| ""\) === tokenHash/,
    "an empty UPDATE RETURNING envelope must be accepted only after exact token readback");
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
  assert.match(submit, /readRatingAfterWrite\(row\.verification_id/,
    "an empty UPDATE RETURNING envelope must trigger bounded durable readback");
  assert.match(submit, /String\(candidate\.token_hash \|\| ""\) === String\(result\.verified\.tokenHash\)/,
    "submit readback must confirm the exact signed token digest");

  const publicRead = functionBody(cloud, "publicRow", "getPublic");
  assert.match(publicRead, /JOIN public\.products p ON p\.id = vr\.product_id/,
    "the public rating context must resolve the service project from the bound work order");
  assert.match(publicRead, /TO_CHAR\(vr\.submitted_at AT TIME ZONE 'Asia\/Shanghai', 'YYYY-MM-DD HH24:MI'\) AS service_time/,
    "the service time must use the Shanghai business timezone");
  assert.match(cloud, /projectName: row\?\.product_name \|\| ""/);
  assert.match(cloud, /serviceTime: row\?\.service_time \|\| ""/);
});

test("customerRating v7 issues an HQ QR when CloudBase commits writes with empty RETURNING rows", async () => {
  let rating = null;
  let pendingSubmission = null;
  let ratingReadsAfterInsert = 0;
  let submissionReadbacks = 0;
  const sqlResult = (row) => row
    ? { Columns: Object.keys(row), Rows: [Object.values(row)] }
    : { Columns: [], Rows: [] };
  const executePGSql = async ({ Sql }) => {
    if (Sql.includes("information_schema.columns")) {
      return sqlResult({ has_store_account_id: true, has_staff_store_assignments: false });
    }
    if (Sql.includes("FROM public.staff_accounts a")) {
      return sqlResult({ id: "7", role_code: "hq", account_status: "ACTIVE", store_id: null, store_status: null, teacher_id: null, teacher_status: null });
    }
    if (Sql.includes("FROM public.verification_customer_ratings r")) {
      if (pendingSubmission && submissionReadbacks++ > 0) {
        rating = pendingSubmission;
        pendingSubmission = null;
      }
      if (rating && ratingReadsAfterInsert++ === 0) return sqlResult(null);
      return sqlResult(rating);
    }
    if (Sql.includes("FROM public.verification_records vr")) {
      return sqlResult({
        id: "42", store_id: "3", teacher_id: "5", verification_type: "NORMAL",
        record_status: "APPROVED", order_submitted_at: "2026-09-02T00:00:00Z",
        store_name: "测试门店", teacher_name: "测试老师", product_name: "测试项目",
        service_time: "2026-09-02 08:00"
      });
    }
    if (Sql.includes("INSERT INTO public.verification_customer_ratings")) {
      rating = {
        id: "901", verification_id: "42", store_id: "3", teacher_id: "5", token_version: 1,
        token_hash: "placeholder", rating_status: "OPEN", rating_submitted_at: null,
        verification_type: "NORMAL", record_status: "APPROVED",
        order_submitted_at: "2026-09-02T00:00:00Z", store_name: "测试门店", teacher_name: "测试老师",
        product_name: "测试项目", service_time: "2026-09-02 08:00"
      };
      return sqlResult(null);
    }
    if (Sql.includes("UPDATE public.verification_customer_ratings") && Sql.includes("SET token_hash")) {
      const tokenHash = /SET token_hash = '([0-9a-f]{64})'/.exec(Sql)?.[1];
      assert.ok(tokenHash, "token update must persist a SHA-256 digest");
      rating = { ...rating, token_hash: tokenHash };
      return sqlResult(null);
    }
    if (Sql.includes("UPDATE public.verification_customer_ratings") && Sql.includes("SET store_environment_score")) {
      assert.match(Sql, /store_environment_score = 5/);
      assert.match(Sql, /teacher_service_score = 4/);
      assert.match(Sql, /overall_experience_score = 3/);
      assert.match(Sql, /customer_comment = '服务很好'/);
      pendingSubmission = {
        ...rating,
        rating_status: "SUBMITTED", rating_submitted_at: "2026-09-02T00:30:00Z",
        store_environment_score: 5, teacher_service_score: 4,
        overall_experience_score: 3, customer_comment: "服务很好"
      };
      return sqlResult(null);
    }
    throw new Error(`unexpected SQL in customerRating runtime test: ${Sql}`);
  };
  const module = { exports: {} };
  const sandbox = {
    Buffer,
    URL,
    console: { error() {} },
    exports: module.exports,
    module,
    process: {
      env: {
        CLOUDBASE_ENV_ID: "test-env",
        CUSTOMER_RATING_SIGNING_KEY: "test-signing-key-with-more-than-32-bytes",
        CUSTOMER_RATING_BASE_URL: "https://example.test/rating.html"
      }
    },
    require(name) {
      if (name === "node:crypto") return require("node:crypto");
      if (name === "@cloudbase/node-sdk") {
        return { init: () => ({ auth: () => ({ getUserInfo: () => ({ uid: "hq-auth-uid" }) }) }) };
      }
      if (name === "@cloudbase/manager-node") {
        return { init: () => ({ database: { executePGSql } }) };
      }
      if (name === "qrcode") {
        return { toDataURL: async () => "data:image/png;base64,dGVzdA==" };
      }
      throw new Error(`unexpected dependency: ${name}`);
    },
    setTimeout
  };
  vm.runInNewContext(cloud, sandbox, { filename: "cloudfunctions/customerRating/index.js" });
  const result = await module.exports.main({ action: "issueForReceipt", verificationId: "42" });
  assert.equal(result.success, true);
  assert.equal(result.version, "v7");
  assert.equal(result.data.alreadySubmitted, false);
  assert.equal(result.data.qrDataUrl, "data:image/png;base64,dGVzdA==");
  assert.match(result.data.url, /^https:\/\/example\.test\/rating\.html\?token=/);
  assert.equal(ratingReadsAfterInsert >= 2, true, "the empty insert response must trigger durable read retries");

  const token = new URL(result.data.url).searchParams.get("token");
  const submitted = await module.exports.main({
    action: "submitPublic", token,
    storeEnvironmentScore: 5, teacherServiceScore: 4, overallExperienceScore: 3,
    customerComment: "服务很好"
  });
  assert.equal(submitted.success, true);
  assert.equal(submitted.data.submitted, true);
  assert.equal(submitted.data.storeEnvironmentScore, 5);
  assert.equal(submitted.data.teacherServiceScore, 4);
  assert.equal(submitted.data.overallExperienceScore, 3);
  assert.equal(submitted.data.customerComment, "服务很好");
  assert.equal(submissionReadbacks >= 2, true,
    "an empty submit RETURNING envelope must retry until the durable rating is visible");
});

test("public rating page shows service context, three star groups, and scrollable optional text without staff login", () => {
  for (const label of ["服务项目", "服务时间", "门店环境", "老师服务", "整体体验", "想对我们说的话"]) {
    assert.ok(publicHtml.includes(label), `public rating page missing ${label}`);
  }
  assert.equal((publicHtml.match(/class="star-picker" role="radiogroup"/g) || []).length, 3);
  assert.match(publicHtml, /maxlength="500"/);
  assert.match(publicHtml, /cloudbase\.auth\.js/);
  assert.match(publicJs, /for \(let score = 1; score <= 5; score \+= 1\)/);
  assert.match(publicJs, /auth\.getLoginState\(\)/);
  assert.match(publicJs, /auth\.anonymousAuthProvider\(\)\.signIn\(\)/);
  assert.match(publicJs, /callRating\("submitPublic"/);
  assert.match(publicJs, /ratingProjectName"\)\.textContent = data\.projectName/);
  assert.match(publicJs, /ratingServiceTime"\)\.textContent = data\.serviceTime/);
  assert.match(publicJs, /teacherRatingQuestion"\)\.hidden = !data\.requiresTeacherScore/);
  assert.doesNotMatch(publicHtml, /本次评价已经提交|老师、门店和总部可以在对应工单中查看/,
    "the completed customer page keeps only the result and removes redundant staff-facing instructions");
  assert.match(publicHtml, /rating\.css\?v=0\.1\.2/);
  assert.match(publicHtml, /rating\.js\?v=0\.1\.2/);
  assert.match(publicCss, /\.rating-comment textarea \{[\s\S]*height: 132px;[\s\S]*max-height: 132px;[\s\S]*overflow-y: auto;[\s\S]*resize: none;/,
    "long comments must scroll vertically inside a stable-height textarea");
  assert.doesNotMatch(publicJs, /auth-ui|location\.href\s*=\s*["']login/,
    "customer QR page must not redirect anonymous customers to staff login");
});

test("web work-order detail shows ratings while HQ and store exports request a QR", () => {
  assert.match(webHtml, /id="customerRatingPanel"[\s\S]*id="customerRatingBody"/);
  assert.ok(webHtml.indexOf('id="customerRatingPanel"') > webHtml.indexOf('id="verificationPhotoPanel"'),
    "customer rating must be appended at the bottom of the work-order content");
  assert.match(webDetail, /body\.textContent = "暂无评价"/);
  assert.match(webDetail, /!\["NORMAL", "EXPERIENCE"\]\.includes\(verificationKind\)/,
    "legacy supplement records must show no rating instead of a service error");
  assert.match(webDetail, /"★"\.repeat\(value\)/);
  assert.match(webDetail, /rating\.customerComment/);
  const exportBody = functionBody(webDetail, "exportCurrentOrder", "isVoidableOriginalType");
  assert.match(exportBody, /\["store", "hq"\]\.includes\(clean\(readSession\(\)\?\.role\)\.toLowerCase\(\)\)/);
  assert.match(exportBody, /\["NORMAL", "EXPERIENCE"\]\.includes/);
  assert.match(exportBody, /callCustomerRating\("issueForReceipt"/);
  assert.doesNotMatch(exportBody, /\["store", "hq", "teacher"\]/,
    "teacher export paths must never issue a QR");
  assert.match(webReceipt, /if \(!ratingQr\?\.enabled\) return y/);
  assert.match(webReceipt, /if \(!source\) return \{ enabled: false, image: null \}/);
});

test("mini-program phone and iPad detail use the same HQ/store QR contract", () => {
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
  assert.match(exportBody, /\["store", "hq"\]\.includes\(clean\(this\.data\.session\?\.role\)\.toLowerCase\(\)\)/);
  assert.match(exportBody, /\["NORMAL", "EXPERIENCE"\]\.includes/);
  assert.match(exportBody, /callRating\("issueForReceipt"/);
  assert.doesNotMatch(exportBody, /\["store", "hq", "teacher"\]/,
    "teacher mini-program exports must never issue a QR");
  assert.match(miniReceipt, /if \(!ratingQr\?\.enabled\) return y/);
  assert.match(miniReceipt, /if \(!source\) return \{ enabled: false, image: null \}/);
});
