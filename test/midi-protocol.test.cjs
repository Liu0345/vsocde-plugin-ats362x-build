const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeMidiDfuFrame,
  encodeMidiDfuFrame,
  MidiDfuCommand,
  MidiSysexParser,
  packMidi7,
  parseExpectedBcd,
  parseMidiDfuIdentity,
  unpackMidi7
} = require('../dist/services/midiProtocol');
const { MidiDfuClient, MidiTimeoutError, pairMidiPorts } = require('../dist/services/midiDfu');

const hex = (value) => Buffer.from(value.replace(/\s+/g, ''), 'hex');

test('MFU/1 INFO 固定向量与参考实现完全一致', () => {
  const expected = hex('f0 7d 4d 46 55 01 00 01 01 00 00 00 01 00 70 00 00 00 00 37 56 17 01 0e f7');
  const actual = encodeMidiDfuFrame(MidiDfuCommand.Info, 1, 1);
  assert.deepEqual(actual, expected);
  assert.deepEqual(decodeMidiDfuFrame(actual), {
    command: MidiDfuCommand.Info,
    session: 1,
    sequence: 1,
    payload: Buffer.alloc(0)
  });
});

test('MFU/1 DATA 固定向量保留高位字节并与参考实现完全一致', () => {
  const payload = hex('00 00 00 00 41 4f 54 41 80 f0 f7 ff');
  const expected = hex('f0 7d 4d 46 55 01 00 03 01 00 00 00 01 00 00 00 00 0c 00 00 00 00 60 00 41 4f 54 41 00 70 0f 77 7f 12 7f 50 5d f7');
  const actual = encodeMidiDfuFrame(MidiDfuCommand.Data, 1, 1, payload);
  assert.deepEqual(actual, expected);
  assert.deepEqual(decodeMidiDfuFrame(actual).payload, payload);
});

test('SysEx7 pack/unpack 对全部字节值可逆', () => {
  const raw = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const packed = packMidi7(raw);
  assert.ok([...packed].every((value) => value <= 0x7f));
  assert.deepEqual(unpackMidi7(packed), raw);
  assert.throws(() => unpackMidi7(Buffer.from([0x02, 0x01])), /尾组掩码/);
});

test('MFU/1 解码拒绝 CRC 损坏和非法字段', () => {
  const frame = encodeMidiDfuFrame(MidiDfuCommand.Info, 1, 1);
  frame[frame.length - 2] ^= 1;
  assert.throws(() => decodeMidiDfuFrame(frame), /CRC32/);
  assert.throws(() => encodeMidiDfuFrame(MidiDfuCommand.Info, 0, 1), /会话号/);
  assert.throws(() => encodeMidiDfuFrame(0, 1, 1), /命令/);
  assert.throws(() => encodeMidiDfuFrame(MidiDfuCommand.Data, 1, 1, Buffer.alloc(1025)), /载荷过长/);
});

test('MIDI 流解析器支持分片、粘包并忽略实时消息', () => {
  const first = encodeMidiDfuFrame(MidiDfuCommand.Info, 1, 1);
  const second = encodeMidiDfuFrame(MidiDfuCommand.Info, 2, 1);
  const parser = new MidiSysexParser();
  assert.deepEqual(parser.push(first.subarray(0, 8)), []);
  const joined = Buffer.concat([first.subarray(8, 12), Buffer.from([0xf8]), first.subarray(12), second]);
  assert.deepEqual(parser.push(joined), [first, second]);
});

