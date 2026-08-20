"use strict";

// Contract coverage for the teacher-owned experience allowance.  This test is
// intentionally source-level: CloudBase PostgreSQL is not available in the
// local test runner, while the safety properties must remain visible in the
// deployable migration and cloud-function code.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const migrationDir = path.join(root, "database", "migrations");
const consoleDir = path.join(root, "database", "cloudbase-console");

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  let depth = 0;
  for (let index = signatureEnd + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

function sqlFunction(source, name) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `SQL function ${name} must exist`);
  const end = source.indexOf("\n$$;", start);
  assert.ok(end > start, `SQL function ${name} must have a closed dollar-quoted body`);
  return source.slice(start, end + 4);
}

// Keep the migration discoverable rather than baking its full descriptive
// filename into the contract.  Its next numeric slot is nevertheless part of
// the release sequence and must ship with CloudBase-editor-sized parts.
const migrationFiles = fs.readdirSync(migrationDir)
  .filter((file) => /^046_.*teacher.*experience.*\.sql$/i.test(file));
assert.equal(migrationFiles.length, 1, "migration 046 must be the single canonical teacher-experience migration");
const migrationFilename = migrationFiles[0];
const migration = read(path.join("database", "migrations", migrationFilename));
const lifecycleMigration = read("database/migrations/048_optional_teacher_face_and_experience_quota_lifecycle.sql");
const consoleParts = fs.readdirSync(consoleDir).filter((file) => /^046-.*\.sql$/i.test(file));
assert.ok(consoleParts.length > 0, "migration 046 must include CloudBase SQL-editor deployment parts");
for (const part of consoleParts) {
  const source = read(path.join("database", "cloudbase-console", part));
  assert.match(source, /BEGIN;[\s\S]*COMMIT;\s*$/, `${part} must be a standalone transaction`);
  assert.ok(Buffer.byteLength(source, "utf8") < 9000, `${part} must remain CloudBase-editor safe`);
}

// A teacher may configure each active product exactly once.  The current
// period and remaining counter live in the database, so a duplicated browser
// submit cannot create a second allowance row.
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.teacher_[a-z_]*experience[a-z_]*/i,
  "migration must introduce teacher-owned experience allowance storage");
assert.match(migration, /UNIQUE\s*\(\s*teacher_id\s*,\s*product_id\s*\)/i,
  "one teacher may configure one product only once");
assert.match(migration, /monthly[a-z_]*count|monthly[a-z_]*quota|monthly[a-z_]*limit/i,
  "allowance must retain a monthly configured count");
assert.match(migration, /remaining[a-z_]*count|remaining[a-z_]*quota|remaining[a-z_]*limit/i,
  "allowance must retain a separately mutable remaining count");
assert.match(migration, /date_trunc\s*\(\s*'month'/i,
  "the database must reset an expired allowance to the new calendar month without browser input");
assert.match(migration, /Asia\/Shanghai/i,
  "monthly reset must use the application's business time zone");
assert.match(migration, /FOR UPDATE/i,
  "experience consumption must lock the allowance row before checking and decrementing it");
assert.match(migration, /(?:remaining|available)[a-z_]*(?:\s*=|\s*-)/i,
  "experience consumption must decrement remaining allowance in the database");
assert.match(migration, /insufficient[^\n;]*experience|体验次数[^\n;]*不足/i,
  "exhausted teacher experience allowance must be rejected by the database");

// Teacher add-on/recharge records are a distinct append-only business ledger;
// they must never be represented by customer recharge rows.
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.teacher_[a-z_]*(?:experience_)?(?:recharge|topup|adjustment)[a-z_]*/i,
  "teacher experience recharge must have its own audit table");
assert.doesNotMatch(migration, /INSERT INTO public\.recharge_records[\s\S]*teacher[_ ]experience/i,
  "teacher experience recharge must not reuse customer recharge records");

// A teacher account must own one usable teacher profile even on the deployed
// incremental sequence (not just after a destructive schema rebuild).  Face
// enrollment is retained as an identifier/consent timestamp, never image data.
assert.match(migration, /teacher[_ ]face[_ ]person[_ ]id|face_person_id/i,
  "teacher profile must persist the bound face-library person identifier");
