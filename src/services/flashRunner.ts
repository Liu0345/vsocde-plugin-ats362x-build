import * as fs from 'node:fs/promises';
import { ChildProcess, spawn } from 'node:child_process';
import { BuiltCommand } from './commandBuilder';
import { assertExecutableVersion } from './toolVersions';

export type FlashProgress = (percent: number, detail: string) => void;
export type FlashOutput = (text: string) => void;

export interface FlashToolPaths {
  baton: string;
  'actions-flash': string;
}

export interface FlashProgressUpdate {
  percent: number;
  detail: string;
}

export class FlashProgressTracker {
  private pending = '';
  private highest = 0;
  private rawWriteCount = 0;

  public push(text: string): FlashProgressUpdate[] {
    const merged = `${this.pending}${text}`;
    const lines = merged.split(/\r\n|\n|\r/);
    this.pending = lines.pop() ?? '';
    const updates: FlashProgressUpdate[] = [];
    for (const rawLine of lines) {
      const line = sanitizeTerminalOutput(rawLine);
      const update = this.parseLine(line);
      if (update && update.percent > this.highest) {
        this.highest = update.percent;
        updates.push(update);
      }
    }
    return updates;
  }

  private parseLine(line: string): FlashProgressUpdate | undefined {
    if (/READY\s+(?:—|-)\s+power on now/i.test(line)) return { percent: 8, detail: '等待设备上电并握手' };
    if (/Handshake completed successfully/i.test(line)) return { percent: 18, detail: '串口握手完成' };
    if (/ADFU protocol established|Switched to ADFU protocol/i.test(line)) return { percent: 22, detail: 'ADFU 通信已建立' };
    if (/\[1\/3\]\s+Initializing storage|>>> init storage/i.test(line)) return { percent: 25, detail: '正在初始化存储' };

    const partitionCount = line.match(/\[2\/3\]\s+Found\s+(\d+)\s+partitions/i);
    if (partitionCount) return { percent: 30, detail: `准备写入 ${partitionCount[1]} 个分区` };

    const overall = line.match(/Overall Progress:\s*(\d+(?:\.\d+)?)%/i);
    if (overall) {
      const transferPercent = clampPercent(Number.parseFloat(overall[1]));
      return {
        percent: 30 + Math.round(transferPercent * 0.65),
        detail: transferPercent >= 100 ? '正在提交固件写入' : `正在写入固件 ${transferPercent}%`
      };
    }

    const partition = line.match(/Partition\s+(\d+)\/(\d+)\s+\[(\d+(?:\.\d+)?)%\]/i);
    if (partition) {
      const transferPercent = clampPercent(Number.parseFloat(partition[3]));
      return {
        percent: 30 + Math.round(transferPercent * 0.65),
        detail: transferPercent >= 100 ? '正在提交固件写入' : `正在写入分区 ${partition[1]}/${partition[2]}`
      };
    }

    if (/>>>\s+load adfus\.bin/i.test(line)) return { percent: 20, detail: '正在加载 ADFU 程序' };
    if (/>>>\s+write\s+/i.test(line)) {
      this.rawWriteCount += 1;
      return { percent: Math.min(84, 30 + this.rawWriteCount * 2), detail: `正在写入固件数据块 ${this.rawWriteCount}` };
    }
    if (/OTA Upgrade Completed Successfully|>>> finish transaction \+ reboot/i.test(line)) {
      return { percent: 100, detail: '固件烧录完成' };
    }

    const generic = extractFlashPercentages(line);
    if (generic.length > 0) {
      const transferPercent = generic.at(-1)!;
      return {
        percent: 10 + Math.round(transferPercent * 0.85),
        detail: `正在执行串口烧录 ${transferPercent}%`
      };
    }
    return undefined;
  }
}

export class FlashRunner {
  private active?: ChildProcess;
  private cancelRequested = false;

