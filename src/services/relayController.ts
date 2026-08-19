import { RelayDeviceInfo } from '../types';

export const USB_RELAY_VID = 0x16c0;
export const USB_RELAY_PID = 0x05df;
export const RELAY_INIT_REPORT = [0x00, 0xd2, 0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11];

interface RelayHidHandle {
  sendFeatureReport(data: number[]): number;
  getFeatureReport(reportId: number, length: number): Buffer | number[];
  close(): void;
}

interface RelayHidModule {
  devices(vendorId?: number, productId?: number): Array<Record<string, unknown>>;
  HID: new (path: string) => RelayHidHandle;
}

type HidLoader = () => RelayHidModule;
type Wait = (milliseconds: number) => Promise<void>;

/**
 * USBRelay8 的短连接控制器。
 *
 * 枚举阶段只调用 node-hid devices，不打开设备。每次读取或切换通道时才
 * 临时打开 HID，读取并复核完整位图，最后直接 close；关闭时绝不发送
 * all-off，避免影响共享继电器上的其他通道。
 */
export class RelayController {
  private operationActive = false;

  public constructor(
    private readonly loadHid: HidLoader = loadNodeHid,
    private readonly wait: Wait = delay
  ) {}

  /** 只枚举目标 VID/PID，不创建 HID handle。 */
  public list(): RelayDeviceInfo[] {
    return this.loadHid().devices(USB_RELAY_VID, USB_RELAY_PID)
      .filter((device) =>
        typeof device.path === 'string' &&
        Number(device.vendorId ?? USB_RELAY_VID) === USB_RELAY_VID &&
        Number(device.productId ?? USB_RELAY_PID) === USB_RELAY_PID
      )
      .map((device) => ({
        path: String(device.path),
        vendorId: USB_RELAY_VID,
        productId: USB_RELAY_PID,
        serialNumber: stringOrUndefined(device.serialNumber),
        product: stringOrUndefined(device.product),
        manufacturer: stringOrUndefined(device.manufacturer)
      }));
  }

  /** 临时打开设备并读取状态，返回后 HID 已释放。 */
  public async readState(devicePath: string): Promise<number> {
    return this.withDevice(devicePath, async (device) => this.readMask(device));
  }

  /** 临时打开设备，仅修改一个通道，复核其他七位后立即释放 HID。 */
  public async setChannel(devicePath: string, channel: number, enabled: boolean): Promise<{ before: number; after: number }> {
    if (!Number.isInteger(channel) || channel < 1 || channel > 8) {
      throw new Error('继电器通道必须为 1..8');
    }
    return this.withDevice(devicePath, async (device) => {
      const before = this.readMask(device);
      const command = enabled ? 0xff : 0xfd;
      device.sendFeatureReport([0x00, command, channel, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

      const targetBit = 1 << (channel - 1);
      let after = before;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.wait(40);
        after = this.readMask(device);
        if ((before & ~targetBit) !== (after & ~targetBit)) {
          throw new Error(
            `继电器非目标通道状态发生变化：CH${channel}，0x${hexMask(before)} -> 0x${hexMask(after)}`
          );
        }
        if (Boolean(after & targetBit) === enabled) {
          return { before, after };
        }
      }
      throw new Error(
        `继电器 CH${channel} 状态复核失败：期望${enabled ? '开启' : '关闭'}，当前位图 0x${hexMask(after)}`
      );
    });
  }

  private async withDevice<T>(devicePath: string, operation: (device: RelayHidHandle) => Promise<T>): Promise<T> {
    if (!devicePath.trim()) throw new Error('请先选择 USB HID 继电器');
    if (this.operationActive) throw new Error('已有继电器操作正在执行');
    this.operationActive = true;
    let device: RelayHidHandle | undefined;
    try {
      device = new (this.loadHid().HID)(devicePath);
      device.sendFeatureReport([...RELAY_INIT_REPORT]);
      // 0xD2 初始化后必须读取一次 feature report 才能稳定驱动继电器。
      this.readMask(device);
      await this.wait(30);
      return await operation(device);
    } finally {
      try {
        device?.close();
      } finally {
        this.operationActive = false;
      }
    }
  }

  private readMask(device: RelayHidHandle): number {
    const report = device.getFeatureReport(0x01, 9);
    if (report.length < 8 || !Number.isInteger(Number(report[7]))) {
      throw new Error('继电器状态报告无效');
    }
    return Number(report[7]) & 0xff;
  }
}

function loadNodeHid(): RelayHidModule {
  return require('node-hid') as RelayHidModule;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hexMask(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
