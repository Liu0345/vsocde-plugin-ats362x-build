const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildFrame,
  crc16X25,
  crc32IsoHdlc,
  HID_DATA_CHUNK,
  HidMessage,
  makeBeginPayload,
  makeDataPayload,
  parseFrame
} = require('../dist/services/hidProtocol');

test('CRC algorithms match standard check vector', () => {
  const vector = Buffer.from('123456789', 'ascii');
  assert.equal(crc16X25(vector), 0x906e);
  assert.equal(crc32IsoHdlc(vector), 0xcbf43926);
});

test('frame round-trip preserves message fields and payload', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const parsed = parseFrame(buildFrame(HidMessage.Data, 0x1234, payload));
  assert.equal(parsed.type, HidMessage.Data);
  assert.equal(parsed.seq, 0x1234);
  assert.equal(parsed.totalLength, payload.length);
  assert.deepEqual(parsed.payload, payload);
});

test('frame parser rejects corruption', () => {
  const frame = buildFrame(HidMessage.Begin, 1, Buffer.alloc(10));
  frame[18] ^= 0x80;
  assert.throws(() => parseFrame(frame), /CRC/);
});

test('begin payload contains size, image CRC and bcdDevice', () => {
  const image = Buffer.from('ATS362X');
  const payload = makeBeginPayload(image, 0x1234);
  assert.equal(payload.readUInt32LE(0), image.length);
  assert.equal(payload.readUInt32LE(4), crc32IsoHdlc(image));
  assert.equal(payload.readUInt16LE(8), 0x1234);
});

test('data payload enforces the firmware 39-byte chunk boundary', () => {
  const chunk = Buffer.alloc(HID_DATA_CHUNK, 0xa5);
  const payload = makeDataPayload(4096, chunk);
  assert.equal(payload.readUInt32LE(0), 4096);
  assert.deepEqual(payload.subarray(4), chunk);
  assert.throws(() => makeDataPayload(0, Buffer.alloc(HID_DATA_CHUNK + 1)), /1\.\.39/);
});
