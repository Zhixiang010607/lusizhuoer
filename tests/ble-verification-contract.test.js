const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const faceSource = fs.readFileSync(path.join(root, 'cloudfunctions/faceRecognition/index.js'), 'utf8');
const facePackage = JSON.parse(fs.readFileSync(path.join(root, 'cloudfunctions/faceRecognition/package.json'), 'utf8'));
const pageSource = fs.readFileSync(path.join(root, 'miniprogram-app/miniprogram/pages/verification/index.js'), 'utf8');
const bleSource = fs.readFileSync(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'database/migrations/066_ble_verification_authorization.sql'), 'utf8');
const verifySql = fs.readFileSync(path.join(root, 'database/cloudbase-console/066-readonly-verify.sql'), 'utf8');

test('BLE verification uses 90-second qualification and 30-second device authorization', () => {
  assert.match(migration, /INTERVAL '90 seconds'/);
  assert.match(migration, /INTERVAL '30 seconds'/);
  assert.match(faceSource, /90 秒 BLE 资格/);
  assert.match(pageSource, /90 秒内/);
});

test('verification deducts only after device reports working status 2', () => {
  const confirmation = faceSource.slice(
    faceSource.indexOf('async function confirmVerificationBleWorkStarted'),
    faceSource.indexOf('async function finalizeVerificationApplicationInternal')
  );
  assert.match(confirmation, /result\.ok !== true \|\| Number\(result\.status\) !== 2/);
  assert.match(confirmation, /finalizeVerificationApplicationInternal/);
  assert.ok(confirmation.indexOf('Number(result.status) !== 2') < confirmation.indexOf('finalizeVerificationApplicationInternal'));
  assert.match(faceSource, /createVerificationApplication[\s\S]{0,160}BLE_REQUIRED/);
});

test('client supports reopenable QR window and irreversible success navigation', () => {
  assert.match(pageSource, /openBleWindow/);
  assert.match(pageSource, /closeBleWindow/);
  assert.match(pageSource, /blePermanentlyClosed/);
  assert.match(pageSource, /wx\.redirectTo/);
  assert.match(pageSource, /clearProgress/);
  assert.match(bleSource, /BLE_QR_CANCELLED/);
  assert.match(bleSource, /BLE_WINDOW_CLOSED/);
});

test('device identity and authorization are bound and pairing codes stay hashed', () => {
  assert.equal(facePackage.dependencies['pinyin-pro'], '3.27.0');
  assert.match(faceSource, /BLE_AUTH_SIGNING_KEY/);
  assert.match(faceSource, /createHmac\(['"]sha256['"]/);
  assert.match(faceSource, /device_id/);
  assert.match(faceSource, /device_type/);
  assert.match(faceSource, /nonce/);
  assert.match(migration, /pairing_code_hash CHAR\(64\)/);
  assert.doesNotMatch(migration, /\bpairing_code\s+(?:VARCHAR|TEXT|CHAR)/i);
});

test('BLE tables are service-only and readonly verifier cannot mutate data', () => {
  assert.match(migration, /REVOKE ALL PRIVILEGES[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL PRIVILEGES[\s\S]+TO service_role/);
  assert.doesNotMatch(verifySql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE)\b/i);
});

test('mini-program maps QR, Bluetooth, protocol and device failures to explicit feedback', () => {
  [
    'BLE_QR_INVALID', 'BLE_QR_CANCELLED', 'BLE_SWITCH_OFF', 'BLE_DEVICE_NOT_FOUND',
    'BLE_CONNECTION_FAILED', 'BLE_PROTOCOL_CHANNEL_MISSING', 'BLE_DEVICE_ID_MISMATCH',
    'BLE_DEVICE_TYPE_MISMATCH', 'BLE_AUTHORIZATION_INVALID', 'BLE_DEVICE_NOT_WORKING'
  ].forEach((code) => assert.match(bleSource + pageSource, new RegExp(code)));
  ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1011']
    .forEach((code) => assert.match(bleSource, new RegExp(`${code}:`)));
});
