const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const faceSource = fs.readFileSync(path.join(root, 'cloudfunctions/faceRecognition/index.js'), 'utf8');
const facePackage = JSON.parse(fs.readFileSync(path.join(root, 'cloudfunctions/faceRecognition/package.json'), 'utf8'));
const pageSource = fs.readFileSync(path.join(root, 'miniprogram-app/miniprogram/pages/verification/index.js'), 'utf8');
const pageWxml = fs.readFileSync(path.join(root, 'miniprogram-app/miniprogram/pages/verification/index.wxml'), 'utf8');
const pageWxss = fs.readFileSync(path.join(root, 'miniprogram-app/miniprogram/pages/verification/index.wxss'), 'utf8');
const bleSource = fs.readFileSync(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js'), 'utf8');
const {
  BLE_GATT_PROFILES,
  BleVerificationSession,
  normalizeGattUuid
} = require(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js'));
const migration = fs.readFileSync(path.join(root, 'database/migrations/066_ble_verification_authorization.sql'), 'utf8');
const verifySql = fs.readFileSync(path.join(root, 'database/cloudbase-console/066-readonly-verify.sql'), 'utf8');
const registryCleanupSql = fs.readFileSync(path.join(root, 'database/cloudbase-console/066-02-retire-legacy-device-registry.sql'), 'utf8');
const magicDeviceMigration = fs.readFileSync(path.join(root, 'database/migrations/069_magic_soft_skin_ble_identity.sql'), 'utf8');

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

test('test builds allow ten seconds for both authorization and fallback status responses', () => {
  assert.match(bleSource, /const AUTH_TIMEOUT_MS = 10000/);
  assert.match(bleSource, /const STATUS_TIMEOUT_MS = 10000/);
  assert.match(bleSource, /设备在 10 秒内没有返回开机结果/);
  assert.match(bleSource, /设备在 10 秒内没有返回实际状态/);
  assert.ok(bleSource.indexOf('await waiting') < bleSource.indexOf('await this.queryWorking(info)'));
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

test('only a live device authorization locks the selected store and customer', () => {
  assert.match(faceSource, /\["ISSUED", "DEVICE_WORKING"\]\.includes\(authorizationStatus\)/);
  assert.match(faceSource, /authorization_status = 'EXPIRED'[\s\S]{0,240}authorization_status = 'ISSUED'[\s\S]{0,160}expires_at <= CLOCK_TIMESTAMP\(\)/);
  assert.match(pageWxml, /!qualificationActive \|\| !bleAuthorizationSent/);
  assert.match(pageWxml, /qualificationActive && bleAuthorizationSent && customer/);
});

test('a terminal stale authorization releases only the previous submission lock', () => {
  const recovery = pageSource.slice(pageSource.indexOf('async recoverPending()'));
  assert.match(pageSource, /function isTerminalBleFinalizationError/);
  assert.match(pageSource, /BLE_AUTHORIZATION_EXPIRED/);
  assert.match(pageSource, /BLE_AUTHORIZATION_NOT_ACTIVE/);
  assert.match(pageSource, /BLE_AUTHORIZATION_NOT_FOUND/);
  assert.match(recovery, /if \(!isTerminalBleFinalizationError\(error\)\) throw error/);
  assert.ok(recovery.indexOf('retryFinalization(progress)') < recovery.indexOf('recoverVerificationBleQualification'));
  assert.match(recovery, /blePermanentlyClosed: false/);
  assert.match(recovery, /未生成核销工单、未扣次；旧锁已解除/);
});

test('device identity is checked without a device registry and QR codes stay hashed in audit', () => {
  assert.equal(facePackage.dependencies['pinyin-pro'], '3.27.0');
  assert.match(faceSource, /BLE_AUTH_SIGNING_KEY/);
  assert.match(faceSource, /createHmac\(['"]sha256['"]/);
  assert.match(faceSource, /device_id/);
  assert.match(faceSource, /device_type/);
  assert.match(faceSource, /nonce/);
  assert.match(migration, /verification_ble_authorizations/);
  assert.match(migration, /qr_code_hash CHAR\(64\)/);
  assert.doesNotMatch(migration, /verification_ble_devices|pairing_code_hash/i);
  assert.doesNotMatch(faceSource, /BLE_DEVICE_NOT_PROVISIONED/);
  assert.match(registryCleanupSql, /DROP TABLE IF EXISTS public\.verification_ble_devices/);
  assert.match(verifySql, /BLE device registry absent/);
  assert.match(verifySql, /00:01:30/);
  assert.match(verifySql, /00:00:30/);
});

test('Magic Soft Skin uses the supplier-confirmed LA and LASER-BLE identity contract', () => {
  assert.match(faceSource, /includes\("魔法柔肤"\)\) return "LASER-BLE"/);
  assert.match(faceSource, /\^LA\[0-9A-F\]\{12\}\$/);
  assert.match(faceSource, /`LA-\$\{normalized\.slice\(-6\)\}`/);
  assert.match(faceSource, /magicSoftSkinProfile !== magicSoftSkinSerial/);
  assert.match(faceSource, /deviceType: canonicalDeviceType/);
  assert.match(faceSource, /sqlText\(canonicalDeviceType\)/);
  assert.match(bleSource, /\^LA\[0-9A-F\]\{12\}\$/);
  assert.match(bleSource, /`LA-\$\{normalized\.slice\(-6\)\}`/);
  assert.match(bleSource, /magicSoftSkinProfile !== magicSoftSkinSerial/);
  assert.match(magicDeviceMigration, /LA\[0-9A-F\]\{12\}/);
  assert.match(magicDeviceMigration, /A-Za-z0-9/);
  assert.match(magicDeviceMigration, /verification_ble_authorizations_qr_sn_check/);
});

test('LASER-BLE selects the fixed HC-08 FFE0/FFE1 profile even when other services are writable', async (t) => {
  assert.deepEqual(BLE_GATT_PROFILES['LASER-BLE'], {
    serviceUuid: 'FFE0',
    writeCharacteristicUuid: 'FFE1',
    notifyCharacteristicUuid: 'FFE1',
    preferredWriteType: 'writeNoResponse'
  });
  assert.equal(normalizeGattUuid('0000ffe0-0000-1000-8000-00805f9b34fb'), 'FFE0');
  assert.equal(normalizeGattUuid('{FFE1}'), 'FFE1');

  const previousWx = global.wx;
  const characteristicQueries = [];
  const notifyCalls = [];
  global.wx = {
    getBLEDeviceServices({ success }) {
      success({
        services: [
          { uuid: '0000180F-0000-1000-8000-00805F9B34FB', isPrimary: true },
          { uuid: '0000FFE0-0000-1000-8000-00805F9B34FB', isPrimary: true }
        ]
      });
    },
    getBLEDeviceCharacteristics({ serviceId, success }) {
      characteristicQueries.push(serviceId);
      success({
        characteristics: [
          {
            uuid: '0000FFE1-0000-1000-8000-00805F9B34FB',
            properties: { write: true, writeNoResponse: true, notify: true }
          }
        ]
      });
    },
    onBLECharacteristicValueChange() {},
    notifyBLECharacteristicValueChange(options) {
      notifyCalls.push(options);
      options.success({});
    }
  };
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  });

  const session = new BleVerificationSession({
    qualification: { expectedDeviceType: 'laser-ble' },
    clientRequestId: 'test-fixed-gatt'
  });
  session.deviceId = 'wechat-device-id';
  await session.discoverProtocol();

  assert.deepEqual(characteristicQueries, ['0000FFE0-0000-1000-8000-00805F9B34FB']);
  assert.equal(session.serviceId, '0000FFE0-0000-1000-8000-00805F9B34FB');
  assert.equal(session.writeCharacteristicId, '0000FFE1-0000-1000-8000-00805F9B34FB');
  assert.equal(session.notifyCharacteristicId, '0000FFE1-0000-1000-8000-00805F9B34FB');
  assert.equal(session.writeType, 'writeNoResponse');
  assert.deepEqual(session.supportedWriteTypes, ['write', 'writeNoResponse']);
  assert.equal(notifyCalls.length, 1);
});

test('device types without a confirmed profile retain unique-channel discovery', async (t) => {
  const previousWx = global.wx;
  const arbitraryService = '12345678-1234-5678-1234-56789ABCDEF0';
  const arbitraryWrite = '12345678-1234-5678-1234-56789ABCDEF1';
  const arbitraryNotify = '12345678-1234-5678-1234-56789ABCDEF2';
  global.wx = {
    getBLEDeviceServices({ success }) {
      success({ services: [{ uuid: arbitraryService, isPrimary: true }] });
    },
    getBLEDeviceCharacteristics({ success }) {
      success({
        characteristics: [
          { uuid: arbitraryWrite, properties: { write: true } },
          { uuid: arbitraryNotify, properties: { notify: true } }
        ]
      });
    },
    onBLECharacteristicValueChange() {},
    notifyBLECharacteristicValueChange({ success }) { success({}); }
  };
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  });

  const session = new BleVerificationSession({
    qualification: { expectedDeviceType: 'future-device-type' },
    clientRequestId: 'test-fallback-gatt'
  });
  session.deviceId = 'wechat-device-id';
  await session.discoverProtocol();

  assert.equal(session.serviceId, arbitraryService);
  assert.equal(session.writeCharacteristicId, arbitraryWrite);
  assert.equal(session.notifyCharacteristicId, arbitraryNotify);
});

test('long authorization JSON is delivered as ordered HC-08-safe writes and one LF frame', async (t) => {
  assert.match(bleSource, /const WRITE_CHUNK_GAP_MS = 50/);
  const previousWx = global.wx;
  const writes = [];
  global.wx = {
    writeBLECharacteristicValue(options) {
      writes.push({
        writeType: options.writeType,
        bytes: Buffer.from(new Uint8Array(options.value))
      });
      options.success({});
    }
  };
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  });

  const session = new BleVerificationSession({ qualification: {}, clientRequestId: 'test-chunked-auth' });
  session.deviceId = 'wechat-device-id';
  session.serviceId = 'FFE0';
  session.writeCharacteristicId = 'FFE1';
  session.writeType = 'write';
  session.supportedWriteTypes = ['write'];
  const command = {
    ver: '1.0', seq: 2, cmd: 'auth',
    auth: {
      command: 'enter_work', device_id: 'LAF82E0CC8C5B9', device_type: 'LASER-BLE',
      nonce: '00112233445566778899aabbccddeeff', usage_count: 1,
      issued_at: 1791341008, expire_at: 1791341038,
      signature: 'a'.repeat(64)
    }
  };

  await session.write(command);

  assert.ok(writes.length > 1);
  assert.ok(writes.every((item) => item.bytes.byteLength <= 20));
  assert.ok(writes.every((item) => item.writeType === 'write'));
  assert.equal(Buffer.concat(writes.map((item) => item.bytes)).toString('utf8'), `${JSON.stringify(command)}\n`);
});

