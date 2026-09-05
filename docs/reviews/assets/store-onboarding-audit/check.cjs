'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const cloud = fs.readFileSync('cloudfunctions/staffAccount/index.js', 'utf8');
const pageSource = fs.readFileSync('miniprogram-app/miniprogram/pages/store-create/index.js', 'utf8');
const sessionSource = fs.readFileSync('miniprogram-app/miniprogram/services/session.js', 'utf8');
const slice = (start, end) => {
  const a = cloud.indexOf(start), b = cloud.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return cloud.slice(a, b);
};
const mainSource = slice('async function main(event = {}, context = {}) {', '\n// Keep master-data status');
const profileSource = slice('async function createStaffDatabaseProfile(', '\nasync function assertPhoneCanUseRole(');
const storeSource = slice('async function createOrRecoverStore(', '\nasync function removeUnboundStore(');
const fail = (message, code = 'BAD_REQUEST') => { throw Object.assign(new Error(message), { code }); };
const numericId = (value) => { const id = Number(value); assert.ok(Number.isSafeInteger(id) && id > 0); return id; };
const fixture = { storeName: '示例门店', province: '北京市', city: '北京市', district: '朝阳区', addressDetail: '示例路 1 号', contactName: '示例联系人', contactPhone: '13900000008', initialPassword: 'Aa1!fixture' };
fs.mkdirSync('tmp/store-onboarding-audit', { recursive: true });
const checks = [];
function record(name, observation, detail) { checks.push({ name, observation, detail }); }
function createHarness({ existingAuth = false, emptyStore = false, emptyBinding = false, layout = 'stores', contactFailure = false } = {}) {
  const state = { store: null, account: null, bound: false, auth: existingAuth ? { Uid: 'fixture-store-auth', password: 'Old1!fixture', Phone: fixture.contactPhone } : null, callerUid: 'fixture-hq', events: [] };
  const ctx = {
    module: { exports: {} }, console, process: { env: {} }, FUNCTION_VERSION: 'v81', ROLES: new Set(['hq','store','teacher']),
    handleTrustedTeacherExperienceResetTimer: async () => null,
    currentUser: async () => state.callerUid === 'fixture-hq' ? { uid: state.callerUid, profile: { role: 'hq', staffId: '1' } } : { uid: state.callerUid, profile: state.bound ? { role: 'store', staffId: '501', storeId: '601', storeCode: 'STR000601' } : null },
    requireHq(caller) { assert.equal(caller.profile.role, 'hq'); },
    fail, numericId, sqlText: (value) => `'${String(value).replaceAll("'", "''")}'`,
    asDatabaseError(error) { throw error; }, stageFail(stage, message, code) { throw Object.assign(new Error(message), { code, stage }); },
    validatePhone: (value) => value, validatePassword: (value) => value,
    storeInputFromEvent: (event) => ({ ...event }), assertPhoneCanUseRole: async () => null,
    getStoreBindingLayout: async () => layout,
    getStoreCreationCapabilities: async () => ({ storeCodeHasDefault: true, contactsJson: true, storeContacts: true, createdBy: true }),
    findStoreByContactPhone: async () => state.store,
    findRecoverableStoreByProfile: async () => null,
    ensureSingleStoreContact: async () => { if (contactFailure) throw new Error('fixture contact persistence failed'); },
    findAuthUserByExactPhone: async () => state.auth,
    manager: () => ({ user: { createUser: async (input) => { state.events.push('createAuth'); state.auth = { Uid: 'fixture-store-auth', Phone: input.phone, password: input.password }; return { Data: { Uid: state.auth.Uid } }; } } }),
    writeCredentialEvent: async () => { state.events.push('credentialAudit'); },
    removeUnboundStore: async () => { state.events.push('cleanup'); return false; },
    executeSql: async (sql) => {
      if (sql.includes('INSERT INTO public.stores')) {
        state.events.push('storeCommitted');
        state.store = { id: '601', store_code: 'STR000601', store_name: fixture.storeName, province: fixture.province, city: fixture.city, district: fixture.district, address_detail: fixture.addressDetail, store_status: 'ACTIVE' };
        return emptyStore ? [] : [{ id: '601', store_code: 'STR000601' }];
      }
      if (sql.includes('SELECT id, auth_uid, role_code')) return [];
      if (sql.includes('INSERT INTO public.staff_accounts')) { state.account = { id: '501' }; return [state.account]; }
      if (sql.includes('SELECT id FROM public.stores') || sql.includes('SELECT store_id FROM public.staff_store_assignments')) return [];
      if (sql.includes('WITH bound_store') || sql.includes('WITH bound_assignment')) { state.bound = true; state.events.push('bindingCommitted'); return emptyBinding ? [] : [{ id: '601', store_id: '601' }]; }
      throw new Error(`Unexpected fixture SQL: ${sql.slice(0, 90)}`);
    }
  };
  vm.runInNewContext(`${storeSource}\n${profileSource}\n${mainSource}\nmodule.exports = main;`, ctx);
  return { state, create: () => ctx.module.exports({ action: 'createStoreWithAccount', ...fixture }), main: ctx.module.exports };
}
function pageHarness({ result, invocationError, removeFailure = false, navigationFailure = false }) {
  let page;
  const state = { calls: 0, redirects: 0, callbackHandled: false };
  const storage = new Map();
  const wx = {
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => { if (removeFailure) throw new Error('fixture storage unavailable'); storage.delete(key); },
    redirectTo: (options) => { state.redirects++; if (navigationFailure && options.fail) { state.callbackHandled = true; options.fail({ errMsg: 'fixture navigation failure' }); } },
    navigateBack() {}, setNavigationBarTitle() {}
  };
  vm.runInNewContext(pageSource, { wx, Page: (value) => { page = value; }, require: (name) => name.includes('/api') ? { callStaff: async () => { state.calls++; if (invocationError) throw invocationError; return result; } } : { requireSession: () => ({ role: 'hq' }) } });
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function(update) { for (const [key, value] of Object.entries(update)) { const parts = key.split('.'); let target = this.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; } };
  page.data.form = { name: fixture.storeName, region: [fixture.province, fixture.city, fixture.district], address: fixture.addressDetail, contactName: fixture.contactName, phone: fixture.contactPhone, password: fixture.initialPassword };
  return { page, state };
}
(async () => {
  const normal = createHarness();
  const fresh = await normal.create();
  assert.equal(fresh.account.passwordInitialized, true);
  assert.equal(normal.state.bound, true);
  const app = { globalData: { session: null } }, storage = new Map();
  let authenticatedUid = '';
  const auth = {
    signOut: async () => { normal.state.callerUid = ''; authenticatedUid = ''; },
    signInWithPassword: async (input) => input.phone === normal.state.auth.Phone && input.password === normal.state.auth.password ? (authenticatedUid = normal.state.auth.Uid, { data: { user: { uid: authenticatedUid } } }) : { error: { code: 'INVALID_CREDENTIALS', message: 'fixture wrong password' } },
    refreshSession: async () => { normal.state.callerUid = authenticatedUid; },
    getAccessToken: async () => ({}), getCurrentUser: async () => ({ uid: authenticatedUid })
  };
  const sessionCtx = { module: { exports: {} }, Date, setTimeout, getApp: () => app, wx: { getStorageSync: key => storage.get(key), setStorageSync: (key,value) => storage.set(key,value), removeStorageSync: key => storage.delete(key) }, require: name => name === './cloudbase' ? { getAuth: () => auth } : { callStaff: action => normal.main({ action }) } };
  vm.runInNewContext(sessionSource, sessionCtx);
  const session = await sessionCtx.module.exports.passwordLogin(fixture.contactPhone, fixture.initialPassword);
  assert.equal(session.role, 'store'); assert.equal(session.storeId, fresh.storeId);
  await assert.rejects(sessionCtx.module.exports.passwordLogin(fixture.contactPhone, 'Wrong1!fixture'));
  assert.equal(app.globalData.session, null);
  record('normal-create-and-password-login', 'passed', 'Actual dispatcher, creation/binding helpers and mini session; isolated Auth/SQL. New initial password enters the same store; wrong password rejected.');

  const existing = createHarness({ existingAuth: true });
  const recovered = await existing.create();
  assert.equal(recovered.account.passwordInitialized, false);
  assert.notEqual(existing.state.auth.password, fixture.initialPassword);
  const recoveryPage = pageHarness({ result: recovered });
  await recoveryPage.page.submit();
  assert.equal(recoveryPage.state.redirects, 1);
  assert.equal(/原密码|未生效|未更改|保持不变/.test(recoveryPage.page.data.message), false);
  record('recovered-password-feedback', 'confirmed', 'Server preserves existing Auth password and returns passwordInitialized=false; mini page redirects without explaining that the supplied initial password was not applied.');

  const empty = createHarness({ emptyStore: true });
  await assert.rejects(empty.create(), error => error.code === 'DATABASE_ERROR');
  assert.ok(empty.state.store); assert.equal(empty.state.auth, null);
  record('committed-store-empty-return', 'confirmed', 'Injected committed store write with empty returned rows: creation reports DATABASE_ERROR before account creation, without write-after-read confirmation.');
  for (const layout of ['stores','assignments']) {
    const binding = createHarness({ emptyBinding: true, layout });
    await assert.rejects(binding.create(), error => error.code === 'STORE_BINDING_FAILED');
    assert.equal(binding.state.bound, true);
    record(`committed-binding-empty-return-${layout}`, 'confirmed', 'Injected successful binding with empty returned rows: reports STORE_BINDING_FAILED although binding was committed.');
  }
  const navigation = pageHarness({ result: fresh, navigationFailure: true });
  await navigation.page.submit(); await navigation.page.submit();
  assert.equal(navigation.state.calls, 2); assert.equal(navigation.state.callbackHandled, false);
  record('success-navigation-failure', 'confirmed', 'A failed redirect leaves no success lock or recovery callback; the same page allows a second creation request. This check does not claim duplicate persisted accounts.');

  const storageFailure = pageHarness({ result: fresh, removeFailure: true });
  await storageFailure.page.submit();
  assert.equal(storageFailure.page.data.error, true); assert.equal(storageFailure.state.redirects, 0);
  record('success-storage-cleanup-failure', 'confirmed', 'A local pending-key cleanup error converts a confirmed server success into a visible creation error.');

  const timeout = pageHarness({ invocationError: Object.assign(new Error('fixture request timeout'), { submissionUncertain: true }) });
  await timeout.page.submit(); await timeout.page.submit();
  assert.equal(timeout.state.calls, 2);
  record('unconfirmed-result-feedback', 'confirmed', 'Transport uncertainty does not lock the store creation form or tell the operator to first check the directory; retry issues a second request. No production timeout or duplicate account was claimed.');

  const warning = pageHarness({ result: { ...fresh, warning: 'fixture credential audit warning' } });
  await warning.page.submit();
  assert.equal(warning.page.data.message.includes('fixture credential audit warning'), false);
  record('account-warning-hidden', 'confirmed', 'An account audit warning returned by the service is discarded on navigation.');

  const contacts = createHarness({ contactFailure: true });
  await assert.rejects(contacts.create(), /contact persistence failed/);
  assert.ok(contacts.state.store); assert.equal(contacts.state.events.includes('cleanup'), false);
  record('contact-failure-unfinished-store', 'confirmed', 'Isolated contact-write failure after a committed store leaves an unfinished profile outside account-stage cleanup; later recovery is still possible.');
  const report = { checkedAt: '2026-09-06', sourceCommit: '10cd3b8891387cae9422d2edc8a99965ed7bed86', scope: 'Local source execution with synthetic Auth, SQL, storage and navigation; no production account writes or real-login claim.', checks };
  fs.writeFileSync('tmp/store-onboarding-audit/results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
