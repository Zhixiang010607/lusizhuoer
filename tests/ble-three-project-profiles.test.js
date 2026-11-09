const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const face = fs.readFileSync(path.join(root, 'cloudfunctions/faceRecognition/index.js'), 'utf8');
const ble = require(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js'));
const types = ['LASER-BLE', 'haiyangzhiyun', 'lusikangcheng'];
const nonce = '00112233445566778899aabbccddeeff';
const signature = '41638537597196183052aecgeigdifkh';
const serial = 'LA001122334455';

function declaration(name) {
  const functionStart = face.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, name);
  const start = face.slice(functionStart - 6, functionStart) === 'async ' ? functionStart - 6 : functionStart;
  return face.slice(start, face.indexOf('\n}', start) + 2);
}

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

const helpers = new Function('require', 'fail', `
  let pinyinFunction = null;
  ${declaration('verificationDeviceType')}
  ${declaration('isHc08CompactDeviceType')}
  ${declaration('isSupportedVerificationDeviceSerial')}
  ${declaration('verificationBleName')}
  ${declaration('verificationBleSignature')}
  return { verificationDeviceType, isHc08CompactDeviceType,
    isSupportedVerificationDeviceSerial, verificationBleName, verificationBleSignature };
`)(() => ({ pinyin: () => ['legacy', 'device'] }), fail);

test('three project names select distinct canonical types without changing Magic Soft Skin', () => {
  for (const name of ['魔法柔肤', '魔法柔肤仪', ' 魔法 柔肤 ']) {
    assert.equal(helpers.verificationDeviceType(name), 'LASER-BLE');
  }
  for (const name of ['海洋之蕴', '海洋之韵', '海洋之蕴三维精雕', 'HAIYANGZHIYUN']) {
    assert.equal(helpers.verificationDeviceType(name), 'haiyangzhiyun');
  }
  for (const name of ['露思康辰', '露思康辰E脉通', 'lusikangcheng', 'LUSIKANGCHENG']) {
    assert.equal(helpers.verificationDeviceType(name), 'lusikangcheng');
  }
  assert.equal(helpers.verificationDeviceType('未指定设备'), 'legacydevice');
  assert.equal(helpers.isHc08CompactDeviceType('future-device'), false);
  assert.equal(helpers.isHc08CompactDeviceType('lusikangchen'), false);
});

test('new fixed profiles are exact copies of the original immutable GATT profile', () => {
  const original = ble.BLE_GATT_PROFILES['LASER-BLE'];
  assert.deepEqual(original, { serviceUuid: 'FFE0', writeCharacteristicUuid: 'FFE1',
    notifyCharacteristicUuid: 'FFE1', preferredWriteType: 'writeNoResponse' });
  for (const type of types) {
    assert.equal(helpers.isHc08CompactDeviceType(type), true);
    assert.deepEqual(ble.BLE_GATT_PROFILES[type.toUpperCase()], original);
    assert.ok(Object.isFrozen(ble.BLE_GATT_PROFILES[type.toUpperCase()]));
  }
  assert.equal(helpers.verificationBleSignature(nonce), signature);
  assert.equal(helpers.verificationBleName(serial), 'LA-334455');
});