assert.match(migration, /teacher[_ ]face[_ ]consent|face_consent_at/i,
  "teacher profile must record explicit face-binding consent/time");
assert.match(migration, /CREATE(?: OR REPLACE)? FUNCTION public\.[a-z_]*teacher[a-z_]*profile/i,
  "incremental deployment must define a teacher-profile synchronization function");
assert.match(migration, /CREATE TRIGGER\s+trg_[a-z_]*teacher[a-z_]*profile/i,
  "incremental deployment must install a teacher-profile synchronization trigger");
assert.match(migration, /INSERT INTO public\.teachers/i,
  "existing teacher accounts must be backfilled into teacher profiles");
assert.match(migration, /ALTER TABLE public\.teachers ALTER COLUMN %I DROP NOT NULL/i,
  "incremental deployment must release legacy uncollected teacher identity fields before face-only provisioning");
assert.match(migration, /ON CONFLICT \(staff_account_id\) DO UPDATE/i,
  "teacher profile bridge must reuse the deployed unique staff-account binding rather than create duplicate teachers");
assert.match(migration, /DROP TRIGGER IF EXISTS trg_sync_teacher_account_status ON public\.teachers[\s\S]{0,500}CREATE TRIGGER trg_sync_teacher_account_status[\s\S]{0,220}face_enrollment_status/i,
  "migration must replace the legacy teacher-status trigger with one that also protects face enrollment");

// The atomic verification function is the final authority.  Preliminary API
// checks are useful for messages, but a status can change between them and the
// insert, so the database function itself must reject every archived master
// record and only consume allowance for EXPERIENCE.
assert.match(migration, /verification_type[^\n]*EXPERIENCE|normalized_type[^\n]*EXPERIENCE/i,
  "migration must patch the atomic verification path for EXPERIENCE");
for (const [entity, status] of [
  ["stores", "store_status"],
  ["teachers", "teacher_status"],
  ["products", "product_status"],
  ["customers", "customer_status"]
]) {
  assert.match(migration, new RegExp(`FROM public\\.${entity}[\\s\\S]{0,120}${status}\\s*=\\s*'ACTIVE'`, "i"),
    `atomic verification must reject an archived ${entity.slice(0, -1)}`);
}

const atomicExperienceVerification = sqlFunction(migration, "create_verification_with_face_photo");
assert.ok(Buffer.byteLength(atomicExperienceVerification, "utf8") < 8800,
  "the atomic verification function must fit a CloudBase SQL-editor-safe 046 deployment part; extract helpers instead of splitting a dollar-quoted function body");
