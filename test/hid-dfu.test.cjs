const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMacUsbAudioDeviceIds } = require('../dist/services/hidDfu');

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
