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
  compactAuthorizationCommand,
  normalizeDeviceResponse,
  normalizeGattUuid
} = require(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js'));
const migration = fs.readFileSync(path.join(root, 'database/migrations/066_ble_verification_authorization.sql'), 'utf8');
const verifySql = fs.readFileSync(path.join(root, 'database/cloudbase-console/066-readonly-verify.sql'), 'utf8');
const registryCleanupSql = fs.readFileSync(path.join(root, 'database/cloudbase-console/066-02-retire-legacy-device-registry.sql'), 'utf8');
const magicDeviceMigration = fs.readFileSync(path.join(root, 'database/migrations/069_magic_soft_skin_ble_identity.sql'), 'utf8');
const reusableNonceMigration = fs.readFileSync(path.join(root, 'database/migrations/071_allow_reused_ble_nonce.sql'), 'utf8');
const reusableNonceVerifySql = fs.readFileSync(path.join(root, 'database/cloudbase-console/071-readonly-verify.sql'), 'utf8');

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

test('read-only get_info retries once after five seconds without a complete response inside one ten-second wait', async () => {
  assert.match(bleSource, /const INFO_RETRY_AFTER_MS = 5000/);
  assert.doesNotMatch(bleSource, /NOTIFY_SETTLE_MS|await pause\(/);

  const states = [];
  const writes = [];
  const session = new BleVerificationSession({
    qualification: {},
    clientRequestId: 'test-info-retry',
    onState: (state) => states.push(state)
  });
  session.infoRetryAfterMs = 5;
  session.infoTimeoutMs = 50;
  session.write = async (payload) => {
    writes.push({ ...payload });
    if (writes.length === 2) {
      setTimeout(() => session.dispatch({ ver: '1.0', seq: 1, cmd: 'info', ok: true, status: 1 }), 0);
    }
  };

  const info = await session.readInfo();

  assert.equal(info.cmd, 'info');
  assert.equal(writes.length, 2);
  assert.ok(writes.every((payload) => payload.cmd === 'get_info' && payload.seq === 1));
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(states.some((state) => state.stage === 'DEVICE_READING_RETRY'), true);
  assert.equal(writes.some((payload) => payload.cmd === 'auth'), false);
});

test('an incomplete get_info response is discarded before the one safe read-only retry', async () => {
  const states = [];
  const writes = [];
  const session = new BleVerificationSession({
    qualification: {},
    clientRequestId: 'test-info-partial',
    onState: (state) => states.push(state)
  });
  session.infoRetryAfterMs = 5;
  session.infoTimeoutMs = 50;
  session.write = async (payload) => {
    writes.push({ ...payload });
    if (writes.length === 1) {
      setTimeout(() => {
        session.receivePacketCount += 1;
        session.receiveBuffer = '{"ver":"1.0","seq":1,"cmd":"info"';
      }, 1);
      return;
    }
    assert.equal(session.receiveBuffer, '');
    setTimeout(() => session.dispatch({ ver: '1.0', seq: 1, cmd: 'info', ok: true, status: 1 }), 0);
  };

  const info = await session.readInfo();

  assert.equal(info.cmd, 'info');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(states.some((state) => state.stage === 'DEVICE_READING_RETRY'), true);
  assert.equal(states.some((state) => /清空残片/.test(state.message)), true);
});

test('BLE cleanup unsubscribes and closes the old connection before closing the adapter', async (t) => {
  const previousWx = global.wx;
  const calls = [];
  global.wx = {
    offBLECharacteristicValueChange(handler) { calls.push(['off', handler]); },
    stopBluetoothDevicesDiscovery({ complete }) { calls.push(['stop']); complete({}); },
    notifyBLECharacteristicValueChange({ state, complete }) { calls.push(['notify', state]); complete({}); },
    closeBLEConnection({ deviceId, complete }) { calls.push(['connection', deviceId]); complete({}); },
    closeBluetoothAdapter({ complete }) { calls.push(['adapter']); complete({}); }
  };
  t.after(() => {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  });

  const session = new BleVerificationSession({ qualification: {}, clientRequestId: 'test-cleanup' });
  session.deviceId = 'wechat-device-id';
  session.serviceId = 'FFE0';
  session.notifyCharacteristicId = 'FFE1';
  await session.closeConnection();
  await session.closeConnection();

  assert.deepEqual(calls.map((item) => item[0]), ['off', 'stop', 'notify', 'connection', 'adapter']);
  assert.equal(calls[2][1], false);
});

test('client supports reopenable QR window and irreversible success navigation', () => {
  assert.match(pageSource, /openBleWindow/);
  assert.match(pageSource, /closeBleWindow/);
  assert.match(pageSource, /await session\.cancel\(\)/);
  assert.match(pageSource, /本轮连接已完全关闭，资格有效期内可重新扫码/);
  assert.match(pageWxml, /bleRunning && bleStage !== 'QR_SCANNING' && bleStage !== 'DEVICE_DISCOVERING'/);
  assert.match(pageSource, /const cancellableStage = \["QR_SCANNING", "DEVICE_DISCOVERING"\]/);
  assert.match(pageSource, /blePermanentlyClosed/);
  assert.match(pageSource, /wx\.redirectTo/);
  assert.match(pageSource, /clearProgress/);
  assert.match(bleSource, /BLE_QR_CANCELLED/);
  assert.match(bleSource, /BLE_WINDOW_CLOSED/);
  assert.match(bleSource, /await bleCleanupBarrier/);
  assert.match(bleSource, /if \(this\.cancelled\) return/);
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
  assert.doesNotMatch(faceSource, /BLE_AUTH_SIGNING_KEY/);
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
  assert.doesNotMatch(bleSource, /WRITE_CHUNK_GAP_MS|await wait\(/);
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

test('BLE receive accepts consecutive complete JSON responses without LF terminators', async () => {
  const states = [];
  const session = new BleVerificationSession({
    qualification: {},
    clientRequestId: 'test-receive-without-lf',
    onState: (state) => states.push(state)
  });
  session.deviceId = 'wechat-device-id';
  session.notifyCharacteristicId = '0000FFE1-0000-1000-8000-00805F9B34FB';
  const infoResponse = { ver: '1.0', seq: 1, cmd: 'info', ok: true, status: 1 };
  const statusResponse = { ver: '1.0', seq: 3, cmd: 'status', ok: true, status: 1 };
  const response = `${JSON.stringify(infoResponse)}${JSON.stringify(statusResponse)}`;
  const waitingInfo = session.waitFor((payload) => payload.cmd === 'info' && payload.seq === 1, 100, 'TEST_TIMEOUT', 'test');
  const waitingStatus = session.waitFor((payload) => payload.cmd === 'status' && payload.seq === 3, 100, 'TEST_TIMEOUT', 'test');

  for (let offset = 0; offset < response.length; offset += 20) {
    const fragment = Buffer.from(response.slice(offset, offset + 20), 'utf8');
    session.handleValue({
      deviceId: 'wechat-device-id',
      characteristicId: '0000FFE1-0000-1000-8000-00805F9B34FB',
      value: fragment.buffer.slice(fragment.byteOffset, fragment.byteOffset + fragment.byteLength)
    });
  }

  assert.deepEqual(await waitingInfo, infoResponse);
  assert.deepEqual(await waitingStatus, statusResponse);
  assert.equal(session.receiveBuffer, '');
  assert.equal(session.receiveLfCount, 0);
  assert.equal(session.lastReceiveSummary, 'cmd=status,seq=3,ok=true,status=1');
  assert.equal(states.some((state) => state.stage === 'PROTOCOL_WARNING'), false);
});

test('LASER-BLE accepts the compact three-packet info response and reconstructs verified identity', async () => {
  const nonce = '00112233445566778899aabbccddeedd';
  const compactInfo = { q: 1, c: 'i', s: 1, n: nonce };
  const encoded = JSON.stringify(compactInfo);
  assert.equal(Buffer.byteLength(encoded, 'utf8'), 60);
  assert.equal(Math.ceil(Buffer.byteLength(encoded, 'utf8') / 20), 3);

  const session = new BleVerificationSession({
    qualification: { expectedDeviceType: 'LASER-BLE' },
    clientRequestId: 'test-compact-info'
  });
  session.connectedBleName = 'LA-C8C5B9';
  session.write = async () => {
    setTimeout(() => session.dispatch(compactInfo), 0);
  };

  const info = await session.readInfo();
  assert.deepEqual(info, compactInfo);
  assert.deepEqual(
    session.validateInfo({ sn: 'LAF82E0CC8C5B9' }, info),
    {
      device_id: 'LAF82E0CC8C5B9',
      device_type: 'LASER-BLE',
      ble_name: 'LA-C8C5B9',
      status: 1,
      nonce
    }
  );
  assert.equal(session.useCompactProtocol, true);
});

test('compact info cannot bypass the exact advertised-name or project-type checks', () => {
  const compactInfo = { q: 1, c: 'i', s: 1, n: '00112233445566778899aabbccddeedd' };
  const wrongName = new BleVerificationSession({
    qualification: { expectedDeviceType: 'LASER-BLE' },
    clientRequestId: 'test-compact-name'
  });
  wrongName.connectedBleName = 'LA-000000';
  assert.throws(
    () => wrongName.validateInfo({ sn: 'LAF82E0CC8C5B9' }, compactInfo),
    (error) => error.code === 'BLE_NAME_MISMATCH'
  );

  const otherProject = new BleVerificationSession({
    qualification: { expectedDeviceType: 'other-device' },
    clientRequestId: 'test-compact-project'
  });
  otherProject.connectedBleName = 'LA-C8C5B9';
  assert.throws(
    () => otherProject.validateInfo({ sn: 'LAF82E0CC8C5B9' }, compactInfo),
    (error) => error.code === 'BLE_DEVICE_TYPE_MISMATCH'
  );
});

test('compact info diagnostics expose only the normalized command, sequence, and status', () => {
  const session = new BleVerificationSession({ qualification: {}, clientRequestId: 'test-compact-summary' });
  session.recordReceiveSummary({ q: 1, c: 'i', s: 2, n: '00112233445566778899aabbccddeedd' });
  assert.equal(session.lastReceiveSummary, 'cmd=info,seq=1,status=2');
  assert.doesNotMatch(session.lastReceiveSummary, /001122|nonce|\bn=/);
});

test('compact post-info protocol minimizes every remaining BLE exchange', () => {
  const signature = '41638537597196183052aecgeigdifkh';
  const compactAuth = compactAuthorizationCommand({
    auth: {
      usage_count: 2,
      expire_at: 1791450472,
      signature,
      device_id: 'LAF82E0CC8C5B9',
      device_type: 'LASER-BLE',
      nonce: '00112233445566778899aabbccddeeff',
      issued_at: 1791450442
    }
  });
  assert.deepEqual(compactAuth, { q: 2, c: 'a', u: 2, e: 1791450472, x: signature });

  const frames = {
    auth: compactAuth,
    authResult: { q: 2, o: 1, s: 2 },
    queryStatus: { q: 3 },
    status: { q: 3, s: 2 }
  };
  assert.equal(Buffer.byteLength(JSON.stringify(frames.auth), 'utf8'), 75);
  assert.equal(Math.ceil((Buffer.byteLength(JSON.stringify(frames.auth), 'utf8') + 1) / 20), 4);
  assert.equal(Buffer.byteLength(JSON.stringify(frames.authResult), 'utf8'), 19);
  assert.equal(Buffer.byteLength(JSON.stringify(frames.queryStatus), 'utf8'), 7);
  assert.equal(Buffer.byteLength(JSON.stringify(frames.status), 'utf8'), 13);
  assert.deepEqual(normalizeDeviceResponse(frames.authResult), {
    ...frames.authResult, cmd: 'auth_result', seq: 2, ok: true, status: 2, code: 0
  });
  assert.deepEqual(normalizeDeviceResponse(frames.status), {
    ...frames.status, cmd: 'status', seq: 3, status: 2
  });
});

test('compact status recovery uses one short query and restores canonical device identity', async () => {
  const writes = [];
  const session = new BleVerificationSession({ qualification: {}, clientRequestId: 'test-compact-status' });
  session.useCompactProtocol = true;
  session.write = async (payload) => {
    writes.push(payload);
    setTimeout(() => session.dispatch({ q: 3, s: 2 }), 0);
  };
  const original = {
    device_id: 'LAF82E0CC8C5B9',
    device_type: 'LASER-BLE',
    ble_name: 'LA-C8C5B9',
    nonce: '00112233445566778899aabbccddeedd',
    status: 1
  };

  const recovered = await session.queryWorking(original);
  assert.deepEqual(writes, [{ q: 3 }]);
  assert.equal(recovered.device_id, original.device_id);
  assert.equal(recovered.nonce, original.nonce);
  assert.equal(recovered.status, 2);
  assert.equal(recovered.ok, true);
});

test('BLE receive timeout exposes structural diagnostics without payload secrets', async () => {
  const session = new BleVerificationSession({ qualification: {}, clientRequestId: 'test-receive-diagnostic' });
  session.deviceId = 'wechat-device-id';
  session.notifyCharacteristicId = 'FFE1';
  const partial = Buffer.from('{"device_id":"LAF82E0CC8C5B9","nonce":"00112233445566778899aabbccddeeff"', 'utf8');
  const waiting = session.waitFor(() => false, 5, 'BLE_INFO_TIMEOUT', 'test timeout');
  session.handleValue({
    deviceId: 'wechat-device-id',
    characteristicId: 'FFE1',
    value: partial.buffer.slice(partial.byteOffset, partial.byteOffset + partial.byteLength)
  });

  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, 'BLE_INFO_TIMEOUT');
    const feedback = require(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js')).errorFeedback(error);
    assert.match(feedback.receiveDiagnostic, /通知片长：\d+/);
    assert.match(feedback.receiveDiagnostic, /完整闭合：否/);
    assert.match(feedback.receiveDiagnostic, /首\/尾：7B\/[0-9A-F]{2}/);
    assert.match(feedback.receiveDiagnostic, /LF：0/);
    assert.match(feedback.receiveDiagnostic, /最近回包：无/);
    assert.doesNotMatch(feedback.receiveDiagnostic, /LAF82E0CC8C5B9|00112233445566778899aabbccddeeff|device_id|nonce/);
    return true;
  });
  assert.match(pageWxml, /接收诊断：\{\{bleReceiveDiagnostic\}\}/);
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

test('BLE signature exactly follows the supplier Caesar example and needs no production key', () => {
  const creation = faceSource.slice(
    faceSource.indexOf('async function createVerificationBleQualification'),
    faceSource.indexOf('async function recoverVerificationBleQualification')
  );
  const signing = faceSource.slice(
    faceSource.indexOf('function verificationBleSignature'),
    faceSource.indexOf('async function createVerificationBleQualification')
  );
  const buildSignature = new Function(
    'fail',
    `${signing}\nreturn verificationBleSignature;`
  )((message, code) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  });

  assert.equal(
    buildSignature('00112233445566778899aabbccddeeff'),
    '41638537597196183052aecgeigdifkh'
  );
  assert.equal(
    buildSignature('00112233445566778899AABBCCDDEEFF'),
    '41638537597196183052aecgeigdifkh'
  );
  assert.match(signing, /const offset = \(4 \* \(index \+ 1\)\) % 7/);
  assert.match(signing, /% 10/);
  assert.match(signing, /% 26/);
  assert.doesNotMatch(faceSource, /BLE_AUTH_SIGNING_KEY|BLE_SIGNING_KEY_MISSING/);
  assert.doesNotMatch(signing, /createHmac|canonical|productionKey/);
  assert.match(faceSource, /const signature = verificationBleSignature\(nonce\)/);
  assert.ok(creation.indexOf('INSERT INTO public.verification_ble_qualifications') >= 0);
  assert.doesNotMatch(creation, /RETURNING\s+\*/i);
  assert.match(creation, /WHERE qualification\.idempotency_key/);
  assert.match(creation, /BLE_QUALIFICATION_CREATE_FAILED/);
  assert.match(creation, /qualification\?\.verification_id/);
});

test('the same device nonce may be reused by separate qualifications without weakening per-order uniqueness', () => {
  assert.match(reusableNonceMigration, /DROP CONSTRAINT IF EXISTS verification_ble_authorizations_device_id_nonce_key/);
  assert.match(reusableNonceMigration, /idx_verification_ble_authorization_device_nonce/);
  assert.match(reusableNonceVerifySql, /device nonce global unique constraint removed/);
  assert.match(reusableNonceVerifySql, /qualification remains one authorization only/);
  assert.match(reusableNonceVerifySql, /authorization token remains unique/);
  assert.match(faceSource, /BLE_NONCE_POLICY_NOT_MIGRATED/);
  assert.doesNotMatch(faceSource, /BLE_NONCE_REUSED/);
  assert.match(migration, /qualification_id BIGINT NOT NULL UNIQUE/);
  assert.match(migration, /authorization_token VARCHAR\(48\) NOT NULL UNIQUE/);
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
  assert.match(faceSource, /数据库尚未执行允许设备重复随机码的迁移 071/);
  assert.match(bleSource, /请管理员先执行数据库迁移 071/);
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