assert.match(atomicExperienceVerification, /lock_active_verification_subjects\(/,
  "the slimmed atomic verification function must retain master-data locking through its same-transaction helper");
const lockedSubjects = sqlFunction(migration, "lock_active_verification_subjects");
assert.match(lockedSubjects, /store_status\s*=\s*'ACTIVE'[\s\S]{0,160}FOR SHARE/i,
  "verification master-lock helper must still reject an archived store at write time");
assert.match(atomicExperienceVerification, /normalized_type\s*=\s*'EXPERIENCE'[\s\S]{0,1000}teacher_product_experience_quotas[\s\S]{0,800}FOR UPDATE/i,
  "EXPERIENCE must lock the teacher quota in the same database transaction");
assert.match(atomicExperienceVerification, /quota\.available_count\s*<\s*1[\s\S]{0,300}insufficient teacher experience quota/i,
  "exhausted experience allowance must reject before any verification row is created");
assert.match(atomicExperienceVerification, /SET available_count\s*=\s*available_count\s*-\s*1[\s\S]{0,300}used_count\s*=\s*used_count\s*\+\s*1/i,
  "EXPERIENCE must atomically debit one teacher allowance unit");
assert.match(atomicExperienceVerification, /INSERT INTO public\.teacher_experience_quota_usages/i,
  "each successful experience verification must write a quota-usage link");
assert.doesNotMatch(atomicExperienceVerification, /customer_product_balances/i,
  "experience verification must not update customer purchased-unit balances");

// Migration 048 is the effective live policy. It deliberately removes face
// enrollment from activation, selection and quota use, while retaining the
// face fields for later consented enrollment/replacement.
assert.match(lifecycleMigration, /ADD COLUMN IF NOT EXISTS quota_status VARCHAR\(16\) NOT NULL DEFAULT 'ACTIVE'/,
  "048 must mark live quota configurations separately from archived history");
assert.match(lifecycleMigration, /CHECK \(quota_status IN \('ACTIVE', 'ARCHIVED'\)\)/,
  "048 must only allow active or archived quota lifecycle states");
const lifecycleSubjects = sqlFunction(lifecycleMigration, "assert_active_teacher_experience_subjects");
assert.match(lifecycleSubjects, /teacher_status = 'ACTIVE'[\s\S]{0,240}account_status = 'ACTIVE'/,
  "quota configuration/recharge must require an active teacher account");
assert.doesNotMatch(lifecycleSubjects, /face_enrollment_status|face_person_id/i,
  "teacher face enrollment must not gate quota configuration or recharge");
const lifecycleVerificationLock = sqlFunction(lifecycleMigration, "lock_active_verification_subjects");
assert.match(lifecycleVerificationLock, /teacher_status = 'ACTIVE'[\s\S]{0,320}account_status = 'ACTIVE'/,
  "effective verification lock must retain active-teacher protection");
assert.doesNotMatch(lifecycleVerificationLock, /face_enrollment_status|face_person_id/i,
  "effective verification lock must permit an active teacher without a face");
const lifecycleUpsert = sqlFunction(lifecycleMigration, "upsert_teacher_product_experience_quota");
assert.match(lifecycleUpsert, /available_count = p_monthly_allowance[\s\S]{0,220}used_count = 0[\s\S]{0,180}manual_recharge_count = 0/i,
  "saving an allowance must immediately replace the available count and reset current-period counters");
assert.match(lifecycleUpsert, /quota_status = 'ACTIVE'[\s\S]{0,280}archived_at = NULL/i,
  "reconfiguring a removed product must reactivate its audit lineage");
const lifecycleDelete = sqlFunction(lifecycleMigration, "delete_teacher_product_experience_quota");
assert.match(lifecycleDelete, /SET quota_status = 'ARCHIVED'/,
  "removing a configured product must archive rather than delete it");
assert.match(lifecycleDelete, /event_type, monthly_allowance[\s\S]{0,360}'REMOVED'/,
  "removing a product must retain a configuration-event audit record");
const lifecycleReset = sqlFunction(lifecycleMigration, "reset_teacher_experience_quotas");
assert.match(lifecycleReset, /quota_status = 'ACTIVE'[\s\S]{0,520}teacher_status = 'ACTIVE'[\s\S]{0,300}product_status = 'ACTIVE'/,
  "monthly reset must process active quota rows for active teachers and products only");

const customerBalanceMigration = read("database/migrations/044_refund_application_workflow.sql");
const customerBalanceRefresh = sqlFunction(customerBalanceMigration, "refresh_customer_balance");
assert.match(customerBalanceRefresh, /verification_totals AS \([\s\S]{0,300}verification_type IN \('NORMAL', 'SUPPLEMENT'\)/i,
  "the purchased-unit balance ledger must exclude EXPERIENCE even though customer history may count it");

const faceCloud = read("cloudfunctions/faceRecognition/index.js");
const staffCloud = read("cloudfunctions/staffAccount/index.js");
const phoneAuth = read("cloudbase-phone-auth.js");
const businessUi = read("store-business.js");
const staffDetailUi = read("staff-detail.js");
const teacherCreate = read("teacher-create.html");
const teacherCreateScript = read("teacher-create.js");
const staffReadme = read("cloudfunctions/staffAccount/README.md");
const analytics = functionSource(faceCloud, "storeAnalyticsEventCte");
const hqDashboard = functionSource(staffCloud, "getHqDashboard");
const verificationCreate = functionSource(faceCloud, "createVerificationApplication");
const teacherProvision = functionSource(staffCloud, "provisionTeacherWithFace");
const delegatedTeacherFaceUpsert = functionSource(faceCloud, "upsertDelegatedTeacherFace");
const hqEntitlementRead = functionSource(staffCloud, "getHqTeacherExperienceEntitlements");
const entitlementUpsert = functionSource(staffCloud, "upsertTeacherExperienceEntitlement");
const entitlementDelete = functionSource(staffCloud, "deleteTeacherExperienceEntitlement");
const entitlementRecharge = functionSource(staffCloud, "rechargeTeacherExperienceEntitlement");
const monthlyResetTimer = functionSource(staffCloud, "handleTrustedTeacherExperienceResetTimer");
const teacherFaceUpsert = functionSource(staffCloud, "upsertTeacherFace");
const optionalFaceActivationSchema = functionSource(staffCloud, "requireTeacherOptionalFaceActivationSchema");

includes(verificationCreate, 'verificationType === "EXPERIENCE"',
  "verification API must branch explicitly for teacher-owned experience allowance");
assert.match(faceCloud, /getTeacher[a-zA-Z]*Experience|TeacherExperience[a-zA-Z]*Quota/i,
  "experience workflow must expose a server-side teacher-product allowance reader");
assert.match(faceCloud, /if \(action === "getTeacher[a-zA-Z]*Experience|if \(action === "getTeacherExperience/i,
  "teacher experience allowance reader must be dispatched by the face service");

// The experience page must load product options from the selected teacher's
// allowance, not customer_product_balances.  The normal page intentionally
// continues to use customer balances.
assert.match(businessUi, /experiencePage[\s\S]{0,800}teacher[a-zA-Z]*Experience/i,
  "experience UI must branch to teacher-owned allowance data");
assert.match(businessUi, /verificationTeacher[\s\S]{0,800}experience/i,
  "changing the selected teacher must refresh experience product options");
assert.match(businessUi, /loadVerificationBalances\(selectedCustomer\)/,
  "normal verification must retain customer balance lookup");
assert.match(businessUi, /if \(page === "verification"\) \{[\s\S]{0,180}loadVerificationBalances\(selectedCustomer\)[\s\S]{0,120}\}\s*if \(page === "verification-experience"\) \{[\s\S]{0,180}loadTeacherExperienceEntitlements\(\)/,
  "normal and experience verification must take mutually exclusive balance-loading paths");
assert.match(functionSource(businessUi, "loadTeacherExperienceEntitlements"), /callCustomerEnrollment\(\{ action: "getTeacherExperienceEntitlements", teacherId \}\)/,
  "experience allowance lookup must use the face service's active-business authorization path");
assert.doesNotMatch(functionSource(faceCloud, "getTeacherExperienceEntitlements"), /customer_product_balances/i,
  "the active experience-product reader must not consult customer purchased-unit balances");
assert.match(verificationCreate, /TEACHER_EXPERIENCE_QUOTA_EXHAUSTED/,
  "the verification endpoint must surface an exhausted teacher quota distinctly from customer balance exhaustion");

assert.match(teacherCreate, /face|人脸/i, "teacher creation UI must require face enrollment");
assert.match(teacherCreateScript, /teacher[a-zA-Z]*(?:Face|face)|face[a-zA-Z]*teacher/i,
  "teacher creation submitter must pass face enrollment evidence to the server");
assert.match(teacherCreateScript, /action:\s*[\"']validateTeacherFaceEnrollmentCapture[\"']/,
  "teacher face preflight must use the dedicated HQ-only validation action");
assert.doesNotMatch(teacherCreateScript, /action:\s*[\"']validateCapture[\"']/,
  "teacher face preflight must not reuse the store-scoped validation action");
assert.match(staffCloud, /teacher[a-zA-Z]*(?:Face|face)|face[a-zA-Z]*teacher/i,
  "staff service must validate teacher face enrollment before provisioning succeeds");
assert.match(staffCloud, /if \(role === "teacher"\)[\s\S]{0,180}fail\(/,
  "generic staff provisioning must reject teacher creation so face binding cannot be bypassed");
assert.match(staffCloud, /if \(action === "provisionTeacherWithFace"\)[\s\S]{0,120}requireHq\(caller\)/,
  "dedicated teacher provisioning must be headquarters-only");
assert.match(teacherProvision, /event\.consent\s*===\s*true/,
  "teacher provisioning must require explicit consent server-side");
assert.match(teacherProvision, /teacherFaceImage\(event\.faceImageBase64\)/,
  "teacher provisioning must validate the submitted face image server-side");
assert.match(teacherProvision, /userStatus:\s*"BLOCKED"/,
  "a teacher authentication account must start blocked before face enrollment completes");
assert.match(teacherProvision, /initialAccountStatus:\s*"ARCHIVED"/,
  "a teacher business account must start archived before face enrollment completes");
assert.match(teacherProvision, /delegateTeacherFace\(\{[\s\S]{0,220}operation:\s*"PROVISION"/,
  "teacher provisioning must delegate face-library and private-photo work to the signed server workflow");
assert.match(teacherProvision, /face_person_id\s*=\s*\$\{sqlText\(facePersonId\)\}[\s\S]{0,240}face_enrollment_status\s*=\s*'ENROLLED'[\s\S]{0,180}profile_photo_file_id/,
  "teacher provisioning must prove the exact person, ENROLLED state and retained photo before activation");
assert.match(teacherProvision, /manager\(\)\.user\.modifyUser\(\{ uid, userStatus: "ACTIVE"/,
  "teacher authentication may activate only after the enrolled database profile is persisted");
assert.match(delegatedTeacherFaceUpsert, /api\.CreatePerson\([\s\S]*?uploadTeacherProfilePhoto\([\s\S]*?UPDATE public\.teachers AS teacher[\s\S]*?deleteTeacherFacePerson\(api, groupId, previousPersonId\)/,
  "the delegated service must create, retain and switch the new face before old-person cleanup");
assert.match(delegatedTeacherFaceUpsert, /deleteUploadedFile\(storedPhoto\)[\s\S]{0,420}deleteTeacherFacePerson\(api, groupId, command\.personId\)/,
  "a failed delegated database switch must clean the newly created photo and person");

// New teacher creation is face-bound. This is deliberately narrower than
// account activation: an existing teacher may still be activated without a
// photo, and headquarters can supplement or replace that face on the detail page.
assert.match(teacherCreate, /老师人脸（必填）/,
  "new-teacher UI must describe face enrollment as mandatory");
assert.doesNotMatch(teacherCreate, /老师人脸（可选）|不会阻止账号创建或激活|可后续补录/,
  "new-teacher UI must not advertise a no-face creation path");
assert.doesNotMatch(teacherCreateScript, /CloudBasePhoneAuth\.provisionTeacher\(/,
  "new-teacher UI must not call the generic no-face provisioning path");
assert.match(teacherCreateScript, /CloudBasePhoneAuth\.provisionTeacherWithFace\(/,
  "new-teacher UI must use the atomic consented face-enrollment path");
assert.match(teacherCreateScript, /Boolean\(capturedFaceImage\)[\s\S]{0,300}Boolean\(\$\("teacherFaceConsent"\)\.checked\)[\s\S]{0,160}faceValidated/,
  "new-teacher submit enablement must require capture, consent and validation");
assert.match(phoneAuth, /async provisionTeacher\(\{ staffName, phone, initialPassword \}\)/,
  "the generic shared-client method may remain available for non-UI compatibility");
assert.match(phoneAuth, /async upsertTeacherFace\(/,
  "shared client must expose later teacher-face enrollment/replacement");
assert.match(staffCloud, /if \(role === "teacher"\) \{[\s\S]{0,160}TEACHER_FACE_REQUIRED/,
  "generic teacher provisioning must reject before its otherwise shared staff workflow");
assert.match(optionalFaceActivationSchema, /pg_get_functiondef\(TO_REGPROCEDURE\('public\.sync_teacher_profile\(\)'\)\)/,
  "optional-face provisioning must inspect the installed profile trigger definition, not only a quota column");
assert.match(optionalFaceActivationSchema, /pg_get_functiondef\(TO_REGPROCEDURE\('public\.sync_teacher_account_status\(\)'\)\)/,
  "optional-face provisioning must inspect the installed account-status trigger definition");
assert.match(optionalFaceActivationSchema, /has_optional_profile_trigger_definition[\s\S]*has_optional_account_trigger_definition/,
  "optional-face provisioning must require both 048-02 trigger replacements");
assert.match(optionalFaceActivationSchema, /has_profile_trigger_binding[\s\S]*has_account_trigger_binding/,
  "optional-face provisioning must verify the replacement functions are bound to their triggers");
assert.match(optionalFaceActivationSchema, /迁移 048-02/,
  "a partially run migration must return an actionable 048-02 repair instruction");
assert.match(staffCloud, /if \(staff\.role_code === "teacher"\)\s*\{[\s\S]{0,320}await requireTeacherOptionalFaceActivationSchema\(\);/,
  "activating an existing no-face teacher must verify the optional-face trigger replacement first");
const genericProvision = staffCloud.slice(
  staffCloud.indexOf('if (action === "provisionStaff")'),
  staffCloud.indexOf('if (action === "resetPassword")')
);
assert.match(genericProvision, /TEACHER_FACE_REQUIRED/,
  "generic provisioning must fail closed when asked to create a new teacher without a face");
assert.match(teacherFaceUpsert, /delegateTeacherFace\(\{[\s\S]{0,220}operation:\s*"UPSERT"/,
  "face replacement must use the signed delegated transaction");
assert.match(teacherFaceUpsert, /current\.teacher_status/,
  "later face enrollment must preserve the teacher's existing active/archive state");

// The HQ page is deliberately a management/read path: it may show archived
// teachers/products and their historic quota ledger, whereas configuration and
// recharge are gated again inside the SQL functions by active-master checks.
assert.doesNotMatch(hqEntitlementRead, /(?:teacher_status|account_status|product_status)\s*=\s*'ACTIVE'/i,
  "HQ quota management must retain archived teacher/product history for viewing");
for (const ledger of [
  "teacher_experience_quota_recharges",
  "teacher_experience_quota_resets",
  "teacher_experience_quota_usages"
]) {
  assert.match(hqEntitlementRead, new RegExp(ledger), `HQ quota detail must expose ${ledger} history`);
}
assert.match(entitlementUpsert, /public\.upsert_teacher_product_experience_quota\(/,
  "HQ quota configuration must use the database atomic configuration function");
assert.match(entitlementDelete, /public\.delete_teacher_product_experience_quota\(/,
  "HQ must remove a product quota through the database lifecycle function");
assert.match(entitlementRecharge, /public\.recharge_teacher_product_experience_quota\(/,
  "HQ quota recharge must use the database atomic recharge function");
assert.match(entitlementRecharge, /teacherExperienceIdempotencyKey\(event\.clientRequestId\)/,
  "HQ quota recharge must carry a server-validated idempotency key");
const quotaSchemaGuard = staffCloud.slice(
  staffCloud.indexOf("async function requireTeacherExperienceQuotaSchema"),
  staffCloud.indexOf("function teacherExperienceIdempotencyKey")
);
assert.match(quotaSchemaGuard, /pg_get_functiondef\(TO_REGPROCEDURE\('public\.recharge_teacher_product_experience_quota\(bigint,bigint,integer,text,character varying,bigint\)'\)\)/,
  "quota actions must inspect the installed recharge function, not merely its name");
assert.match(quotaSchemaGuard, /has_active_recharge_function/,
  "a partially executed 048-04 recharge replacement must be detected before quota actions run");
assert.match(quotaSchemaGuard, /quota_status\[\[:space:\]\]\*=\[\[:space:\]\]\*''active''/,
  "the readiness guard must require the 048 active-quota recharge behavior");
for (const action of ["getTeacherExperienceEntitlements", "upsertTeacherExperienceEntitlement", "deleteTeacherExperienceEntitlement", "rechargeTeacherExperienceEntitlement"]) {
  assert.match(staffCloud, new RegExp(`if \\(action === "${action}"\\)[\\s\\S]{0,120}requireHq\\(caller\\)`),
    `${action} must remain HQ-only in the staff service`);
}
assert.match(hqEntitlementRead, /total_experience_count|total_used_count/i,
  "HQ entitlement read must expose all-time experience totals per product");
assert.match(hqEntitlementRead, /experienceTotals[\s\S]{0,260}teacher_experience_quota_usages|teacher_experience_quota_usages[\s\S]{0,1200}experienceTotals/i,
  "HQ summary must retain completed per-product totals even after a configuration is removed");
assert.match(functionSource(faceCloud, "getTeacherExperienceEntitlements"), /total_experience_count|total_used_count/i,
  "store experience selector must expose all-time product experience totals");

// Lazy reset during a read/use closes race windows, but a trusted timer is
// also required so the first day of every business month resets idle quotas.
assert.match(monthlyResetTimer, /String\(process\.env\.TRIGGER_SRC\s*\|\|\s*""\)\.trim\(\)\s*!==\s*"timer"/,
  "monthly quota reset timer must require the reserved platform timer source");
assert.match(monthlyResetTimer, /TEACHER_EXPERIENCE_RESET_TIMER_TRIGGER_NAME/,
  "monthly quota reset timer must validate its exact trigger identity");
assert.match(monthlyResetTimer, /resetTeacherExperienceQuotas\(null\)/,
  "trusted monthly timer must invoke the bulk quota reset function");
assert.match(monthlyResetTimer, /timeZone:\s*"Asia\/Shanghai"/,
  "monthly reset response must identify the business time zone");
assert.match(staffReadme, /reset-teacher-experience-quotas-monthly/,
  "staff deployment documentation must include the monthly reset trigger");
assert.match(staffReadme, /"config":\s*"0 0 0 1 \* \* \*"/,
  "staff deployment documentation must schedule the reset on the first day of each month");

assert.match(staffDetailUi, /const configured = new Set\(experience\.rows\.map\(\(row\) => row\.productId\)/,
  "HQ configuration UI must identify products already configured for this teacher");
assert.match(staffDetailUi, /activeProducts\.filter\(\(product\) => !configured\.has\(product\.id\)\)/,
  "HQ configuration UI must expose each active product at most once");
assert.match(staffDetailUi, /deleteTeacherExperienceEntitlement/,
  "HQ teacher detail must allow a configured product to be removed");
assert.match(staffDetailUi, /体验额度已保存并立即生效/,
  "HQ teacher detail must tell users that configuration replaces the current available count immediately");
assert.match(staffDetailUi, /totalExperienceCount/,
  "HQ teacher detail must render cumulative per-product experience totals");
assert.match(staffDetailUi, /experienceTotals[\s\S]{0,160}normalizeExperienceTotal/,
  "HQ teacher detail must render historical project totals separately from live quota rows");
assert.match(staffDetailUi, /teacherExperienceRechargeProduct/,
  "HQ teacher detail must keep a product selector for independent recharge");
assert.match(staffDetailUi, /isStaffArchived\(\).*不能新增配置或充值|老师已封存.*不能新增配置或充值/s,
  "teacher archive must disable quota configuration and recharge controls while retaining history");

assert.match(staffCloud, /if \(action === "setStaffStatus"\)[\s\S]*UPDATE public\.teachers\s+SET teacher_status/i,
  "archiving a teacher must persist the teacher master status, not only a page-session flag");
assert.match(staffCloud, /if \(action === "setStaffStatus"\)[\s\S]*UPDATE public\.stores(?:\s+\w+)?\s+SET store_status/i,
  "archiving a store account must persist the bound store master status");
assert.match(staffCloud, /userStatus:\s*status === "ACTIVE" \? "ACTIVE" : "BLOCKED"/,
  "archive action must also block the CloudBase login account");
const staffProfile = functionSource(staffCloud, "findStaffProfile");
assert.match(staffProfile, /if \(staff\.role_code === "teacher"\) \{[\s\S]{0,900}teacher_status === "ARCHIVED"/,
  "teacher login must remain blocked only by archived master status");
assert.doesNotMatch(staffProfile, /TEACHER_FACE_REQUIRED|face_enrollment_status === "ENROLLED"/,
  "an active teacher without a face must be able to log in");

// Historical analytics are event-driven.  The current status only affects
// new-business selectors; no archive status condition may remove an event that
// occurred in the requested interval.
for (const source of [analytics, hqDashboard]) {
  assert.doesNotMatch(source, /(?:store_status|teacher_status|product_status|customer_status)\s*=\s*'ACTIVE'/i,
    "date-range historical analytics must not exclude archived entities");
}

console.log("teacher experience and archive contract: PASS");
