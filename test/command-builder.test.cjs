const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCommand } = require('../dist/services/commandBuilder');
const { shellQuote } = require('../dist/services/shell');

test('build maps download and remote host to Baton arguments', () => {
  assert.deepEqual(buildCommand({ action: 'build', options: { buildHost: 'builder-ubuntu', download: 'ota', keep: true } }), {
    executable: 'baton',
    args: ['build', '--build-host', 'builder-ubuntu', '--download', 'ota', '--keep']
  });
});

test('build-flash-verify forwards editable App and Board selections', () => {
  assert.deepEqual(buildCommand({
    action: 'buildFlashVerify',
    options: {
      buildHost: 'builder-ubuntu',
      download: 'ota-fw',
      app: 'application/usb-audio-template',
      board: 'ats362x_dvb'
    }
  }), {
    executable: 'baton',
    args: [
      'build-flash-verify', '--build-host', 'builder-ubuntu', '--download', 'ota-fw',
      '--app', 'application/usb-audio-template', '--board', 'ats362x_dvb'
    ]
  });
});

test('USB DFU pins the selected UAC device by VID/PID and physical path', () => {
  const command = buildCommand({
    action: 'usbDfu',
    options: { vidPid: '20b1:301f', usbPath: '0-1.2', alt: 0, reset: true }
  }, '/tmp/fw image.bin');
  assert.deepEqual(command, {
    executable: 'dfu-util',
    args: ['-d', '20b1:301f', '-p', '0-1.2', '-a', '0', '-D', '/tmp/fw image.bin', '-R']
  });
});

test('full erase is marked destructive unless dry-run is enabled', () => {
  assert.equal(buildCommand({ action: 'erase', options: {} }).destructive, true);
  assert.equal(buildCommand({ action: 'erase', options: { dryRun: true } }).destructive, false);
});

test('串口自动烧录根据固件扩展名选择现有方式', () => {
  const ota = buildCommand({ action: 'flash', options: { method: 'auto' } }, '/tmp/app_ota.bin');
  const full = buildCommand({ action: 'flash', options: { method: 'auto' } }, '/tmp/app.fw');
  assert.deepEqual(ota.args, ['flash', '/tmp/app_ota.bin', '--method', 'ota-uart']);
  assert.deepEqual(full.args, ['flash', '/tmp/app.fw', '--method', 'fw-uart']);
  assert.throws(
    () => buildCommand({ action: 'flash', options: { method: 'auto' } }, '/tmp/app.hex'),
    /自动烧录仅支持 \.bin 或 \.fw/
  );
});

test('全擦除可使用一次性 inventory 和设备别名', () => {
  const command = buildCommand({
    action: 'erase',
    options: { entry: 'manual', inventory: '/tmp/inventory.json', device: '1' }
  });
  assert.deepEqual(command.args, [
    'erase-flash', '--entry', 'manual', '--inventory', '/tmp/inventory.json', '--device', '1'
  ]);
});

test('shell quote protects paths and single quotes', () => {
  assert.equal(shellQuote('/tmp/plain.bin'), '/tmp/plain.bin');
  assert.equal(shellQuote('/tmp/a b.bin'), "'/tmp/a b.bin'");
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});
