const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chooseFirmware, discoverFirmware } = require('../dist/services/firmwareLocator');

test('firmware discovery includes standard USB DFU files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats362x-dfu-'));
  try {
    const firmware = path.join(root, 'application', 'demo', 'outdir', 'board', '_firmware');
    await fs.mkdir(firmware, { recursive: true });
    const dfuFile = path.join(firmware, 'device.dfu');
    await fs.writeFile(dfuFile, Buffer.from('DfuSe'));
    const result = await discoverFirmware(root);
    assert.equal(result.defaultDirectory, firmware);
    assert.ok(result.files.includes(dfuFile));
    assert.equal(chooseFirmware(dfuFile, result.files, 'any'), dfuFile);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
