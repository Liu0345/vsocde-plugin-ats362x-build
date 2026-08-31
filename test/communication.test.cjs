const assert = require('node:assert/strict');
const test = require('node:test');

const {
  IdlePacketAssembler,
  appendLineEnding,
  encodeCommunicationData,
  formatCommunicationData,
  prepareHidReport,
  validatePacketTimeout
} = require('../dist/services/communicationCodec.js');

test('文本和十六进制收发编解码保持字节准确', () => {
  const text = encodeCommunicationData('调试 OK', 'text');
  assert.equal(text.toString('utf8'), '调试 OK');
  assert.equal(formatCommunicationData(text, 'text'), '调试 OK');

  const hex = encodeCommunicationData('0xAA, 55\n01-02', 'hex');
  assert.deepEqual([...hex], [0xaa, 0x55, 0x01, 0x02]);
  assert.equal(formatCommunicationData(hex, 'hex'), 'AA 55 01 02');
  assert.throws(() => encodeCommunicationData('ABC', 'hex'), /偶数/);
  assert.throws(() => encodeCommunicationData('GG', 'hex'), /十六进制/);
});

test('文本发送支持常见换行方式', () => {
  assert.equal(appendLineEnding('AT', 'none'), 'AT');
  assert.equal(appendLineEnding('AT', 'cr'), 'AT\r');
  assert.equal(appendLineEnding('AT', 'lf'), 'AT\n');
  assert.equal(appendLineEnding('AT', 'crlf'), 'AT\r\n');
});

test('分包器按自定义空闲超时稳定合并数据并可立即冲刷', async () => {
  const packets = [];
  const assembler = new IdlePacketAssembler(15, (packet) => packets.push([...packet]));
  assembler.push(Buffer.from([1, 2]));
  assembler.push(Buffer.from([3]));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(packets, [[1, 2, 3]]);

  assembler.push(Buffer.from([4]));
  assembler.flush();
  assert.deepEqual(packets, [[1, 2, 3], [4]]);
  assembler.dispose();
});

test('持续高速数据达到上限时主动分包，避免内存无限增长', () => {
  const packets = [];
  const assembler = new IdlePacketAssembler(1000, (packet) => packets.push([...packet]), 4);
  assembler.push(Buffer.from([1, 2, 3, 4, 5, 6]));
  assembler.flush();
  assert.deepEqual(packets, [[1, 2, 3, 4], [5, 6]]);
  assembler.dispose();
});

test('分包超时拒绝危险值并限制在 1 到 5000 毫秒', () => {
  assert.equal(validatePacketTimeout(1), 1);
  assert.equal(validatePacketTimeout(5000), 5000);
  assert.throws(() => validatePacketTimeout(0), /1.*5000/);
  assert.throws(() => validatePacketTimeout(5001), /1.*5000/);
});

test('HID 输出报告包含 Report ID、长度检查和可选补零', () => {
  assert.deepEqual([...prepareHidReport(Buffer.from([0xaa, 0x55]), 1, 8, true)], [1, 0xaa, 0x55, 0, 0, 0, 0, 0]);
  assert.deepEqual([...prepareHidReport(Buffer.from([0xaa, 0x55]), 0, 8, false)], [0, 0xaa, 0x55]);
  assert.throws(() => prepareHidReport(Buffer.alloc(8), 1, 8, true), /超过/);
});
