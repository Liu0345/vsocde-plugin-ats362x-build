import { SerialPort } from 'serialport';
import { existsSync } from 'node:fs';
import { SerialPortInfo } from '../types';

/**
 * 枚举当前主机上的串口。
 *
 * serialport 在 macOS、Linux 与 Windows 上使用各自的系统后端，插件只向
 * 页面暴露稳定字段，不要求页面理解平台专用设备属性。
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const ports = await SerialPort.list();
  return ports
    .map((port) => ({
      path: preferMacCalloutPath(port.path),
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      vendorId: port.vendorId,
      productId: port.productId
    }))
    .sort((left, right) => {
      const priority = portPriority(left.path) - portPriority(right.path);
      return priority !== 0 ? priority : naturalCompare(left.path, right.path);
    });
}

export interface SerialPortAvailability {
  available: boolean;
  reason?: string;
}

/** 维护一个可选的长期串口占用，所有状态切换串行执行。 */
export class SerialPortReservation {
  private readonly serials = new Map<string, SerialPort>();
  private pending: Promise<void> = Promise.resolve();

  public get reservedPaths(): string[] {
    return [...this.serials.entries()].filter(([, serial]) => serial.isOpen).map(([portPath]) => portPath);
  }

  public isReserved(portPath: string): boolean {
    return this.serials.get(portPath)?.isOpen === true;
  }

  public reserve(portPath: string, baudRate = 115200): Promise<void> {
    return this.enqueue(async () => {
      if (this.isReserved(portPath)) return;

      const serial = new SerialPort({ path: portPath, baudRate, autoOpen: false, lock: true });
      try {
        await openSerialPort(serial);
      } catch (error) {
        if (serial.isOpen) await closeSerialPort(serial);
        throw new Error(describeSerialPortError(error));
      }
      this.serials.set(portPath, serial);
    });
  }

  public release(portPath?: string): Promise<void> {
    return this.enqueue(() => this.releaseCurrent(portPath));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async releaseCurrent(portPath?: string): Promise<void> {
    const entries = portPath
      ? [[portPath, this.serials.get(portPath)] as const]
      : [...this.serials.entries()];
    for (const [path, serial] of entries) {
      this.serials.delete(path);
      if (serial?.isOpen) await closeSerialPort(serial);
    }
  }
}

/**
 * 短暂独占打开串口以检查占用状态，并在返回前关闭。
 *
 * 该函数不保留串口句柄；成功、失败和异常路径都会尝试释放资源。真正的
 * 业务操作必须自行打开串口，并在操作完成后关闭。
 */
export async function checkSerialPortAvailability(portPath: string, baudRate = 115200): Promise<SerialPortAvailability> {
  const serial = new SerialPort({ path: portPath, baudRate, autoOpen: false, lock: true });
  try {
    await openSerialPort(serial);
    return { available: true };
  } catch (error) {
    return { available: false, reason: describeSerialPortError(error) };
  } finally {
    if (serial.isOpen) {
      await closeSerialPort(serial);
    }
  }
}

function openSerialPort(serial: SerialPort): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    serial.open((error) => error ? reject(error) : resolve());
  });
}

function closeSerialPort(serial: SerialPort): Promise<void> {
  return new Promise<void>((resolve) => serial.close(() => resolve()));
}

export function describeSerialPortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/resource busy|device busy|cannot lock|access denied|permission denied|\bebusy\b/i.test(message)) {
    return '串口已被其他程序或任务占用';
  }
  if (/no such file|cannot find|not found|disconnected/i.test(message)) {
    return '串口不存在或设备已断开';
  }
  return `串口不可用：${message}`;
}

/** macOS 主动连接串口应优先使用 cu 节点，避免 tty 节点等待载波。 */
export function preferMacCalloutPath(portPath: string): string {
  if (process.platform !== 'darwin' || !portPath.startsWith('/dev/tty.')) {
    return portPath;
  }
  const callout = `/dev/cu.${portPath.slice('/dev/tty.'.length)}`;
  return existsSync(callout) ? callout : portPath;
}

function portPriority(portPath: string): number {
  if (/usb(serial|modem)/i.test(portPath)) return 0;
  if (/debug|acm/i.test(portPath)) return 1;
  return 2;
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}
