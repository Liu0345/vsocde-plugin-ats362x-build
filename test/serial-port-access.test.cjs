const assert = require('node:assert/strict');
const test = require('node:test');

const { describeSerialPortError } = require('../dist/services/serialPorts.js');

test('串口占用错误转换为明确的中文提示', () => {
  assert.equal(
    describeSerialPortError(new Error('Error: Resource busy, cannot lock port')),
    '串口已被其他程序或任务占用'
  );
});

test('串口断开错误与普通打开错误分别报告', () => {
  assert.equal(describeSerialPortError(new Error('No such file or directory')), '串口不存在或设备已断开');
  assert.equal(describeSerialPortError(new Error('I/O failure')), '串口不可用：I/O failure');
});
