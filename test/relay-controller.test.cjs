const assert = require('node:assert/strict');
const test = require('node:test');

const { RelayController, RELAY_INIT_REPORT, USB_RELAY_PID, USB_RELAY_VID, resolveRelayDevice } = require('../dist/services/relayController');

function fakeHid(initialMask = 0x00, mutateOtherBits = false) {
  const calls = [];
  let mask = initialMask;
  let openCount = 0;
  let closeCount = 0;

  class FakeHandle {
    constructor(path) {
      openCount += 1;
      this.path = path;
    }

    sendFeatureReport(report) {
      calls.push([...report]);
      if (report[1] === 0xff) mask |= 1 << (report[2] - 1);
      if (report[1] === 0xfd) mask &= ~(1 << (report[2] - 1));
      if (mutateOtherBits && (report[1] === 0xff || report[1] === 0xfd)) mask ^= 0x80;
      return report.length;
    }

    getFeatureReport() {
      const report = Buffer.alloc(9);
      report[7] = mask;
      return report;
    }

    close() {
      closeCount += 1;
    }
  }

  return {
    module: {
      devices: () => [{
        path: 'relay-a',
        vendorId: USB_RELAY_VID,
        productId: USB_RELAY_PID,
        serialNumber: 'A001',
        product: 'USBRelay8',
        manufacturer: 'dcttech'
      }],
      HID: FakeHandle
    },
    calls,
    get mask() { return mask; },
    get openCount() { return openCount; },
    get closeCount() { return closeCount; }
  };
}

test('扫描继电器只枚举 HID，不打开或占用设备', () => {
  const hid = fakeHid(0x55);
  const controller = new RelayController(() => hid.module);
  const devices = controller.list();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].path, 'relay-a');
  assert.equal(hid.openCount, 0);
});

test('读取状态仅在动作期间打开 HID，完成后立即释放且不改变通道', async () => {
  const hid = fakeHid(0x55);
  const controller = new RelayController(() => hid.module, async () => {});
  const mask = await controller.readState('relay-a');
  assert.equal(mask, 0x55);
  assert.deepEqual(hid.calls, [RELAY_INIT_REPORT]);
  assert.equal(hid.closeCount, 1);
  assert.equal(hid.openCount, 1);
  assert.equal(hid.mask, 0x55);
});

test('CH1～CH8 每次操作都独立打开和释放，并保持其他位不变', async () => {
  const hid = fakeHid(0x55);
  const controller = new RelayController(() => hid.module, async () => {});

  const onResult = await controller.setChannel('relay-a', 2, true);
  assert.deepEqual(onResult, { before: 0x55, after: 0x57 });
  assert.equal(onResult.before & ~0x02, onResult.after & ~0x02);
  assert.deepEqual(hid.calls.at(-1), [0x00, 0xff, 2, 0, 0, 0, 0, 0, 0]);
  assert.equal(hid.openCount, 1);
  assert.equal(hid.closeCount, 1);

  const offResult = await controller.setChannel('relay-a', 1, false);
  assert.deepEqual(offResult, { before: 0x57, after: 0x56 });
  assert.equal(offResult.before & ~0x01, offResult.after & ~0x01);
  assert.deepEqual(hid.calls.at(-1), [0x00, 0xfd, 1, 0, 0, 0, 0, 0, 0]);
  assert.equal(hid.openCount, 2);
  assert.equal(hid.closeCount, 2);
});

test('读回发现非目标通道变化时立即报错', async () => {
  const hid = fakeHid(0x01, true);
  const controller = new RelayController(() => hid.module, async () => {});
  await assert.rejects(controller.setChannel('relay-a', 2, true), /非目标通道状态发生变化/);
  assert.equal(hid.openCount, 1);
  assert.equal(hid.closeCount, 1);
});

test('拒绝无效通道且不会打开 HID', async () => {
  const hid = fakeHid();
  const controller = new RelayController(() => hid.module, async () => {});
  await assert.rejects(controller.setChannel('relay-a', 0, true), /继电器通道必须为 1\.\.8/);
  await assert.rejects(controller.setChannel('relay-a', 9, false), /继电器通道必须为 1\.\.8/);
  assert.equal(hid.openCount, 0);
});

test('每次动作前可按设备身份把旧 HID path 解析为重新扫描后的新 path', () => {
  const previous = {
    path: 'old-path', vendorId: USB_RELAY_VID, productId: USB_RELAY_PID,
    serialNumber: 'A001', product: 'USBRelay8', manufacturer: 'dcttech'
  };
  const current = [
    { ...previous, path: 'new-path' },
    { ...previous, path: 'other-path', serialNumber: 'B002' }
  ];
  assert.equal(resolveRelayDevice(previous, current).path, 'new-path');
});

test('继电器被瞬时占用时重试打开，成功后仍立即释放', async () => {
  const hid = fakeHid(0x01);
  const BaseHandle = hid.module.HID;
  let attempts = 0;
  hid.module.HID = class extends BaseHandle {
    constructor(path) {
      attempts += 1;
      if (attempts === 1) throw new Error('open failed: resource busy');
      super(path);
    }
  };
  const controller = new RelayController(() => hid.module, async () => {});
  assert.equal(await controller.readState('relay-a'), 0x01);
  assert.equal(attempts, 2);
  assert.equal(hid.openCount, 1);
  assert.equal(hid.closeCount, 1);
});
