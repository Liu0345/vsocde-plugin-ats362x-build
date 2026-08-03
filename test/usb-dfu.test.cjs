const assert = require('node:assert/strict');
const test = require('node:test');
const { extractDfuPercentages, parseDfuUtilList } = require('../dist/services/usbDfu');

test('dfu-util list parser preserves runtime target identity and USB path', () => {
  const devices = parseDfuUtilList(`
Found Runtime: [20b1:301f] ver=0020, devnum=3, cfg=1, intf=2, path="0-1.2", alt=0, name="Standard DFU", serial="SN017"
Found DFU: [10d6:10d6] ver=0200, devnum=4, cfg=1, intf=0, path="0-1.3", alt=1, name="Boot DFU", serial="BOOT"
`);
  assert.deepEqual(devices, [
    {
      mode: 'Runtime', vendorId: 0x20b1, productId: 0x301f, usbPath: '0-1.2',
      serialNumber: 'SN017', name: 'Standard DFU', version: '0020', alt: 0
    },
    {
      mode: 'DFU', vendorId: 0x10d6, productId: 0x10d6, usbPath: '0-1.3',
      serialNumber: 'BOOT', name: 'Boot DFU', version: '0200', alt: 1
    }
  ]);
});

test('dfu-util progress parser handles carriage-return progress output', () => {
  const output = 'Download [====            ]  25%\rDownload [========        ]  50%\rDownload [================] 100%';
  assert.deepEqual(extractDfuPercentages(output), [25, 50, 100]);
});
