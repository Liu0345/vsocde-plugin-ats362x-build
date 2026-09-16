import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Input, Output } from '@julusian/midi';
import { MidiDfuDeviceInfo } from '../types';
import { crc32IsoHdlc } from './hidProtocol';
import {
  decodeMidiDfuFrame,
  encodeMidiDfuFrame,
  MIDI_DFU_MAX_IMAGE,
  MidiDfuCommand,
  MidiDfuIdentity,
  MidiSysexParser,
  parseExpectedBcd,
  parseMidiDfuIdentity,
  parseMidiDfuResponse
} from './midiProtocol';

const INFO_TIMEOUT_MS = 750;
const ACK_TIMEOUT_MS = 3000;
const FINISH_TIMEOUT_MS = 30000;
const RECONNECT_TIMEOUT_MS = 60000;
const RECONNECT_INTERVAL_MS = 500;
const SEND_TIMEOUT_MS = 6000;
const MAX_CANDIDATES = 16;

type MidiLibrary = typeof import('@julusian/midi');

export interface MidiPortCandidate {
  portName: string;
  inputIndex: number;
  outputIndex: number;
}

interface QualifiedCandidate {
  candidate: MidiPortCandidate;
  identity: MidiDfuIdentity;
}

export class MidiTimeoutError extends Error {}

export interface MidiFrameTransport {
  send(frame: Buffer): Promise<void>;
  receive(timeoutMs: number): Promise<Buffer>;
}

/**
 * 优先将同名输入/输出端点组成候选；CoreMIDI 某些驱动会给同一实体的两个方向使用
 * 不同名称，因此再加入同索引候选。重复名称采用全组合探测，所有候选最终都必须通过
 * MFU/1 INFO 回包确认，不能仅凭名称或枚举顺序开始写入。
 */
export function pairMidiPorts(inputNames: string[], outputNames: string[]): MidiPortCandidate[] {
  const candidates: MidiPortCandidate[] = [];
  inputNames.forEach((inputName, inputIndex) => {
    outputNames.forEach((outputName, outputIndex) => {
      if (inputName === outputName) candidates.push({ portName: inputName, inputIndex, outputIndex });
    });
  });
  for (let index = 0; index < Math.min(inputNames.length, outputNames.length); index += 1) {
    if (!candidates.some((item) => item.inputIndex === index && item.outputIndex === index)) {
      candidates.push({ portName: `${inputNames[index]} ↔ ${outputNames[index]}`, inputIndex: index, outputIndex: index });
    }
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(`双向 MIDI 端点候选过多（${candidates.length} 个），请断开无关 MIDI 设备后重试`);
  }
  return candidates;
}

export class MidiDfuService {
  private activeTransport?: MidiTransport;
  private operationActive = false;
  private cancelled = false;

  public async list(): Promise<MidiDfuDeviceInfo[]> {
    if (this.operationActive) throw new Error('MIDI DFU 正在进行，暂时不能重新扫描');
    this.operationActive = true;
    this.cancelled = false;
    try {
      const qualified = await this.discoverQualified();
      return qualified.map((item) => toDeviceInfo(item));
    } finally {
      this.activeTransport?.close();
      this.activeTransport = undefined;
      this.operationActive = false;
    }
  }

  public cancel(): void {
    this.cancelled = true;
    this.activeTransport?.close();
  }

  public dispose(): void {
    this.cancel();
  }