test('first-chunk 10007 switches write mode once without resending a complete command', async (t) => {
  const previousWx = global.wx;
  const attempts = [];
  const successfulChunks = [];
  global.wx = {
    writeBLECharacteristicValue(options) {
      const bytes = Buffer.from(new Uint8Array(options.value));
      attempts.push({ writeType: options.writeType, bytes });
      if (attempts.length === 1) {
        options.fail({ errCode: 10007, errMsg: 'writeBLECharacteristicValue:fail property not support' });
        return;
      }
      successfulChunks.push(bytes);
      options.success({});
    }
  };
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  });

  const session = new BleVerificationSession({ qualification: {}, clientRequestId: 'test-write-mode-fallback' });
  session.deviceId = 'wechat-device-id';
  session.serviceId = 'FFE0';
  session.writeCharacteristicId = 'FFE1';
  session.writeType = 'write';
  session.supportedWriteTypes = ['write', 'writeNoResponse'];
  const command = { ver: '1.0', seq: 1, cmd: 'get_info', ts: 1791341008 };

  await session.write(command);

  assert.equal(attempts[0].writeType, 'write');
  assert.equal(attempts[1].writeType, 'writeNoResponse');
  assert.ok(attempts.slice(1).every((item) => item.writeType === 'writeNoResponse'));
  assert.equal(session.writeType, 'writeNoResponse');
  assert.equal(Buffer.concat(successfulChunks).toString('utf8'), `${JSON.stringify(command)}\n`);
});

