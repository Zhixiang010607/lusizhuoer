"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  let depth = 0;
  for (let index = signatureEnd + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

const cloud = read("cloudfunctions/staffAccount/index.js");
const wrapper = read("cloudbase-phone-auth.js");
const setMasterStatus = functionSource(cloud, "setMasterStatus");
const persistStoreStatus = functionSource(cloud, "persistStoreStatusById");
const setStoreStatus = functionSource(cloud, "setStoreMasterStatus");
const dispatcher = functionSource(cloud, "main");

assert.match(cloud, /const FUNCTION_VERSION = "v63"/,
  "the repaired store archive contract needs an independently verifiable deployment version");
assert.match(dispatcher, /action === "setMasterStatus"[\s\S]{0,100}requireHq\(caller\)/,
  "the public master-status action must reject every non-HQ caller");
assert.match(setMasterStatus, /requireHq\(caller\)/,
  "the master-status service needs its own HQ defense in depth");
assert.match(setMasterStatus, /setStoreMasterStatus\(numericId\(storeIdText/,
  "store archive must use the store-id transaction instead of recursively changing an arbitrary staff UID");

assert.match(persistStoreStatus, /WITH target_store AS[\s\S]*changed_store AS[\s\S]*changed_account AS/,
  "store master and linked database account must be updated in one SQL statement");
assert.match(persistStoreStatus, /UPDATE public\.stores store[\s\S]*SET store_status/,
  "the store master status must be persisted");
assert.match(persistStoreStatus, /UPDATE public\.staff_accounts account[\s\S]*SET account_status/,
  "the linked login account status must be persisted in the same statement");
assert.match(persistStoreStatus, /account\.role_code = 'store'/,
  "a corrupted non-store account binding must never be archived through a store action");
assert.match(persistStoreStatus, /STORE_ACCOUNT_BINDING_INVALID/,
  "invalid bindings must fail with a repairable, explicit error");

assert.match(setStoreStatus, /persistStoreStatusById\(storeId, status\)[\s\S]*manager\(\)\.user\.modifyUser/,
  "database authorization must be revoked before the external credential is handled");
assert.match(setStoreStatus, /status === "ARCHIVED"[\s\S]*missingCredential[\s\S]*AUTH_CREDENTIAL_MISSING/,
  "a legacy or stress-test UID missing from CloudBase must count as already non-login after database archive");
assert.match(setStoreStatus, /status === "ACTIVE"[\s\S]*persistStoreStatusById\(storeId, "ARCHIVED"\)/,
  "failed activation must compensate back to archived rather than opening database access");
assert.match(setStoreStatus, /AUTH_ACTIVATION_COMPENSATION_FAILED/,
  "a failed activation compensation must surface a critical explicit error");
assert.match(wrapper, /storeId \? "门店状态更新失败" : "老师状态更新失败"/,
  "the browser wrapper must identify a store-status failure clearly");

console.log("store archive authorization contract: PASS");