  public async upload(
    selected: MidiDfuDeviceInfo,
    firmwarePath: string,
    onProgress: (percent: number, detail: string) => void,
    onLog: (text: string) => void
  ): Promise<void> {
    if (this.operationActive) throw new Error('MIDI DFU 已在进行');
    this.operationActive = true;
    this.cancelled = false;
    let transport: MidiTransport | undefined;
    let beginAttempted = false;
    let committing = false;
    let session = 1;
    let sequence = 1;
    try {
      const image = await readOtaImage(firmwarePath);
      const imageCrc = crc32IsoHdlc(image);
      const expectedBcd = parseExpectedBcd(path.basename(firmwarePath));
      onLog(`固件：${firmwarePath}\n`);
      onLog(`大小：${image.length} 字节，CRC32：0x${imageCrc.toString(16).padStart(8, '0')}，目标版本：${expectedBcd ? formatBcd(expectedBcd) : '文件名未声明'}\n`);
      onProgress(0, '正在重新确认所选 MIDI DFU 设备');

      const candidates = await this.discoverQualified();
      const matches = candidates.filter((item) => sameIdentity(item.identity, selected));
      if (matches.length !== 1) {
        throw new Error(matches.length === 0
          ? '所选 MIDI DFU 设备已离线或身份发生变化，请重新扫描'
          : '检测到多个身份相同的 MIDI DFU 设备，无法安全锁定目标');
      }
      const target = matches[0];
      session = randomNonZeroUint32();
      transport = await MidiTransport.open(target.candidate);
      this.activeTransport = transport;
      const client = new MidiDfuClient(transport, session, () => this.assertNotCancelled());
      const liveIdentity = parseMidiDfuIdentity(
        await client.exchange(MidiDfuCommand.Info, sequence++, Buffer.alloc(0), ACK_TIMEOUT_MS, 2)
      );
      if (!sameIdentity(liveIdentity, selected) || !sameBootSession(liveIdentity.bootId, selected.bootId)) {
        throw new Error('MIDI DFU 传输连接对应的设备已变化，请重新扫描并选择');
      }
      if (image.length > liveIdentity.maxImageSize) {
        throw new Error(`固件大小 ${image.length} 超过设备上限 ${liveIdentity.maxImageSize}`);
      }

      const beginPayload = Buffer.alloc(10);
      beginPayload.writeUInt32LE(image.length, 0);
      beginPayload.writeUInt32LE(imageCrc, 4);
      beginPayload.writeUInt16LE(expectedBcd, 8);
      beginAttempted = true;
      onLog(`BEGIN session=0x${session.toString(16).padStart(8, '0')}\n`);
      const beginResponse = await client.exchange(MidiDfuCommand.Begin, sequence++, beginPayload, ACK_TIMEOUT_MS, 2);
      requireExactLength(beginResponse, 4, 'BEGIN ACK');
      if (beginResponse.readUInt32LE(0) !== 0) throw new Error('MIDI DFU BEGIN ACK 的起始偏移不是 0');

      const chunkSize = Math.min(liveIdentity.maxChunk, 512);
      let offset = 0;
      let lastReported = 0;
      while (offset < image.length) {
        this.assertNotCancelled();
        const chunk = image.subarray(offset, Math.min(offset + chunkSize, image.length));
        const payload = Buffer.alloc(4 + chunk.length);
        payload.writeUInt32LE(offset, 0);
        chunk.copy(payload, 4);
        const response = await client.exchange(MidiDfuCommand.Data, sequence++, payload, ACK_TIMEOUT_MS, 2);
        requireExactLength(response, 4, 'DATA ACK');
        const nextOffset = response.readUInt32LE(0);
        const expectedOffset = offset + chunk.length;
        if (nextOffset !== expectedOffset) {
          throw new Error(`MIDI DFU DATA ACK 偏移错误：${nextOffset}，期望 ${expectedOffset}`);
        }
        offset = nextOffset;
        if (offset === image.length || offset - lastReported >= 4096) {
          const percent = Math.floor(offset * 100 / image.length);
          onProgress(percent, `MIDI DFU 已写入 ${offset} / ${image.length} 字节`);
          onLog(`DATA ${offset}/${image.length} (${percent}%)\n`);
          lastReported = offset;
        }
      }

      committing = true;
      onProgress(100, '固件已传输，正在请求设备校验并提交');
      const finish = await client.exchange(MidiDfuCommand.Finish, sequence++, Buffer.alloc(0), FINISH_TIMEOUT_MS, 2);
      requireExactLength(finish, 8, 'FINISH ACK');
      if (finish.readUInt32LE(0) !== image.length || finish.readUInt32LE(4) !== imageCrc) {
        throw new Error('MIDI DFU FINISH 返回的固件大小或 CRC32 与本地不一致');
      }
      onLog('FINISH 校验通过\n');

      try {
        const reboot = await client.exchange(MidiDfuCommand.Reboot, sequence++, Buffer.alloc(0), ACK_TIMEOUT_MS, 0);
        requireExactLength(reboot, 0, 'REBOOT ACK');
      } catch (error) {
        if (!(error instanceof MidiTimeoutError) && !this.cancelled) throw error;
        onLog('REBOOT 后连接已断开，转入设备重枚举校验\n');
      }
      transport.close();
      transport = undefined;
      this.activeTransport = undefined;

      onProgress(100, '正在等待设备重启并复核版本');
      await this.verifyAfterReboot(liveIdentity, expectedBcd, onLog);
      onProgress(100, 'MIDI DFU 完成，设备身份与版本复核通过');
    } catch (error) {
      if (this.cancelled) throw new Error('MIDI DFU 已取消');
      if (transport && beginAttempted && !committing) {
        try {
          const client = new MidiDfuClient(transport, session, () => undefined);
          await client.exchange(MidiDfuCommand.Abort, sequence, Buffer.alloc(0), ACK_TIMEOUT_MS, 0);
          onLog('ABORT 已发送\n');
        } catch {
          onLog('ABORT 未得到确认，连接将被关闭\n');
        }
      }
      throw error;
    } finally {
      transport?.close();
      this.activeTransport = undefined;
      this.operationActive = false;
    }
  }

