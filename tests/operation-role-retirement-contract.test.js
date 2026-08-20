"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));
const authUi = read("auth-ui.js");
const login = read("login.js");
const management = read("management.js");
const personCreate = read("person-create.js");
const review = read("review.js");
const phoneAuth = read("cloudbase-phone-auth.js");
const staffAccount = read("cloudfunctions/staffAccount/index.js");
const faceRecognition = read("cloudfunctions/faceRecognition/index.js");
const schema = read("database/schema.sql");
const migration = read("database/migrations/047_retire_operation_accounts.sql");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

// The old pages and every normal browser navigation/create entry are gone.
for (const page of ["operation-account-management.html", "operation-account-create.html", "local.html", "operation-home.js"]) {
  assert.equal(exists(page), false, `${page} must not remain deployable`);
}
assert.doesNotMatch(authUi, /operation-account-(?:management|create)\.html/);
assert.doesNotMatch(authUi, /\boperation\s*:/, "the auth role map cannot expose an operation role");
assert.match(authUi, /const homes = \{ hq: "index\.html", store: "store-detail\.html", teacher: "teacher-work-orders\.html" \};/);
assert.doesNotMatch(login, /\boperation\b/i, "login must not offer a retired role or local demo");
assert.doesNotMatch(management, /\boperation\b/i, "management lists cannot render retired operation accounts");
assert.match(personCreate, /if \(type !== "hq"\) \{[\s\S]*?location\.replace\("hq-management\.html"\)/);
assert.match(personCreate, /role: "hq"/, "the only remaining person-create form provisions headquarters accounts");
assert.doesNotMatch(review, /\boperation\b/i, "review UI is headquarters-only");

// Application-layer authorization rejects the role at every entry point while
// retaining a hidden, headquarters-only one-time credential retirement action.
assert.match(staffAccount, /const ROLES = new Set\(\["hq", "store", "teacher"\]\);/);
assert.doesNotMatch(staffAccount, /const OPERATION_ACTIONS/);
const findProfile = functionSource(staffAccount, "findStaffProfile");
assert.match(findProfile, /staff\.role_code === "operation"[\s\S]*?OPERATION_ROLE_RETIRED/);
const recovery = functionSource(staffAccount, "recoverStaffProfileByVerifiedPhone");
assert.match(recovery, /staff\.role_code === "operation"[\s\S]*?OPERATION_ROLE_RETIRED/);
const createProfile = functionSource(staffAccount, "createStaffDatabaseProfile");
assert.match(createProfile, /role === "operation"[\s\S]*?OPERATION_ROLE_RETIRED/);
const reviewerGuard = functionSource(staffAccount, "requireReviewer");
assert.match(reviewerGuard, /caller\.profile\?\.role !== "hq"/);
assert.doesNotMatch(reviewerGuard, /operation/);
const retirement = functionSource(staffAccount, "retireOperationAccounts");
assert.match(retirement, /WHERE role_code = 'operation'/);
assert.match(retirement, /manager\(\)\.user\.modifyUser\(\{ uid, userStatus: "BLOCKED" \}\)/);
assert.match(retirement, /OPERATION_AUTH_RETIRE_INCOMPLETE/);
assert.match(retirement, /SET account_status = 'ARCHIVED'/);
assert.match(
  staffAccount,
  /if \(action === "retireOperationAccounts"\) \{\s*requireHq\(caller\);\s*return await retireOperationAccounts\(\);\s*\}/,
  "only headquarters can execute the one-time credential retirement"
);
assert.match(phoneAuth, /async retireOperationAccounts\(\)[\s\S]*?\{ action: "retireOperationAccounts" \}/);

// Face/customer/photo access has no special operation scope or retired action.
assert.doesNotMatch(faceRecognition, /activeOperationReviewCaller|operationReviewCustomerScope|getReviewCustomerProfile/);
const photoCaller = functionSource(faceRecognition, "activeVerificationPhotoCaller");
assert.match(photoCaller, /\['hq', 'store', 'teacher'\]\.includes\(account\.role_code\)/);
assert.doesNotMatch(photoCaller, /operation/);
const photoContext = functionSource(faceRecognition, "verificationPhotoContext");
assert.doesNotMatch(photoContext, /operation/);

// The database migration preserves old rows for audit, archives their access,
// blocks recreation/reuse, and moves all review authority to active HQ users.
assert.match(schema, /role_code VARCHAR\(16\) NOT NULL CHECK \(role_code IN \('hq', 'store', 'teacher'\)\)/);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reject_retired_operation_account\(\)/);
assert.match(migration, /TG_OP = 'INSERT' AND NEW\.role_code = 'operation'/);
assert.match(migration, /operation accounts may only remain archived historic rows/);
assert.match(migration, /UPDATE public\.staff_accounts[\s\S]*?SET account_status = 'ARCHIVED'[\s\S]*?WHERE role_code = 'operation'/);
assert.match(migration, /UPDATE public\.operation_profiles[\s\S]*?SET profile_status = 'ARCHIVED'/);
assert.match(migration, /DELETE FROM public\.role_permissions WHERE role_code = 'operation';/);
assert.match(migration, /IF actor_role IS DISTINCT FROM 'hq' THEN[\s\S]*?only headquarters can review orders/);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.enforce_hq_order_reviewer\(\)/);
assert.match(migration, /IF reviewer_role IS DISTINCT FROM 'hq' THEN/);
assert.doesNotMatch(migration, /\bDROP\s+TABLE\b/i, "historic operation rows must not be deleted by dropping tables");
assert.doesNotMatch(migration, /DELETE\s+FROM\s+public\.staff_accounts/i, "historic operation staff IDs must remain auditable");
assert.doesNotMatch(migration, /\bCASCADE\b/i, "retirement must not cascade-delete historical business records");

console.log("operation role retirement contract: PASS");
