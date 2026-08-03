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

test('shell quote protects paths and single quotes', () => {
  assert.equal(shellQuote('/tmp/plain.bin'), '/tmp/plain.bin');
  assert.equal(shellQuote('/tmp/a b.bin'), "'/tmp/a b.bin'");
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});