  private async verifyAfterReboot(expected: MidiDfuIdentity, expectedBcd: number, onLog: (text: string) => void): Promise<void> {
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.assertNotCancelled();
      const matches = (await this.discoverQualified()).filter((item) => sameIdentity(item.identity, expected));
      if (matches.length > 1) throw new Error('设备重启后出现多个相同身份的 MIDI DFU 设备，无法完成安全复核');
      if (matches.length === 1) {
        const actual = matches[0].identity.bcdDevice;
        onLog(`重枚举：${matches[0].identity.deviceId}，版本 ${formatBcd(actual)}\n`);
        if (expectedBcd === 0 || actual === expectedBcd) return;
      }
      await abortableDelay(RECONNECT_INTERVAL_MS, () => this.cancelled);
    }
    throw new Error(expectedBcd
      ? `设备重启后 60 秒内未出现目标版本 ${formatBcd(expectedBcd)}`
      : '设备重启后 60 秒内未重新发现相同身份的 MIDI DFU 设备');
  }

  private async discoverQualified(): Promise<QualifiedCandidate[]> {
    const midi = loadMidiLibrary();
    const candidates = pairMidiPorts(midi.Input.getPortNames(), midi.Output.getPortNames());
    const qualified: QualifiedCandidate[] = [];
    for (const candidate of candidates) {
      if (this.cancelled) this.assertNotCancelled();
      try {
        const identity = await probeCandidate(candidate, 0, (transport) => { this.activeTransport = transport; });
        qualified.push({ candidate, identity });
      } catch (error) {
        if (this.cancelled) this.assertNotCancelled();
        if (!(error instanceof MidiTimeoutError)) {
          // 非 MFU/1 设备可能返回其他 SysEx 或格式错误；扫描只展示完成严格 INFO 校验的设备。
        }
      } finally {
        this.activeTransport = undefined;
      }
    }
    return qualified;
  }

  private assertNotCancelled(): void {
    if (this.cancelled) throw new Error('MIDI DFU 已取消');
  }
}

export class MidiDfuClient {
  public constructor(
    private readonly transport: MidiFrameTransport,
    private readonly session: number,
    private readonly checkCancelled: () => void
  ) {}

  public async exchange(command: number, sequence: number, payload: Buffer, timeoutMs: number, retryCount: number): Promise<Buffer> {
    const frame = encodeMidiDfuFrame(command, this.session, sequence, payload);
    for (let attempt = 0; ; attempt += 1) {
      this.checkCancelled();
      await withTimeout(this.transport.send(frame), SEND_TIMEOUT_MS, 'MIDI DFU 发送超时');
      try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const response = decodeMidiDfuFrame(await this.transport.receive(Math.max(1, deadline - Date.now())));
          if (response.session !== this.session || response.sequence !== sequence) continue;
          return parseMidiDfuResponse(response, command, this.session, sequence);
        }
        throw new MidiTimeoutError(`MIDI DFU 等待响应超时（${timeoutMs} ms）`);
      } catch (error) {
        if (!(error instanceof MidiTimeoutError) || attempt >= retryCount) throw error;
      }
    }
  }
}

