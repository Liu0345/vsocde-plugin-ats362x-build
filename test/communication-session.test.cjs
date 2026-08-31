const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { UartCommunicationService } = require('../dist/services/uartCommunication.js');
const { HidCommunicationService, listGenericHidDevices, listUacHidDevices } = require('../dist/services/hidCommunication.js');

class FakeSerial extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.isOpen = false;
    this.writes = [];
    this.signals = [];
  }
  open(callback) { this.isOpen = true; callback(); }
  write(data, callback) { this.writes.push(Buffer.from(data)); callback(); }
  drain(callback) { callback(); }
  set(options, callback) { this.signals.push(options); callback(); }
  close(callback) { this.isOpen = false; callback(); }
}

test('UART 会话串行打开、空闲分包、发送 drain 并可靠释放', async () => {
  const packets = [];
  const statuses = [];
  let serial;
  const service = new UartCommunicationService(
    (direction, packet) => packets.push({ direction, packet: [...packet] }),
    (status) => statuses.push(status),
    (options) => (serial = new FakeSerial(options))
  );

  await service.connect({ path: '/dev/test', baudRate: 3000000, packetTimeoutMs: 10 });
  assert.equal(service.isConnected, true);
  assert.equal(serial.options.lock, true);
  assert.equal(serial.options.dataBits, 8);
  assert.equal(serial.options.stopBits, 1);
  assert.equal(serial.options.parity, 'none');
  serial.emit('data', Buffer.from([1, 2]));
  serial.emit('data', Buffer.from([3]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await service.send(Buffer.from([0xaa]));
  await service.setSignals(true, false);
  assert.deepEqual(serial.signals, [{ dtr: true, rts: false }]);
  assert.deepEqual(packets, [
    { direction: 'rx', packet: [1, 2, 3] },
    { direction: 'tx', packet: [0xaa] }
  ]);
  await service.disconnect();
  assert.equal(service.isConnected, false);
  assert.equal(serial.isOpen, false);
  assert.equal(statuses.at(-1).connected, false);
});

test('UART 拒绝范围外波特率且失败后仍可重新连接', async () => {
  const service = new UartCommunicationService(() => {}, () => {}, (options) => new FakeSerial(options));
  await assert.rejects(service.connect({ path: '/dev/test', baudRate: 3000001, packetTimeoutMs: 20 }), /9600.*3000000/);
  await service.connect({ path: '/dev/test', baudRate: 9600, packetTimeoutMs: 20 });
  assert.equal(service.isConnected, true);
  await service.disconnect();
});

class FakeHid extends EventEmitter {
  constructor(path) { super(); this.path = path; this.closed = false; this.writes = []; }
  write(data) { this.writes.push([...data]); return data.length; }
  close() { this.closed = true; }
}

test('HID 通讯枚举所有有效接口而不限定 DFU usage', () => {
  const devices = listGenericHidDevices({
    devices: () => [
      { path: 'a', vendorId: 0x10d6, productId: 0x10d6, usagePage: 1, usage: 2 },
      { vendorId: 1, productId: 2 },
      { path: 'b', vendorId: 0x16c0, productId: 0x05df, usagePage: 0xff00, usage: 1 }
    ],
    HID: FakeHid
  });
  assert.deepEqual(devices.map((item) => item.path), ['a', 'b']);
});

test('HID 通讯保留同一路径下不同 Usage 的全部 collection', () => {
  const devices = listGenericHidDevices({
    devices: () => [
      { path: 'same-path', vendorId: 0x10d6, productId: 0x10d6, usagePage: 1, usage: 1 },
      { path: 'same-path', vendorId: 0x10d6, productId: 0x10d6, usagePage: 0xff00, usage: 2 },
      { path: 'other-path', vendorId: 0x10d6, productId: 0x10d6, usagePage: 0xff00, usage: 3 }
    ],
    HID: FakeHid
  });
  assert.equal(devices.length, 3);
  assert.deepEqual(devices.filter((item) => item.path === 'same-path').map((item) => item.usagePage), [1, 0xff00]);
});

test('HID 通讯设备列表只保留属于 UAC 设备的 HID 接口', async () => {
  const devices = await listUacHidDevices({
    devices: () => [
      { path: 'uac-hid', vendorId: 0x10d6, productId: 0x10d6, usagePage: 0xff00 },
      { path: 'relay', vendorId: 0x16c0, productId: 0x05df, usagePage: 0xff00 },
      { path: 'keyboard', vendorId: 0x1234, productId: 0x5678, usagePage: 1 }
    ],
    HID: FakeHid
  }, new Set(['10d6:10d6']));
  assert.deepEqual(devices.map((device) => device.path), ['uac-hid']);
});

test('HID 会话分包接收、构造报告发送并在断开后释放接口', async () => {
  const packets = [];
  const statuses = [];
  let handle;
  const module = {
    devices: () => [],
    HID: class extends FakeHid { constructor(path) { super(path); handle = this; } }
  };
  const service = new HidCommunicationService(
    (direction, packet) => packets.push({ direction, packet: [...packet] }),
    (status) => statuses.push(status),
    () => module
  );
  await service.connect({ path: 'hid-path', packetTimeoutMs: 10 });
  handle.emit('data', Buffer.from([2, 0x11]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await service.send(Buffer.from([0xaa, 0x55]), { reportId: 1, reportLength: 8, padToLength: true });
  assert.deepEqual(handle.writes[0], [1, 0xaa, 0x55, 0, 0, 0, 0, 0]);
  assert.deepEqual(packets, [
    { direction: 'rx', packet: [2, 0x11] },
    { direction: 'tx', packet: [1, 0xaa, 0x55, 0, 0, 0, 0, 0] }
  ]);
  await service.disconnect();
  assert.equal(handle.closed, true);
  assert.equal(statuses.at(-1).connected, false);
});

test('HID 连续输入报告保持各自边界，不会被空闲超时错误合并', async () => {
  const packets = [];
  let handle;
  const module = {
    devices: () => [],
    HID: class extends FakeHid { constructor(path) { super(path); handle = this; } }
  };
  const service = new HidCommunicationService((direction, packet) => packets.push({ direction, packet: [...packet] }), () => {}, () => module);
  await service.connect({ path: 'hid-path', packetTimeoutMs: 100 });
  handle.emit('data', Buffer.from([1, 2]));
  handle.emit('data', Buffer.from([3, 4]));
  assert.deepEqual(packets, [
    { direction: 'rx', packet: [1, 2] },
    { direction: 'rx', packet: [3, 4] }
  ]);
  await service.disconnect();
});
