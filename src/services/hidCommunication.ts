import { EventEmitter } from 'node:events';
import { HidDeviceInfo } from '../types';
import { prepareHidReport, validatePacketTimeout } from './communicationCodec';
import { CommunicationConnectionStatus, CommunicationDirection } from './uartCommunication';
import { detectUsbAudioDeviceIds } from './hidDfu';

interface HidHandle extends EventEmitter {
  write(data: number[]): number;
  close(): void;
}

export interface NodeHidModule {
  devices(): Array<Record<string, unknown>>;
  HID: new (path: string) => HidHandle;
}

export interface HidCommunicationOptions {
  path: string;
  packetTimeoutMs: number;
}

export interface HidReportOptions {
  reportId: number;
  reportLength: number;
  padToLength: boolean;
}

/** 通用 HID 枚举不套用 DFU usage 过滤，供通讯调试选择任意有效接口。 */
export function listGenericHidDevices(hid: NodeHidModule = loadNodeHid()): HidDeviceInfo[] {
  const devices = hid.devices()
    .filter((device) => typeof device.path === 'string' && device.path.length > 0)
    .map((device) => ({
      path: String(device.path),
      vendorId: Number(device.vendorId ?? 0),
      productId: Number(device.productId ?? 0),
      product: stringOrUndefined(device.product),
      manufacturer: stringOrUndefined(device.manufacturer),
      serialNumber: stringOrUndefined(device.serialNumber),
      interface: numberOrUndefined(device.interface),
      usagePage: numberOrUndefined(device.usagePage),
      usage: numberOrUndefined(device.usage)
    }));
  // 同一个 UAC HID 路径可以公开多个 Usage collection，必须全部保留；
  // Webview 会用 path + interface + usage 生成唯一选择值。
  return devices.sort((left, right) =>
    `${left.vendorId}:${left.productId}:${left.path}:${left.interface ?? -1}:${left.usagePage ?? -1}:${left.usage ?? -1}`
      .localeCompare(`${right.vendorId}:${right.productId}:${right.path}:${right.interface ?? -1}:${right.usagePage ?? -1}:${right.usage ?? -1}`)
  );
}

/** 仅枚举当前主机上具有 USB Audio Class 接口的设备所附带的 HID。 */
export async function listUacHidDevices(
  hid: NodeHidModule = loadNodeHid(),
  uacDeviceIds?: Set<string>
): Promise<HidDeviceInfo[]> {
  const allowed = uacDeviceIds ?? await detectUsbAudioDeviceIds();
  return listGenericHidDevices(hid).filter((device) => allowed.has(usbDeviceId(device.vendorId, device.productId)));
}

/** 保持单个 HID 句柄的可靠会话，并将所有写入严格串行。 */
export class HidCommunicationService {
  private handle?: HidHandle;
  private packetTimeoutMs = 20;
  private lifecycle: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private generation = 0;

  public constructor(
    private readonly onPacket: (direction: CommunicationDirection, packet: Buffer) => void,
    private readonly onStatus: (status: CommunicationConnectionStatus) => void,
    private readonly loadHid: () => NodeHidModule = loadNodeHid
  ) {}

  public get isConnected(): boolean {
    return this.handle !== undefined;
  }

  public connect(options: HidCommunicationOptions): Promise<void> {
    return this.enqueueLifecycle(async () => {
      const devicePath = options.path.trim();
      if (!devicePath) throw new Error('请选择 HID 设备');
      this.packetTimeoutMs = validatePacketTimeout(options.packetTimeoutMs);
      await this.disconnectCurrent(false);

      let handle: HidHandle | undefined;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3 && !handle; attempt += 1) {
        try {
          handle = new (this.loadHid().HID)(devicePath);
        } catch (error) {
          lastError = error;
          if (attempt < 3) await delay(attempt * 60);
        }
      }
      if (!handle) throw new Error(`无法打开 HID 接口：${errorMessage(lastError)}`);

      const activeHandle = handle;
      const generation = ++this.generation;
      // node-hid 的每次 data 事件就是一个完整输入报告；不可按空闲时间合并，
      // 否则连续到达的两个 64 字节报告会被错误地拼成一包。
      activeHandle.on('data', (data: Uint8Array) => {
        if (this.generation === generation && this.handle === activeHandle) this.onPacket('rx', Buffer.from(data));
      });
      activeHandle.on('error', (error: Error) => {
        if (this.generation !== generation || this.handle !== activeHandle) return;
        this.onStatus({ connected: false, target: devicePath, detail: `HID 错误：${error.message}` });
        void this.enqueueLifecycle(() => this.disconnectCurrent(false));
      });
      this.handle = activeHandle;
      this.onStatus({ connected: true, target: devicePath, detail: 'HID 已连接' });
    });
  }

  public send(payload: Uint8Array, options: HidReportOptions): Promise<void> {
    const report = prepareHidReport(payload, options.reportId, options.reportLength, options.padToLength);
    if (payload.byteLength === 0) throw new Error('发送数据不能为空');
    const operation = this.writes.then(async () => {
      const handle = this.handle;
      if (!handle) throw new Error('HID 尚未连接');
      const written = handle.write([...report]);
      if (!Number.isFinite(written) || written <= 0) throw new Error('HID 写入失败');
      if (this.handle !== handle) throw new Error('HID 在发送过程中断开');
      this.onPacket('tx', report);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  public disconnect(): Promise<void> {
    return this.enqueueLifecycle(() => this.disconnectCurrent(true));
  }

  public setPacketTimeout(timeoutMs: number): void {
    // HID 报告由操作系统天然分帧；保留同一配置入口以统一校验和未来支持
    // 原始 HID 后端，但绝不合并当前 node-hid 已完成分帧的报告。
    this.packetTimeoutMs = validatePacketTimeout(timeoutMs);
  }

  public dispose(): void {
    void this.disconnect();
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.catch(() => undefined);
    return result;
  }

  private async disconnectCurrent(announce: boolean): Promise<void> {
    const handle = this.handle;
    ++this.generation;
    this.handle = undefined;
    if (handle) {
      handle.removeAllListeners();
      try { handle.close(); } catch { /* 接口已被系统移除时仍视为释放完成。 */ }
    }
    if (announce) this.onStatus({ connected: false, detail: 'HID 已断开' });
  }
}

function loadNodeHid(): NodeHidModule {
  return require('node-hid') as NodeHidModule;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usbDeviceId(vendorId: number, productId: number): string {
  return `${vendorId.toString(16).padStart(4, '0')}:${productId.toString(16).padStart(4, '0')}`;
}