class MidiTransport implements MidiFrameTransport {
  private readonly parser = new MidiSysexParser();
  private readonly frames: Buffer[] = [];
  private waiter?: { resolve: (frame: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private closed = false;
  private readonly onMessage = (_deltaTime: number, bytes: Buffer): void => {
    for (const frame of this.parser.push(bytes)) {
      if (frame.length < 7 || frame[0] !== 0xf0 || frame[1] !== 0x7d || frame[2] !== 0x4d || frame[3] !== 0x46 || frame[4] !== 0x55 || frame[5] !== 0x01) continue;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else if (this.frames.length < 32) {
        this.frames.push(frame);
      } else {
        this.close(new Error('MIDI DFU 接收队列溢出'));
      }
    }
  };

  private constructor(private readonly input: Input, private readonly output: Output) {}

  public static async open(candidate: MidiPortCandidate): Promise<MidiTransport> {
    const midi = loadMidiLibrary();
    const input = new midi.Input();
    const output = new midi.Output();
    const transport = new MidiTransport(input, output);
    try {
      input.setBufferSize(4096, 32);
      input.ignoreTypes(false, true, true);
      input.on('messageBuffer', transport.onMessage);
      input.openPort(candidate.inputIndex);
      output.openPort(candidate.outputIndex);
      return transport;
    } catch (error) {
      transport.close();
      throw new Error(`无法打开 MIDI 端点 ${candidate.portName}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async send(frame: Buffer): Promise<void> {
    if (this.closed) throw new Error('MIDI DFU 连接已关闭');
    this.output.send(frame);
  }

  public receive(timeoutMs: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('MIDI DFU 连接已关闭'));
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.waiter) return Promise.reject(new Error('MIDI DFU 同时存在多个接收请求'));
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.timer !== timer) return;
        this.waiter = undefined;
        reject(new MidiTimeoutError(`MIDI DFU 等待响应超时（${timeoutMs} ms）`));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  public close(reason = new Error('MIDI DFU 连接已关闭')): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off('messageBuffer', this.onMessage);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.frames.length = 0;
    try { if (this.output.isPortOpen()) this.output.closePort(); } catch {}
    try { if (this.input.isPortOpen()) this.input.closePort(); } catch {}
    try { this.output.destroy(); } catch {}
    try { this.input.destroy(); } catch {}
  }
}

async function probeCandidate(candidate: MidiPortCandidate, retryCount: number, opened?: (transport: MidiTransport) => void): Promise<MidiDfuIdentity> {
  const transport = await MidiTransport.open(candidate);
  opened?.(transport);
  try {
    const session = randomNonZeroUint32();
    const client = new MidiDfuClient(transport, session, () => undefined);
    const payload = await client.exchange(MidiDfuCommand.Info, 1, Buffer.alloc(0), INFO_TIMEOUT_MS, retryCount);
    return parseMidiDfuIdentity(payload);
  } finally {
    transport.close();
  }
}

function loadMidiLibrary(): MidiLibrary {
  try {
    const midi = require('@julusian/midi/lazy') as MidiLibrary;
    midi.verifyLibraryLoaded();
    return midi;
  } catch (error) {
    throw new Error(`MIDI 运行库加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readOtaImage(firmwarePath: string): Promise<Buffer> {
  if (path.extname(firmwarePath).toLowerCase() !== '.bin') throw new Error('MIDI DFU 仅支持 OTA .bin 固件');
  const stat = await fs.stat(firmwarePath);
  if (!stat.isFile()) throw new Error('MIDI DFU 固件路径不是文件');
  if (stat.size < 4 || stat.size > MIDI_DFU_MAX_IMAGE) throw new Error(`MIDI DFU 固件大小必须为 4..${MIDI_DFU_MAX_IMAGE} 字节`);
  const image = await fs.readFile(firmwarePath);
  if (image.subarray(0, 4).toString('ascii') !== 'AOTA') throw new Error('MIDI DFU 仅接受以 AOTA 开头的 OTA 固件');
  return image;
}

function toDeviceInfo(item: QualifiedCandidate): MidiDfuDeviceInfo {
  const identity = item.identity;
  return {
    key: JSON.stringify([identity.deviceId, identity.vendorId, identity.productId, identity.model ?? '', item.candidate.portName, item.candidate.inputIndex, item.candidate.outputIndex]),
    portName: item.candidate.portName,
    deviceId: identity.deviceId,
    bootId: identity.bootId,
    model: identity.model,
    vendorId: identity.vendorId,
    productId: identity.productId,
    bcdDevice: identity.bcdDevice,
    maxChunk: identity.maxChunk,
    maxImageSize: identity.maxImageSize
  };
}

function sameIdentity(actual: MidiDfuIdentity, expected: MidiDfuIdentity | MidiDfuDeviceInfo): boolean {
  return actual.deviceId === expected.deviceId &&
    actual.vendorId === expected.vendorId &&
    actual.productId === expected.productId &&
    (actual.model ?? '') === (expected.model ?? '');
}

function sameBootSession(actual: string | undefined, expected: string | undefined): boolean {
  return actual === undefined || expected === undefined || actual === expected;
}

function randomNonZeroUint32(): number {
  let value = 0;
  while (value === 0) value = randomBytes(4).readUInt32LE(0);
  return value;
}

function requireExactLength(payload: Buffer, expected: number, label: string): void {
  if (payload.length !== expected) throw new Error(`${label} 长度错误：${payload.length}，期望 ${expected}`);
}

function formatBcd(value: number): string {
  return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new MidiTimeoutError(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function abortableDelay(milliseconds: number, cancelled: () => boolean): Promise<void> {
  if (cancelled()) throw new Error('MIDI DFU 已取消');
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  if (cancelled()) throw new Error('MIDI DFU 已取消');
}