for (const type of types) {
  test(`${type}: reads and retries the exact same compact q=1`, async () => {
    const session = new ble.BleVerificationSession({ qualification: { expectedDeviceType: type } });
    session.infoRetryAfterMs = 5;
    session.infoTimeoutMs = 200;
    const writes = [];
    session.write = async payload => {
      writes.push(payload);
      if (writes.length === 1) {
        session.receivePacketCount += 1;
        session.receiveBuffer = '{"q":1,"c":"i"';
      } else {
        assert.equal(session.receiveBuffer, '');
        session.dispatch({ q: 1, c: 'i', s: 1, n: nonce });
      }
    };
    assert.deepEqual(await session.readInfo(), { q: 1, c: 'i', s: 1, n: nonce });
    assert.deepEqual(writes, [{ q: 1 }, { q: 1 }]);
  });

  test(`${type}: fixed GATT ignores unrelated writable services`, async t => {
    const previous = global.wx;
    const queried = [];
    global.wx = {
      getBLEDeviceServices({ success }) { success({ services: [{ uuid: 'OTHER' }, { uuid: 'FFE0' }] }); },
      getBLEDeviceCharacteristics({ serviceId, success }) {
        queried.push(serviceId);
        success({ characteristics: [{ uuid: 'FFE1', properties: { write: true, writeNoResponse: true, notify: true } }] });
      },
      onBLECharacteristicValueChange() {},
      notifyBLECharacteristicValueChange({ success }) { success({}); }
    };
    t.after(() => { global.wx = previous; });
    const session = new ble.BleVerificationSession({ qualification: { expectedDeviceType: type } });
    session.deviceId = 'isolated-qa-device';
    await session.discoverProtocol();
    assert.deepEqual(queried, ['FFE0']);
    assert.equal(session.writeCharacteristicId, 'FFE1');
    assert.equal(session.notifyCharacteristicId, 'FFE1');
    assert.equal(session.writeType, 'writeNoResponse');
  });

  test(`${type}: compact identity keeps exact QR, name, nonce and state checks`, () => {
    const session = new ble.BleVerificationSession({ qualification: { expectedDeviceType: type } });
    session.connectedBleName = 'LA-334455';
    const info = { q: 1, c: 'i', s: 1, n: nonce };
    assert.deepEqual(session.validateInfo({ sn: serial }, info), {
      device_id: serial, device_type: type, ble_name: 'LA-334455', status: 1, nonce
    });
    assert.equal(session.useCompactProtocol, true);
    session.connectedBleName = 'LA-FFFFFF';
    assert.throws(() => session.validateInfo({ sn: serial }, info), { code: 'BLE_NAME_MISMATCH' });
    session.connectedBleName = 'LA-334455';
    assert.throws(() => session.validateInfo({ sn: serial }, { ...info, n: 'bad' }), { code: 'BLE_NONCE_INVALID' });
    assert.throws(() => session.validateInfo({ sn: serial }, { ...info, s: 3 }), { code: 'BLE_DEVICE_NOT_READY' });
    assert.throws(() => session.validateInfo({ sn: 'NCM00112233445' }, info), { code: 'BLE_DEVICE_TYPE_MISMATCH' });
    assert.throws(() => session.validateInfo({ sn: serial }, {
      device_id: serial, device_type: 'wrong-project', ble_name: 'LA-334455', status: 1, nonce
    }), { code: 'BLE_DEVICE_TYPE_MISMATCH' });
  });

  test(`${type}: server accepts LA only after authoritative project type matches`, async () => {
    const stop = new Error('reached existing authorization path');
    const issue = new Function('activeBusinessCaller', 'requireVerificationBleSchema', 'executeSql',
      'sqlText', 'fail', 'isSupportedVerificationDeviceSerial', 'verificationBleName',
      'isHc08CompactDeviceType', `${declaration('issueVerificationBleAuthorization')}\nreturn issueVerificationBleAuthorization;`
    )(async () => ({ storeId: '1', staffId: '2' }), async () => {}, async sql => {
      if (sql.includes('SELECT qualification.*')) return [{ id: '3', expected_device_type: type, valid_seconds: 90 }];
      throw stop;
    }, value => `'${value}'`, fail, helpers.isSupportedVerificationDeviceSerial,
    helpers.verificationBleName, helpers.isHc08CompactDeviceType);
    const event = { qualificationToken: 'a'.repeat(48), qrSn: serial, qrCode: '123456',
      deviceInfo: { device_id: serial, device_type: type, ble_name: 'LA-334455', nonce, status: 1 } };
    await assert.rejects(issue(event), error => error === stop);
    await assert.rejects(issue({ ...event, deviceInfo: { ...event.deviceInfo, device_type: 'wrong' } }),
      { code: 'BLE_DEVICE_TYPE_MISMATCH' });
    await assert.rejects(issue({ ...event, qrSn: 'NCM00112233445',
      deviceInfo: { ...event.deviceInfo, device_id: 'NCM00112233445', ble_name: 'NCM-233445' } }),
    { code: 'BLE_DEVICE_TYPE_MISMATCH' });
    await assert.rejects(issue({ ...event, deviceInfo: { ...event.deviceInfo, status: 2 } }),
      { code: 'BLE_DEVICE_NOT_READY' });
  });
}