test('INFO 身份字段采用严格范围校验', () => {
  const valid = {
    protocol: 1, transport: 'usb-midi', deviceId: 'dev-01', model: 'ATS362X', mode: 'runtime',
    vid: 0x10d6, pid: 0x1234, bcd: 0x124, maxChunk: 512, maxImageSize: 8 * 1024 * 1024
  };
  const parsed = parseMidiDfuIdentity(Buffer.from(JSON.stringify(valid)));
  assert.equal(parsed.deviceId, 'dev-01');
  assert.equal(parsed.maxChunk, 512);
  assert.throws(() => parseMidiDfuIdentity(Buffer.from(JSON.stringify({ ...valid, model: undefined }))), /model/);
  assert.throws(() => parseMidiDfuIdentity(Buffer.from(JSON.stringify({ ...valid, maxChunk: 513 }))), /maxChunk/);
  assert.throws(() => parseMidiDfuIdentity(Buffer.from(JSON.stringify({ ...valid, transport: 'hid' }))), /usb-midi/);
});

test('版本号仅从规范 OTA 文件名提取为十六进制 BCD', () => {
  assert.equal(parseExpectedBcd('ATS362X_V0124_260916_ota.bin'), 0x0124);
  assert.equal(parseExpectedBcd('ATS362X-VABC.ota.bin'), 0x0abc);
  assert.equal(parseExpectedBcd('firmware.bin'), 0);
});

test('同名重复 MIDI 端点使用全组合候选，异名端点按 CoreMIDI 同索引兜底', () => {
  assert.deepEqual(pairMidiPorts(['Device', 'Device', 'Input only'], ['Device', 'Device', 'Output only']), [
    { portName: 'Device', inputIndex: 0, outputIndex: 0 },
    { portName: 'Device', inputIndex: 0, outputIndex: 1 },
    { portName: 'Device', inputIndex: 1, outputIndex: 0 },
    { portName: 'Device', inputIndex: 1, outputIndex: 1 },
    { portName: 'Input only ↔ Output only', inputIndex: 2, outputIndex: 2 }
  ]);
});

test('停等客户端忽略旧会话帧，并只接受当前会话与序号', async () => {
  const statusOk = Buffer.from([0, 0, 0x34, 0x12]);
  const transport = new MockTransport([
    encodeMidiDfuFrame(MidiDfuCommand.Info | MidiDfuCommand.Response, 99, 1, statusOk),
    encodeMidiDfuFrame(MidiDfuCommand.Info | MidiDfuCommand.Response, 7, 1, statusOk)
  ]);
  const client = new MidiDfuClient(transport, 7, () => {});
  assert.deepEqual(await client.exchange(MidiDfuCommand.Info, 1, Buffer.alloc(0), 100, 0), Buffer.from([0x34, 0x12]));
  assert.equal(transport.sent.length, 1);
});

test('停等客户端仅在接收超时时逐字节重发原帧', async () => {
  const response = encodeMidiDfuFrame(MidiDfuCommand.Begin | MidiDfuCommand.Response, 8, 2, Buffer.from([0, 0, 0, 0, 0, 0]));
  const transport = new MockTransport([new MidiTimeoutError('timeout'), response]);
  const client = new MidiDfuClient(transport, 8, () => {});
  assert.deepEqual(await client.exchange(MidiDfuCommand.Begin, 2, Buffer.alloc(10), 100, 2), Buffer.alloc(4));
  assert.equal(transport.sent.length, 2);
  assert.deepEqual(transport.sent[0], transport.sent[1]);
});

test('停等客户端遇到损坏响应不会重发写命令', async () => {
  const response = encodeMidiDfuFrame(MidiDfuCommand.Data | MidiDfuCommand.Response, 9, 3, Buffer.from([0, 0, 4, 0, 0, 0]));
  response[response.length - 2] ^= 1;
  const transport = new MockTransport([response]);
  const client = new MidiDfuClient(transport, 9, () => {});
  await assert.rejects(client.exchange(MidiDfuCommand.Data, 3, Buffer.alloc(4), 100, 2), /CRC32/);
  assert.equal(transport.sent.length, 1);
});

class MockTransport {
  constructor(received) {
    this.received = [...received];
    this.sent = [];
  }
  async send(frame) { this.sent.push(Buffer.from(frame)); }
  async receive() {
    const value = this.received.shift();
    if (value instanceof Error) throw value;
    if (!value) throw new MidiTimeoutError('empty');
    return value;
  }
}
