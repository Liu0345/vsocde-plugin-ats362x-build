const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMacAdfuLocation, slotIdFromLocationId } = require('../dist/services/adfuErase');

test('macOS ADFU 枚举位置转换为 Baton 槽位', () => {
  assert.equal(slotIdFromLocationId(0x01120000), '1-1/2');
  const output = `
+-o IOUSBHostDevice@01120000  <class IOUSBHostDevice>
  {
    "idProduct" = 4310
    "locationID" = 17956864
    "kUSBCurrentConfiguration" = 1
    "idVendor" = 4310
  }
`;
  assert.deepEqual(parseMacAdfuLocation(output, 0x10d6, 0x10d6), {
    locationId: 0x01120000,
    slotId: '1-1/2'
  });
});

test('未配置或 VID PID 不匹配的 USB 设备不会被当成 ADFU', () => {
  const output = `
+-o IOUSBHostDevice@01120000  <class IOUSBHostDevice>
  {
    "idProduct" = 4310
    "locationID" = 17956864
    "kUSBCurrentConfiguration" = 0
    "idVendor" = 4310
  }
`;
  assert.equal(parseMacAdfuLocation(output, 0x10d6, 0x10d6), undefined);
  assert.equal(slotIdFromLocationId(0), undefined);
});
