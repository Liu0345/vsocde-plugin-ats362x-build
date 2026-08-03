import * as fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HidDeviceInfo } from '../types';
import {
  buildFrame,
  HID_DATA_CHUNK,
  HID_INPUT_REPORT_ID,
  HID_OUTPUT_REPORT_ID,
  HidMessage,
  crc32IsoHdlcUpdate,
  makeBeginPayload,
  makeDataPayload,
  parseFrame,
  ParsedFrame,
  readAckError
} from './hidProtocol';

interface HidHandle extends EventEmitter {
  write(data: number[]): number;
  close(): void;
}

interface NodeHidModule {
  devices(): Array<Record<string, unknown>>;
  HID: new (path: string) => HidHandle;
}

const execFileAsync = promisify(execFile);

export class HidDfuService {
  private active?: HidHandle;
  private cancelled = false;

  public async list(): Promise<HidDeviceInfo[]> {
    const hid = loadNodeHid();
    const uacIds = await detectUsbAudioDeviceIds();
    return hid.devices()
      .filter((device) =>
        typeof device.path === 'string' &&
        Number(device.usagePage ?? 0) >= 0xff00 &&
        Number(device.usage ?? 0) === 1 &&
        uacIds.has(usbId(Number(device.vendorId ?? 0), Number(device.productId ?? 0)))
      )
      .map((device) => ({
        path: String(device.path),
        vendorId: Number(device.vendorId ?? 0),
        productId: Number(device.productId ?? 0),
        product: stringOrUndefined(device.product),
        manufacturer: stringOrUndefined(device.manufacturer),
        serialNumber: stringOrUndefined(device.serialNumber),
        usagePage: numberOrUndefined(device.usagePage),
        usage: numberOrUndefined(device.usage)
      }));
  }

  public async upload(
    devicePath: string,
    firmwarePath: string,
    expectedBcd: number,
    timeoutMs: number,
    onProgress: (percent: number, detail: string) => void
  ): Promise<void> {
    if (this.active) {
      throw new Error('已有 HID DFU 任务正在运行');
    }
    const stat = await fs.stat(firmwarePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`HID DFU 固件大小无效：${stat.size} 字节`);
    }
    if (stat.size > 0xffffffff) {
      throw new Error(`HID DFU 协议使用 32 位长度字段，固件不能超过 ${0xffffffff} 字节`);
    }
    const imageSize = stat.size;
    const imageCrc32 = await crc32File(firmwarePath);

    const hid = loadNodeHid();
    const device = new hid.HID(devicePath);
    this.active = device;
    this.cancelled = false;
    let seq = 1;

    try {
      onProgress(0, '读取设备信息');
      await this.exchange(device, HidMessage.Info, seq++, Buffer.alloc(0), timeoutMs, HidMessage.InfoResult);
      await this.exchange(device, HidMessage.Begin, seq++, makeBeginPayload(imageSize, imageCrc32, expectedBcd), timeoutMs);

      const file = await fs.open(firmwarePath, 'r');
      try {
        const chunk = Buffer.alloc(HID_DATA_CHUNK);
        for (let offset = 0; offset < imageSize;) {
          if (this.cancelled) {
            throw new Error('HID DFU 已取消');
          }
          const requested = Math.min(HID_DATA_CHUNK, imageSize - offset);
          const { bytesRead } = await file.read(chunk, 0, requested, offset);
          if (bytesRead <= 0) {
            throw new Error(`读取 HID DFU 固件失败：offset=${offset}`);
          }
          const payload = makeDataPayload(offset, chunk.subarray(0, bytesRead));
          await this.exchange(device, HidMessage.Data, seq++, payload, timeoutMs);
          offset += bytesRead;
          onProgress(Math.floor((offset * 100) / imageSize), `${offset} / ${imageSize} 字节`);
        }
      } finally {
        await file.close();
      }

      await this.exchange(device, HidMessage.End, seq++, Buffer.alloc(0), Math.max(timeoutMs, 10000));
      onProgress(100, '设备已接受固件，等待自动重启');
    } catch (error) {
      if (!this.cancelled) {
        try {
          await this.exchange(device, HidMessage.Abort, seq++, Buffer.alloc(0), timeoutMs);
        } catch {
          // 主错误优先；设备可能已经重启或断开。
        }
      }
      throw error;
    } finally {
      device.close();
      this.active = undefined;
    }
  }

  public cancel(): void {
    this.cancelled = true;
  }

  private async exchange(
    device: HidHandle,
    type: number,
    seq: number,
    payload: Buffer,
    timeoutMs: number,
    responseType: number = HidMessage.Ack
  ): Promise<ParsedFrame> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await waitForFrame(device, seq, responseType, timeoutMs, () => {
          const report = Buffer.concat([Buffer.from([HID_OUTPUT_REPORT_ID]), buildFrame(type, seq, payload)]);
          device.write([...report]);
        });
        if (responseType === HidMessage.Ack) {
          const error = readAckError(response, type);
          if (error !== 0) {
            throw new Error(`设备拒绝消息 0x${type.toString(16)}，错误码 0x${error.toString(16)}`);
          }
        }
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** 流式计算固件 CRC32，内存占用不随镜像大小增长。 */
async function crc32File(firmwarePath: string): Promise<number> {
  const file = await fs.open(firmwarePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let crc = 0;
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      crc = crc32IsoHdlcUpdate(crc, buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return crc;
  } finally {
    await file.close();
  }
}

/**
 * 从 macOS IORegistry 文本中提取拥有 USB Audio Class 接口的 VID/PID。
 *
 * `-d 0` 的每个顶层段对应一个 USB interface；取每段第一次出现的接口类，
 * 避免把子节点中重复的 bInterfaceClass 误当成另一个设备。
 */
export function parseMacUsbAudioDeviceIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const section of output.split(/(?=^\+-o )/m)) {
    const interfaceClass = firstDecimalProperty(section, 'bInterfaceClass');
    const vendorId = firstDecimalProperty(section, 'idVendor');
    const productId = firstDecimalProperty(section, 'idProduct');
    if (interfaceClass === 1 && vendorId !== undefined && productId !== undefined) {
      ids.add(usbId(vendorId, productId));
    }
  }
  return ids;
}

