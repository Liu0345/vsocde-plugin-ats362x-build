export const HID_OUTPUT_REPORT_ID = 0x01;
export const HID_INPUT_REPORT_ID = 0x02;
export const HID_REPORT_PAYLOAD = 63;
export const HID_DATA_CHUNK = 39;

export const HidMessage = {
  Info: 0x21,
  Begin: 0x22,
  Data: 0x23,
  End: 0x24,
  StatusRequest: 0x25,
  Abort: 0x26,
  InfoResult: 0xa1,
  Ack: 0xa2,
  Status: 0xa3
} as const;

const MAGIC = 0xaa55;
const VERSION = 2;
const HEADER_SIZE = 18;
const CRC_SIZE = 2;
const FLAG_FIN = 1;

export interface ParsedFrame {
  type: number;
  flags: number;
  seq: number;
  totalLength: number;
  offset: number;
  payload: Buffer;
}

export function buildFrame(type: number, seq: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > HID_REPORT_PAYLOAD - HEADER_SIZE - CRC_SIZE) {
    throw new Error(`HID 载荷过长：${payload.length}`);
  }
  const frame = Buffer.alloc(HID_REPORT_PAYLOAD);
  frame.writeUInt16LE(MAGIC, 0);
  frame[2] = VERSION;
  frame[3] = type;
  frame[4] = FLAG_FIN;
  frame.writeUInt16LE(seq & 0xffff, 5);
  frame.writeUInt32LE(payload.length, 7);
  frame.writeUInt32LE(0, 11);
  frame.writeUInt16LE(payload.length, 15);
  frame[17] = 0;
  payload.copy(frame, HEADER_SIZE);
  frame.writeUInt16LE(crc16X25(frame.subarray(0, HEADER_SIZE + payload.length)), HEADER_SIZE + payload.length);
  return frame;
}

export function parseFrame(report: Buffer): ParsedFrame {
  const frame = report.length === HID_REPORT_PAYLOAD + 1 ? report.subarray(1) : report;
  if (frame.length < HEADER_SIZE + CRC_SIZE || frame.readUInt16LE(0) !== MAGIC) {
    throw new Error('不是 ATS362X HID DFU 帧');
  }
  if (frame[2] !== VERSION) {
    throw new Error(`不支持的 HID DFU 协议版本：${frame[2]}`);
  }
  const payloadLength = frame.readUInt16LE(15);
  if (payloadLength > HID_REPORT_PAYLOAD - HEADER_SIZE - CRC_SIZE || HEADER_SIZE + payloadLength + CRC_SIZE > frame.length) {
    throw new Error('HID DFU 帧长度无效');
  }
  const expected = crc16X25(frame.subarray(0, HEADER_SIZE + payloadLength));
  const actual = frame.readUInt16LE(HEADER_SIZE + payloadLength);
  if (expected !== actual) {
    throw new Error(`HID DFU 帧 CRC 错误：0x${actual.toString(16)} != 0x${expected.toString(16)}`);
  }
  return {
    type: frame[3],
    flags: frame[4],
    seq: frame.readUInt16LE(5),
    totalLength: frame.readUInt32LE(7),
    offset: frame.readUInt32LE(11),
    payload: Buffer.from(frame.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength))
  };
}

export function makeBeginPayload(image: Buffer, expectedBcd: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUInt32LE(image.length, 0);
  payload.writeUInt32LE(crc32IsoHdlc(image), 4);
  payload.writeUInt16LE(expectedBcd & 0xffff, 8);
  return payload;
}

export function makeDataPayload(offset: number, chunk: Buffer): Buffer {
  if (chunk.length === 0 || chunk.length > HID_DATA_CHUNK) {
    throw new Error(`HID DFU 数据块长度必须为 1..${HID_DATA_CHUNK}`);
  }
  const payload = Buffer.alloc(4 + chunk.length);
  payload.writeUInt32LE(offset, 0);
  chunk.copy(payload, 4);
  return payload;
}

export function readAckError(frame: ParsedFrame, expectedType: number): number {
  if (frame.type !== HidMessage.Ack || frame.payload.length < 24) {
    throw new Error('设备没有返回完整 ACK');
  }
  if (frame.payload[2] !== expectedType) {
    throw new Error(`ACK 类型不匹配：0x${frame.payload[2].toString(16)}`);
  }
  return frame.payload.readUInt32LE(16);
}

export function crc16X25(data: Uint8Array): number {
  let crc = 0xffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

export function crc32IsoHdlc(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