test('BLE write failures expose safe command and chunk diagnostics without authorization data', async (t) => {
  const previousWx = global.wx;
  let writeCount = 0;
  global.wx = {
    writeBLECharacteristicValue(options) {
      writeCount += 1;
      if (writeCount === 2) {
        options.fail({
          errCode: 10008,
          errMsg: 'writeBLECharacteristicValue:fail system error device_id=LAF82E0CC8C5B9 nonce=00112233445566778899aabbccddeeff'
        });
        return;
      }
      options.success({});
    }
  };
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  });

  const session = new BleVerificationSession({ qualification: {}, clientRequestId: 'test-write-diagnostic' });
  session.deviceId = 'wechat-device-id';
  session.serviceId = 'FFE0';
  session.writeCharacteristicId = 'FFE1';
  session.writeType = 'write';
  session.supportedWriteTypes = ['write'];
  const command = {
    ver: '1.0', seq: 2, cmd: 'auth',
    auth: {
      device_id: 'SECRET-DEVICE-ID',
      nonce: 'SECRET-NONCE',
      signature: 'SECRET-SIGNATURE'
    }
  };

  await assert.rejects(session.write(command), (error) => {
    assert.equal(error.code, 'BLE_WRITE_FAILED');
    const feedback = require(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js')).errorFeedback(error);
    assert.match(feedback.detail, /auth（发送开机授权）/);
    assert.match(feedback.detail, /序号：2/);
    assert.match(feedback.detail, /分片：2\/\d+/);
    assert.match(feedback.detail, /微信错误：10008/);
    assert.match(feedback.detail, /writeBLECharacteristicValue:fail system error/);
    assert.doesNotMatch(feedback.detail, /LAF82E0CC8C5B9|00112233445566778899aabbccddeeff|SECRET-DEVICE-ID|SECRET-NONCE|SECRET-SIGNATURE/);
    return true;
  });
  assert.equal(writeCount, 2);
  assert.match(pageWxml, /发送诊断：\{\{bleErrorDetail\}\}/);
});

