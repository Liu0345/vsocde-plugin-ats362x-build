import { ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { UsbDfuDeviceInfo } from '../types';
import { detectUsbAudioDeviceIds } from './hidDfu';

const execFileAsync = promisify(execFile);

interface DfuListRecord {
  mode: 'Runtime' | 'DFU';
  vendorId: number;
  productId: number;
  usbPath: string;
  serialNumber?: string;
  name?: string;
  version?: string;
  alt: number;
}

export interface UsbDfuTarget {
  vendorId: number;
  productId: number;
  usbPath: string;
  alt: number;
}

export class UsbDfuService {
  private active?: ChildProcess;
  private cancelled = false;

  /** 执行标准 USB DFU，并从 dfu-util 的真实输出中提取进度。 */
  public async upload(
    executable: string,
    target: UsbDfuTarget,
    firmwarePath: string,
    reset: boolean,
    onProgress: (percent: number, detail: string) => void,
    onOutput?: (text: string) => void
  ): Promise<void> {
    if (this.active) throw new Error('已有 USB DFU 任务正在运行');
    const stat = await fs.stat(firmwarePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('USB DFU 固件文件无效');

    const args = buildUsbDfuArgs(target, firmwarePath, reset);
    this.cancelled = false;
    onProgress(0, '准备 USB DFU 传输');

    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.active = child;
      let transcript = '';
      let progressTail = '';
      let highestPercent = 0;

      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        transcript = `${transcript}${text}`.slice(-256 * 1024);
        onOutput?.(text);
        const progressText = `${progressTail}${text}`;
        progressTail = progressText.slice(-16);
        for (const percent of extractDfuPercentages(progressText)) {
          if (percent > highestPercent) {
            highestPercent = percent;
            onProgress(percent, percent < 100 ? '正在传输固件' : '固件传输完成');
          }
        }
      };

      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
      child.once('error', (error) => {
        this.active = undefined;
        reject(error);
      });
      child.once('close', (code, signal) => {
        this.active = undefined;
        if (this.cancelled) {
          reject(new Error('USB DFU 已取消'));
          return;
        }
        const completed = /download\s+done/i.test(transcript);
        const autoResetDisconnect = /libusb_error_no_device|unable to read dfu status after completion/i.test(transcript);
        if (code === 0 || (completed && autoResetDisconnect)) {
          onProgress(100, reset ? '传输完成，设备正在复位' : 'USB DFU 完成');
          resolve();
          return;
        }
        reject(new Error(`dfu-util 执行失败（${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}）`));
      });
    });
  }

  public cancel(): void {
    this.cancelled = true;
    this.active?.kill('SIGTERM');
  }
}

/** 构造锁定到所选 UAC 设备 USB 物理路径的 dfu-util 参数。 */
export function buildUsbDfuArgs(target: UsbDfuTarget, firmwarePath: string, reset: boolean): string[] {
  const vidPid = `${usbHex(target.vendorId)}:${usbHex(target.productId)}`;
  const args = ['-d', vidPid, '-p', target.usbPath, '-a', String(target.alt), '-D', firmwarePath];
  if (reset) args.push('-R');
  return args;
}

/** 提取 dfu-util 进度文本中的百分比，兼容以回车刷新同一行的输出。 */
export function extractDfuPercentages(output: string): number[] {
  return [...output.matchAll(/(?:^|[^\d])(\d{1,3})%/g)]
    .map((match) => Math.min(100, Number.parseInt(match[1], 10)));
}

/** 扫描同时提供 USB Audio Class 和标准 DFU Runtime 接口的设备。 */
export async function listUsbDfuDevices(executable = 'dfu-util'): Promise<UsbDfuDeviceInfo[]> {
  const [uacIds, result] = await Promise.all([
    detectUsbAudioDeviceIds(),
    execFileAsync(executable, ['-l'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  ]);
  const records = parseDfuUtilList(`${result.stdout}\n${result.stderr}`);
  return records
    .filter((record) => record.mode === 'Runtime' && uacIds.has(usbId(record.vendorId, record.productId)))
    .map((record) => ({
      key: `${usbId(record.vendorId, record.productId)}@${record.usbPath}#${record.serialNumber ?? ''}`,
      vendorId: record.vendorId,
      productId: record.productId,
      usbPath: record.usbPath,
      serialNumber: record.serialNumber,
      dfuName: record.name,
      version: record.version,
      alt: record.alt
    }));
}

/** 解析 dfu-util -l 输出；保留 USB 路径以区分 VID/PID 相同的多台设备。 */
export function parseDfuUtilList(output: string): DfuListRecord[] {
  const records: DfuListRecord[] = [];
  const pattern = /Found\s+(Runtime|DFU):\s+\[([0-9a-f]{4}):([0-9a-f]{4})\]([^\r\n]*)/gi;
  for (const match of output.matchAll(pattern)) {
    const tail = match[4];
    const usbPath = quotedField(tail, 'path');
    if (!usbPath) continue;
    const altMatch = tail.match(/(?:^|,\s*)alt=(\d+)/i);
    records.push({
      mode: match[1].toLowerCase() === 'runtime' ? 'Runtime' : 'DFU',
      vendorId: Number.parseInt(match[2], 16),
      productId: Number.parseInt(match[3], 16),
      usbPath,
      serialNumber: quotedField(tail, 'serial'),
      name: quotedField(tail, 'name'),
      version: tail.match(/\bver=([0-9a-f]+)/i)?.[1],
      alt: altMatch ? Number.parseInt(altMatch[1], 10) : 0
    });
  }
  return records;
}

function quotedField(text: string, name: string): string | undefined {
  const match = text.match(new RegExp(`(?:^|,\\s*)${name}="([^"]*)"`, 'i'));
  return match?.[1] || undefined;
}

function usbId(vendorId: number, productId: number): string {
  return `${usbHex(vendorId)}:${usbHex(productId)}`;
}

function usbHex(value: number): string {
  return value.toString(16).padStart(4, '0');
}