test('unconfirmed types still reject compact info and LA identities', () => {
  const session = new ble.BleVerificationSession({ qualification: { expectedDeviceType: 'future-device' } });
  session.connectedBleName = 'LA-334455';
  assert.throws(() => session.validateInfo({ sn: serial }, { q: 1, c: 'i', s: 1, n: nonce }),
    { code: 'BLE_DEVICE_TYPE_MISMATCH' });
  assert.throws(() => session.validateInfo({ sn: serial }, {
    device_id: serial, device_type: 'future-device', ble_name: 'LA-334455', status: 1, nonce
  }), { code: 'BLE_DEVICE_TYPE_MISMATCH' });
});

async function replayWireProtocol(type, sourceOverride) {
  const trace = [];
  const storage = new Map();
  let receiver;
  let pending = '';
  const module = { exports: {} };
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    getBLEDeviceServices({ success }) { success({ services: [{ uuid: 'FFE0' }] }); },
    getBLEDeviceCharacteristics({ success }) {
      success({ characteristics: [{ uuid: 'FFE1', properties: { write: true, writeNoResponse: true, notify: true } }] });
    },
    onBLECharacteristicValueChange(handler) { receiver = handler; },
    notifyBLECharacteristicValueChange({ success }) { success({}); },
    writeBLECharacteristicValue({ value, writeType, success }) {
      const packet = Buffer.from(value).toString();
      trace.push(['write', writeType, packet]);
      assert.ok(value.byteLength <= 20);
      pending += packet;
      success({});
      if (!pending.endsWith('\n')) return;
      const command = JSON.parse(pending);
      pending = '';
      const response = command.q === 1 ? { q: 1, c: 'i', s: 1, n: nonce }
        : command.q === 2 ? { q: 2, o: 1, s: 2 } : { q: 3, s: 2 };
      setTimeout(() => {
        const bytes = Buffer.from(JSON.stringify(response));
        for (let i = 0; i < bytes.length; i += 20) {
          const part = bytes.subarray(i, i + 20);
          receiver({ deviceId: 'isolated-device', characteristicId: 'FFE1',
            value: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) });
        }
      }, 0);
    }
  };
  const callFace = async (action, payload) => {
    trace.push(['server', action, JSON.parse(JSON.stringify(payload))]);
    if (action === 'issueVerificationBleAuthorization') {
      return { authorizationToken: 'isolated-authorization', authCommand: { auth: {
        device_id: serial, device_type: type, nonce, usage_count: 2, expire_at: 1791450472, signature
      } } };
    }
    if (action === 'confirmVerificationBleWorkStarted') return { verificationId: '1', verificationCode: 'QA-1' };
    throw new Error(action);
  };
  const source = sourceOverride || fs.readFileSync(path.join(root, 'miniprogram-app/miniprogram/services/ble-verification.js'), 'utf8');
  vm.runInNewContext(source, { module, wx, setTimeout, clearTimeout, Uint8Array, ArrayBuffer,
    require: name => name === './api' ? { callFace } : { readSession: () => ({ uid: 'isolated-staff' }) } });
  const Session = module.exports.BleVerificationSession;
  const session = new Session({ qualification: { expectedDeviceType: type, qualificationToken: 'isolated-qualification' },
    clientRequestId: 'isolated-request', storeId: '1', onState: state => trace.push(['state', state.stage]) });
  session.scanQr = async () => ({ sn: serial, code: '123456' });
  session.openAdapter = async () => {};
  session.discover = async () => ({});
  session.connect = async () => { session.deviceId = 'isolated-device'; session.connectedBleName = 'LA-334455'; };
  session.closeConnection = async () => {};
  assert.deepEqual(JSON.parse(JSON.stringify(await session.run())), { verificationId: '1', verificationCode: 'QA-1' });
  assert.equal(pending, '');
  assert.equal(trace.filter(row => row[0] === 'server' && row[1] === 'issueVerificationBleAuthorization').length, 1);
  assert.equal(trace.filter(row => row[0] === 'server' && row[1] === 'confirmVerificationBleWorkStarted').length, 1);
  return JSON.stringify(trace).replaceAll(type, '<TYPE>');
}

test('all three types produce identical real chunk bytes and server-call sequence except device_type', async () => {
  const original = await replayWireProtocol('LASER-BLE');
  assert.equal(await replayWireProtocol('haiyangzhiyun'), original);
  assert.equal(await replayWireProtocol('lusikangcheng'), original);
});