test('BLE signing key is mandatory and qualification creation is read back safely', () => {
  const creation = faceSource.slice(
    faceSource.indexOf('async function createVerificationBleQualification'),
    faceSource.indexOf('async function recoverVerificationBleQualification')
  );
  assert.match(faceSource, /BLE_SIGNING_KEY_MISSING/);
  assert.match(faceSource, /Buffer\.byteLength\(key, ["']utf8["']\) < 32/);
  assert.ok(creation.indexOf('verificationBleSigningKey();') < creation.indexOf('INSERT INTO public.verification_ble_qualifications'));
  assert.doesNotMatch(creation, /RETURNING\s+\*/i);
  assert.match(creation, /WHERE qualification\.idempotency_key/);
  assert.match(creation, /BLE_QUALIFICATION_CREATE_FAILED/);
  assert.match(creation, /qualification\?\.verification_id/);
});

test('BLE tables are service-only and readonly verifier cannot mutate data', () => {
  assert.match(migration, /REVOKE ALL PRIVILEGES[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL PRIVILEGES[\s\S]+TO service_role/);
  assert.doesNotMatch(verifySql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE)\b/i);
});

test('mini-program maps QR, Bluetooth, protocol and device failures to explicit feedback', () => {
  [
    'BLE_QR_INVALID', 'BLE_QR_CANCELLED', 'BLE_SWITCH_OFF', 'BLE_DEVICE_NOT_FOUND',
    'BLE_CONNECTION_FAILED', 'BLE_PROTOCOL_CHANNEL_MISSING', 'BLE_PROTOCOL_SERVICE_MISSING',
    'BLE_PROTOCOL_CHARACTERISTIC_MISSING', 'BLE_PROTOCOL_WRITE_UNAVAILABLE',
    'BLE_PROTOCOL_NOTIFY_UNAVAILABLE', 'BLE_NOTIFY_ENABLE_FAILED', 'BLE_DEVICE_ID_MISMATCH',
    'BLE_DEVICE_TYPE_MISMATCH', 'BLE_AUTHORIZATION_INVALID', 'BLE_DEVICE_NOT_WORKING'
  ].forEach((code) => assert.match(bleSource + pageSource, new RegExp(code)));
  ['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1011']
    .forEach((code) => assert.match(bleSource, new RegExp(`${code}:`)));
  assert.match(faceSource, /没有因此证明核销已完成/);
  assert.match(bleSource, /这不代表核销已经完成/);
});

test('mini-program rejects incomplete qualification, hides raw technical errors and keeps the action in document flow', () => {
  assert.match(pageSource, /typeof qualification !== ["']object["']/);
  assert.match(pageSource, /qualification\?\.found/);
  assert.match(bleSource, /cannot read\|undefined/);
  assert.match(bleSource, /BLE_QUALIFICATION_INCOMPLETE/);
  assert.match(pageWxss, /\.submit-card\s*\{[^}]*position:\s*static/s);
  assert.doesNotMatch(pageWxss, /\.submit-card\s*\{[^}]*position:\s*(?:sticky|fixed)/s);
  assert.match(pageWxml, /开始设备核销/);
  assert.doesNotMatch(pageWxml, /核销写入、照片凭证、额度扣减和设备信号/);
});
