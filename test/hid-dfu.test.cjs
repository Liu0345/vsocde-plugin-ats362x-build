const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMacUsbAudioDeviceIds, parseMacUsbAudioDeviceMetadata } = require('../dist/services/hidDfu');

test('macOS USB 音频 VID/PID 解析支持十进制和十六进制', () => {
  const output = `
+-o IOUSBHostInterface@0x100000000  <class IOUSBHostInterface, id 0x100000abc, registered, matched, active, busy 0, retain 6>
    |   "bInterfaceClass" = 1
    |   "idVendor" = 0x10d6
    |   "idProduct" = 10d6
+-o IOUSBHostInterface@0x100000001  <class IOUSBHostInterface, id 0x100000abd, registered, matched, active, busy 0, retain 6>
    |   "bInterfaceClass" = 0x01
    |   "idVendor" = 4302
    |   "idProduct" = 0x1a2b
  `;
  const ids = parseMacUsbAudioDeviceIds(output);
  assert.deepEqual(Array.from(ids).sort(), ['10d6:10d6', '10ce:1a2b'].sort());
});

test('macOS USB 音频 VID/PID 解析会忽略非音频接口', () => {
  const output = `
+-o IOUSBHostInterface@0x100000001  <class IOUSBHostInterface, id 0x100000abd, registered, matched, active, busy 0, retain 6>
    |   "bInterfaceClass" = 0x0e
    |   "idVendor" = 0x10d6
    |   "idProduct" = 0x1a2b
`;
  const ids = parseMacUsbAudioDeviceIds(output);
  assert.equal(ids.size, 0);
});

test('macOS USB 音频扫描独立聚合设备和 DFU 描述符', () => {
  const output = `
+-o IOUSBHostInterface@0  <class IOUSBHostInterface>
  |   "bInterfaceClass" = 1
  |   "locationID" = 1179648
  |   "idVendor" = 5418
  |   "idProduct" = 34941
  |   "bcdDevice" = 1
  |   "USB Vendor Name" = "Xrecer"
  |   "USB Product Name" = "Vocal Pedal"
+-o Xrecer DFU@3  <class IOUSBHostInterface>
  |   "bInterfaceClass" = 254
  |   "locationID" = 1179648
  |   "idVendor" = 5418
  |   "idProduct" = 34941
  |   "bcdDevice" = 1
  |   "kUSBString" = "Xrecer DFU"
`;
  assert.deepEqual(parseMacUsbAudioDeviceMetadata(output), [{
    vendorId: 0x152a,
    productId: 0x887d,
    locationId: 1179648,
    manufacturer: 'Xrecer',
    product: 'Vocal Pedal',
    version: '0001',
    dfuName: 'Xrecer DFU'
  }]);
});
