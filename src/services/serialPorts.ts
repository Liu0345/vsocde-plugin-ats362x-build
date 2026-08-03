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
