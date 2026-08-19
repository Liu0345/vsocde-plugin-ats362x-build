const assert = require('node:assert/strict');
const test = require('node:test');
const { extractFlashPercentages } = require('../dist/services/flashRunner');

test('串口烧录进度解析支持百分比输出', () => {
  const output = 'Preparing...\n12%\nDownloading 45%\nDone 99%';
  assert.deepEqual(extractFlashPercentages(output), [12, 45, 99]);
});

test('串口烧录进度解析支持分子分母进度格式', () => {
  const output = '发送中 250/1000\n发送中 500/1000\n发送中 1000/1000';
  assert.deepEqual(extractFlashPercentages(output), [25, 50, 100]);
});
