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

test('固件扫描包含子目录中的全部文件且不按固定数量截断', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats362x-firmware-all-'));
  try {
    const firmware = path.join(root, 'application', 'demo', 'outdir', 'board', '_firmware');
    const nested = path.join(firmware, 'bin', 'release');
    await fs.mkdir(nested, { recursive: true });
    const expected = [];
    for (let index = 0; index < 35; index += 1) {
      const file = path.join(nested, `firmware_${String(index).padStart(2, '0')}_ota.bin`);
      expected.push(file);
      await fs.writeFile(file, Buffer.from([index]));
    }
    const result = await discoverFirmware(root);
    assert.equal(result.files.length, expected.length);
    assert.deepEqual(new Set(result.files), new Set(expected));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
