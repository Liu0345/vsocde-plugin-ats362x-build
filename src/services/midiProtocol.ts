import { crc32IsoHdlc } from './hidProtocol';

export const MIDI_DFU_PREFIX = Buffer.from([0xf0, 0x7d, 0x4d, 0x46, 0x55, 0x01]);
export const MIDI_DFU_MAX_FRAME = 1200;
export const MIDI_DFU_MAX_PAYLOAD = 1024;
export const MIDI_DFU_MAX_CHUNK = 512;
export const MIDI_DFU_MAX_IMAGE = 64 * 1024 * 1024;

export const MidiDfuCommand = {
  Info: 0x01,
  Begin: 0x02,
  Data: 0x03,
  Finish: 0x04,
  Reboot: 0x05,
  Abort: 0x06,
  Response: 0x40
} as const;

export interface MidiDfuFrame {
  command: number;
  session: number;
  sequence: number;
  payload: Buffer;
}

export interface MidiDfuIdentity {
  protocol: 1;
  transport: 'usb-midi';
  deviceId: string;
  bootId?: string;
  model: string;
  mode: 'runtime';
  vendorId: number;
  productId: number;
  bcdDevice: number;
  maxChunk: number;
  maxImageSize: number;
  lastImageSize?: number;
  lastImageCrc32?: number;
}

export function packMidi7(raw: Uint8Array): Buffer {
  const packed: number[] = [];
  for (let offset = 0; offset < raw.length; offset += 7) {
    const group = raw.subarray(offset, Math.min(offset + 7, raw.length));
    let mask = 0;
    for (let index = 0; index < group.length; index += 1) {
      if ((group[index] & 0x80) !== 0) mask |= 1 << index;
    }
    packed.push(mask);
    for (const value of group) packed.push(value & 0x7f);
  }
  return Buffer.from(packed);
}

export function unpackMidi7(packed: Uint8Array): Buffer {
  const raw: number[] = [];
  for (let offset = 0; offset < packed.length;) {
    const mask = packed[offset++];
    if (mask > 0x7f) throw new Error('MIDI DFU 7-bit 数据掩码无效');
    const groupLength = Math.min(7, packed.length - offset);
    if (groupLength === 0) throw new Error('MIDI DFU 7-bit 数据不完整');
    if ((mask >>> groupLength) !== 0) throw new Error('MIDI DFU 7-bit 尾组掩码包含无效位');
    for (let index = 0; index < groupLength; index += 1) {
      const value = packed[offset++];
      if (value > 0x7f) throw new Error('MIDI DFU SysEx 中包含非法的 8-bit 数据');
      raw.push(value | (((mask >>> index) & 1) << 7));
    }
  }
  return Buffer.from(raw);
}

export function encodeMidiDfuFrame(command: number, session: number, sequence: number, payload: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!Number.isInteger(command) || command < 1 || command > 0x7f) throw new Error('MIDI DFU 命令必须为 1..0x7f');
  assertUint32('会话号', session);
  assertUint32('序号', sequence);
  if (payload.length > MIDI_DFU_MAX_PAYLOAD) throw new Error(`MIDI DFU 载荷过长：${payload.length}`);
  const raw = Buffer.alloc(11 + payload.length + 4);
  raw[0] = command & 0xff;
  raw.writeUInt32LE(session >>> 0, 1);
  raw.writeUInt32LE(sequence >>> 0, 5);
  raw.writeUInt16LE(payload.length, 9);
  Buffer.from(payload).copy(raw, 11);
  raw.writeUInt32LE(crc32IsoHdlc(raw.subarray(0, raw.length - 4)), raw.length - 4);
  const frame = Buffer.concat([MIDI_DFU_PREFIX, packMidi7(raw), Buffer.from([0xf7])]);
  if (frame.length < 25 || frame.length > MIDI_DFU_MAX_FRAME) {
    throw new Error(`MIDI DFU 帧长度超出协议范围：${frame.length}`);
  }
  return frame;
}

export function decodeMidiDfuFrame(frame: Uint8Array): MidiDfuFrame {
  const source = Buffer.from(frame);
  if (source.length < 25 || source.length > MIDI_DFU_MAX_FRAME) {
    throw new Error(`MIDI DFU 帧长度无效：${source.length}`);
  }
  if (!source.subarray(0, MIDI_DFU_PREFIX.length).equals(MIDI_DFU_PREFIX) || source[source.length - 1] !== 0xf7) {
    throw new Error('不是 MFU/1 MIDI DFU SysEx 帧');
  }
  const packed = source.subarray(MIDI_DFU_PREFIX.length, source.length - 1);
  for (const value of packed) {
    if (value > 0x7f) throw new Error('MIDI DFU SysEx 中包含非法的 8-bit 数据');
  }
  const raw = unpackMidi7(packed);
  if (raw.length < 15) throw new Error('MIDI DFU 原始帧过短');
  const payloadLength = raw.readUInt16LE(9);
  if (raw[0] < 1 || raw[0] > 0x7f || payloadLength > MIDI_DFU_MAX_PAYLOAD || raw.length !== 11 + payloadLength + 4) {
    throw new Error('MIDI DFU 帧字段或载荷长度无效');
  }
  const session = raw.readUInt32LE(1);
  const sequence = raw.readUInt32LE(5);
  assertUint32('会话号', session);
  assertUint32('序号', sequence);
  const actual = raw.readUInt32LE(raw.length - 4);
  const expected = crc32IsoHdlc(raw.subarray(0, raw.length - 4));
  if (actual !== expected) {
    throw new Error(`MIDI DFU 帧 CRC32 错误：0x${actual.toString(16)} != 0x${expected.toString(16)}`);
  }
  return {
    command: raw[0],
    session,
    sequence,
    payload: Buffer.from(raw.subarray(11, 11 + payloadLength))
  };
}

