import * as fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { HidDeviceInfo } from '../types';
import {
  buildFrame,
  HID_DATA_CHUNK,
  HID_INPUT_REPORT_ID,
  HID_OUTPUT_REPORT_ID,
  HidMessage,
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

export class HidDfuService {
  private active?: HidHandle;
  private cancelled = false;

  public list(): HidDeviceInfo[] {
    const hid = loadNodeHid();
    return hid.devices()
      .filter((device) => typeof device.path === 'string')
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
    const image = await fs.readFile(firmwarePath);
    if (image.length === 0 || image.length > 1024 * 1024) {
      throw new Error(`HID DFU 固件大小无效：${image.length} 字节`);
    }

    const hid = loadNodeHid();
    const device = new hid.HID(devicePath);
    this.active = device;
    this.cancelled = false;
    let seq = 1;

    try {
      onProgress(0, '读取设备信息');
      await this.exchange(device, HidMessage.Info, seq++, Buffer.alloc(0), timeoutMs, HidMessage.InfoResult);
      await this.exchange(device, HidMessage.Begin, seq++, makeBeginPayload(image, expectedBcd), timeoutMs);

      for (let offset = 0; offset < image.length; offset += HID_DATA_CHUNK) {
        if (this.cancelled) {
          throw new Error('HID DFU 已取消');
        }
        const chunk = image.subarray(offset, Math.min(offset + HID_DATA_CHUNK, image.length));
        await this.exchange(device, HidMessage.Data, seq++, makeDataPayload(offset, chunk), timeoutMs);
        const written = offset + chunk.length;
        onProgress(Math.floor((written * 100) / image.length), `${written} / ${image.length} 字节`);
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
