const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TOOL_REQUIREMENTS,
  parseToolVersion,
  satisfiesMinimumVersion
} = require('../dist/services/toolVersions');

test('工具版本解析兼容 Baton、actions-flash 与 dfu-util 输出', () => {
  assert.equal(parseToolVersion('baton 0.23.0'), '0.23.0');
  assert.equal(parseToolVersion('actions-flash 0.5.0'), '0.5.0');
  assert.equal(parseToolVersion('dfu-util 0.11\nCopyright 2005-2009'), '0.11');
  assert.equal(parseToolVersion('unknown version'), undefined);
});

test('最低版本比较按数值分段而不是字符串比较', () => {
  assert.equal(satisfiesMinimumVersion('0.5.0', '0.5.0'), true);
  assert.equal(satisfiesMinimumVersion('0.10.0', '0.5.0'), true);
  assert.equal(satisfiesMinimumVersion('0.4.9', '0.5.0'), false);
  assert.equal(satisfiesMinimumVersion('3.2', '3.2.0'), true);
});

test('插件声明所有外部与内置工具的最低版本', () => {
  assert.deepEqual(TOOL_REQUIREMENTS, {
    baton: '0.23.0',
    'actions-flash': '0.5.0',
    'dfu-util': '0.11',
    'node-hid': '3.2.0'
  });
});