export function responseCommand(command: number): number {
  return command | MidiDfuCommand.Response;
}

export function parseMidiDfuResponse(frame: MidiDfuFrame, command: number, session: number, sequence: number): Buffer {
  if (frame.command !== responseCommand(command)) throw new Error(`MIDI DFU 响应命令不匹配：0x${frame.command.toString(16)}`);
  if (frame.session !== session || frame.sequence !== sequence) throw new Error('MIDI DFU 响应会话或序号不匹配');
  if (frame.payload.length < 2) throw new Error('MIDI DFU 响应缺少状态码');
  const status = frame.payload.readUInt16LE(0);
  if (status !== 0) throw new Error(`MIDI DFU 设备拒绝命令，状态码 0x${status.toString(16).padStart(4, '0')}`);
  return Buffer.from(frame.payload.subarray(2));
}

export function parseMidiDfuIdentity(payload: Uint8Array): MidiDfuIdentity {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString('utf8'));
  } catch {
    throw new Error('MIDI DFU INFO 返回的 JSON 无效');
  }
  if (!value || typeof value !== 'object') throw new Error('MIDI DFU INFO 返回的对象无效');
  const info = value as Record<string, unknown>;
  const protocol = requireInteger(info.protocol, 'protocol', 1, 1);
  if (info.transport !== 'usb-midi') throw new Error('MIDI DFU INFO transport 必须为 usb-midi');
  if (info.mode !== 'runtime') throw new Error('MIDI DFU INFO mode 必须为 runtime');
  const deviceId = requireString(info.deviceId, 'deviceId');
  const maxChunk = requireInteger(info.maxChunk, 'maxChunk', 1, MIDI_DFU_MAX_CHUNK);
  const maxImageSize = requireInteger(info.maxImageSize, 'maxImageSize', 4, MIDI_DFU_MAX_IMAGE);
  return {
    protocol: protocol as 1,
    transport: 'usb-midi',
    deviceId,
    bootId: optionalString(info.bootId, 'bootId'),
    model: requireString(info.model, 'model'),
    mode: 'runtime',
    vendorId: requireInteger(info.vid, 'vid', 0, 0xffff),
    productId: requireInteger(info.pid, 'pid', 0, 0xffff),
    bcdDevice: requireInteger(info.bcd, 'bcd', 0, 0xffff),
    maxChunk,
    maxImageSize,
    lastImageSize: optionalInteger(info.lastImageSize, 'lastImageSize', 0, MIDI_DFU_MAX_IMAGE),
    lastImageCrc32: optionalInteger(info.lastImageCrc32, 'lastImageCrc32', 0, 0xffffffff)
  };
}

export function parseExpectedBcd(fileName: string): number {
  const match = /(?:^|[_-])V([0-9a-f]{3,4})(?=[_.-])/i.exec(fileName);
  return match ? Number.parseInt(match[1], 16) : 0;
}

/** 将任意分片的 MIDI 字节流重组为完整 SysEx；实时消息不打断当前帧。 */
export class MidiSysexParser {
  private current: number[] | undefined;

  public push(chunk: Uint8Array): Buffer[] {
    const frames: Buffer[] = [];
    for (const byte of chunk) {
      if (byte >= 0xf8) continue;
      if (byte === 0xf0) {
        this.current = [byte];
        continue;
      }
      if (!this.current) continue;
      if (byte === 0xf7) {
        this.current.push(byte);
        frames.push(Buffer.from(this.current));
        this.current = undefined;
        continue;
      }
      if (byte >= 0x80 || this.current.length >= MIDI_DFU_MAX_FRAME) {
        this.current = undefined;
        continue;
      }
      this.current.push(byte);
    }
    return frames;
  }

  public reset(): void {
    this.current = undefined;
  }
}

function assertUint32(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) throw new Error(`${label}必须为 1..0xffffffff`);
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`MIDI DFU INFO ${name} 超出范围`);
  }
  return value as number;
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireInteger(value, name, minimum, maximum);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error(`MIDI DFU INFO ${name} 不能为空或超过 128 字符`);
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}
