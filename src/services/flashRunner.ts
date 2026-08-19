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

export class FlashRunner {
  private active?: ChildProcess;

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
      const child = spawn(executable, command.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      this.active = child;
      let outputBuffer = '';
      let pendingLine = '';
      let highestPercent = 0;

      const emit = (raw: Buffer | string): void => {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        outputBuffer = `${outputBuffer}${text}`.slice(-256 * 1024);
        onOutput?.(text);

        const merged = `${pendingLine}${text}`;
        pendingLine = merged.slice(-32);
        for (const percent of extractFlashPercentages(merged)) {
          if (percent > highestPercent) {
            highestPercent = percent;
            onProgress?.(percent, percent < 100 ? `正在执行${operationLabel}` : `${operationLabel}已完成`);
          }
        }
      };

      child.stdout?.on('data', emit);
      child.stderr?.on('data', emit);

      child.once('error', (error) => {
        this.active = undefined;
        reject(error);
      });

      child.once('close', (code, signal) => {
        this.active = undefined;
        if (signal) {
          reject(new Error(`串口烧录被终止：${signal}`));
          return;
        }
        if (code === 0) {
          onProgress?.(100, `${operationLabel}任务已完成`);
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
    this.active?.kill('SIGINT');
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