  public async run(
    cwd: string,
    command: BuiltCommand,
    onProgress?: FlashProgress,
    onOutput?: FlashOutput,
    operationLabel = '串口烧录',
    toolPaths: FlashToolPaths = { baton: 'baton', 'actions-flash': 'actions-flash' }
  ): Promise<void> {
    if (this.active) {
      throw new Error('已有串口烧录任务正在执行');
    }

    if (command.executable !== 'baton' && command.executable !== 'actions-flash') {
      throw new Error('串口烧录仅支持 baton 或 actions-flash 命令');
    }

    await this.validateFlashCommand(command);
    for (const tool of requiredToolsForFlashCommand(command)) {
      const label = tool === 'baton' ? 'Baton' : 'Actions Flash';
      await assertExecutableVersion(tool, label, toolPaths[tool]);
    }
    const executable = toolPaths[command.executable];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, command.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      });
      this.active = child;
      this.cancelRequested = false;
      let outputBuffer = '';
      const progressTracker = new FlashProgressTracker();

      const emit = (raw: Buffer | string): void => {
        const text = sanitizeTerminalOutput(typeof raw === 'string' ? raw : raw.toString('utf8'));
        outputBuffer = `${outputBuffer}${text}`.slice(-256 * 1024);
        onOutput?.(text);

        for (const update of progressTracker.push(text)) {
          onProgress?.(update.percent, update.detail);
        }
      };

      child.stdout?.on('data', emit);
      child.stderr?.on('data', emit);

      child.once('error', (error) => {
        if (this.active === child) this.active = undefined;
        this.cancelRequested = false;
        reject(error);
      });

      child.once('close', (code, signal) => {
        if (this.active === child) this.active = undefined;
        const cancelled = this.cancelRequested;
        this.cancelRequested = false;
        if (cancelled) {
          reject(new Error('串口烧录已取消'));
          return;
        }
        if (signal) {
          reject(new Error(`串口烧录被终止：${signal}`));
          return;
        }
        if (code === 0) {
          if (operationLabel !== '烧录') onProgress?.(100, `${operationLabel}任务已完成`);
          resolve();
          return;
        }
        const snippet = outputBuffer.trim().split('\n').slice(-4).join('\n');
        const detail = snippet || '无额外输出';
        reject(new Error(`串口烧录失败（exit ${code}）：${detail}`));
      });
    });
  }

  public cancel(): void {
    const child = this.active;
    if (!child) return;
    this.cancelRequested = true;
    terminateChild(child, 'SIGINT');
    const forceTimer = setTimeout(() => {
      if (this.active === child) terminateChild(child, 'SIGTERM');
    }, 1500);
    forceTimer.unref();
  }

  private async validateFlashCommand(command: BuiltCommand): Promise<void> {
    const firmware = command.args.find((value, index) => index > 0 && command.args[index - 1] === 'flash');
    if (!firmware) {
      return;
    }
    const stat = await fs.stat(firmware);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`烧录固件无效：${firmware}`);
    }
  }
}

export function requiredToolsForFlashCommand(command: BuiltCommand): Array<'baton' | 'actions-flash'> {
  if (command.executable === 'actions-flash') return ['actions-flash'];
  if (command.executable === 'baton' && ['flash', 'erase-flash'].includes(command.args[0] ?? '')) {
    return ['baton', 'actions-flash'];
  }
  return ['baton'];
}

export function extractFlashPercentages(output: string): number[] {
  const values: number[] = [];
  for (const match of output.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    const percent = Number.parseFloat(match[1]);
    if (Number.isFinite(percent) && percent >= 0) {
      values.push(Math.min(100, Math.max(0, Math.floor(percent))));
    }
  }

  for (const match of output.matchAll(/(\d[\d,_]*)\s*\/\s*(\d[\d,_]*)/g)) {
    const before = output[match.index! - 1];
    const after = output[match.index! + match[0].length];
    if (before === '[' && after === ']') continue;
    const left = Number.parseFloat(match[1].replace(/[,_]/g, ''));
    const right = Number.parseFloat(match[2].replace(/[,_]/g, ''));
    if (Number.isFinite(left) && Number.isFinite(right) && right > 0 && left >= 0) {
      const percent = Math.floor((left / right) * 100);
      if (percent >= 0 && percent <= 100) {
        values.push(Math.min(100, Math.max(0, percent)));
      }
    }
  }

  return values;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function sanitizeTerminalOutput(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    child.kill(signal);
  }
}
