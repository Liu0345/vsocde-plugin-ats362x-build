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

test('USB DFU uses Baton dfu method and selected firmware', () => {
  const command = buildCommand({ action: 'flash', options: { method: 'dfu', verify: 'enum' } }, '/tmp/fw image.bin');
  assert.deepEqual(command.args, ['flash', '/tmp/fw image.bin', '--method', 'dfu', '--verify', 'enum']);
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