export async function detectUsbAudioDeviceIds(): Promise<Set<string>> {
  if (process.platform === 'darwin') {
    const result = await execFileAsync(
      'ioreg',
      ['-p', 'IOService', '-r', '-c', 'IOUSBHostInterface', '-l', '-w', '0', '-d', '0'],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }
    );
    return parseMacUsbAudioDeviceIds(result.stdout);
  }
  if (process.platform === 'linux') {
    return detectLinuxUsbAudioDeviceIds();
  }
  if (process.platform === 'win32') {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_SoundDevice).PNPDeviceID'],
      { timeout: 5000 }
    );
    const ids = new Set<string>();
    for (const match of result.stdout.matchAll(/VID_([0-9A-F]{4}).*?PID_([0-9A-F]{4})/gi)) {
      ids.add(usbId(Number.parseInt(match[1], 16), Number.parseInt(match[2], 16)));
    }
    return ids;
  }
  return new Set();
}

async function detectLinuxUsbAudioDeviceIds(): Promise<Set<string>> {
  const root = '/sys/bus/usb/devices';
  const ids = new Set<string>();
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.includes(':')) continue;
    const interfacePath = `${root}/${entry.name}`;
    try {
      const interfaceClass = (await fs.readFile(`${interfacePath}/bInterfaceClass`, 'utf8')).trim();
      if (interfaceClass !== '01') continue;
      const devicePath = `${root}/${entry.name.split(':')[0]}`;
      const vendorId = Number.parseInt((await fs.readFile(`${devicePath}/idVendor`, 'utf8')).trim(), 16);
      const productId = Number.parseInt((await fs.readFile(`${devicePath}/idProduct`, 'utf8')).trim(), 16);
      ids.add(usbId(vendorId, productId));
    } catch {
      // 热插拔可能让某个 sysfs 项在枚举途中消失，继续处理其他设备。
    }
  }
  return ids;
}

function firstDecimalProperty(section: string, property: string): number | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^[ \\t|]*"${escaped}" = (\\d+)`, 'm'));
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function usbId(vendorId: number, productId: number): string {
  return `${vendorId.toString(16).padStart(4, '0')}:${productId.toString(16).padStart(4, '0')}`;
}

function waitForFrame(
  device: HidHandle,
  seq: number,
  responseType: number,
  timeoutMs: number,
  send: () => void
): Promise<ParsedFrame> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      device.off('data', onData);
      device.off('error', onError);
    };
    const onData = (raw: Buffer): void => {
      try {
        const report = raw[0] === HID_INPUT_REPORT_ID ? raw.subarray(1) : raw;
        const frame = parseFrame(report);
        if (frame.seq === (seq & 0xffff) && frame.type === responseType && (frame.flags & 0x01) !== 0) {
          cleanup();
          resolve(frame);
        }
      } catch {
        // 同一个 HID 接口还承载其他协议，非 DFU 报告必须忽略。
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 HID 响应超时：seq=${seq}`));
    }, timeoutMs);
    device.on('data', onData);
    device.on('error', onError);
    try {
      send();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function loadNodeHid(): NodeHidModule {
  return require('node-hid') as NodeHidModule;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
