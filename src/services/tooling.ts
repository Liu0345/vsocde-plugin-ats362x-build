import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ToolStatus } from '../types';

const execFileAsync = promisify(execFile);

export async function inspectTools(): Promise<ToolStatus[]> {
  const configuration = vscode.workspace.getConfiguration('ats362xBuild');
  const baton = configuration.get<string>('batonPath', 'baton');
  const actionsFlash = configuration.get<string>('actionsFlashPath', 'actions-flash');
  const dfuUtil = configuration.get<string>('dfuUtilPath', 'dfu-util');
  const [batonStatus, flashStatus, dfuStatus] = await Promise.all([
    inspectExecutable('baton', 'Baton', baton),
    inspectExecutable('actions-flash', 'Actions Flash', actionsFlash),
    inspectExecutable('dfu-util', 'USB DFU', dfuUtil)
  ]);
  if (batonStatus.available) {
    try {
      const help = await execFileAsync(baton, ['--help'], { timeout: 3000 });
      if (!help.stdout.includes('erase-flash')) {
        batonStatus.detail += ' · 当前版本缺少 erase-flash';
      }
    } catch {
      // 版本检查已成功，帮助文本探测失败不改变工具可用状态。
    }
  }

  let hidAvailable = false;
  let hidDetail = 'node-hid 未加载';
  try {
    const module = require('node-hid') as { devices?: () => unknown[] };
    hidAvailable = typeof module.devices === 'function';
    hidDetail = hidAvailable ? '已内置' : hidDetail;
  } catch (error) {
    hidDetail = error instanceof Error ? error.message : String(error);
  }

  return [
    batonStatus,
    flashStatus,
    dfuStatus,
    { name: 'node-hid', label: 'HID DFU', available: hidAvailable, detail: hidDetail }
  ];
}

async function inspectExecutable(
  name: 'baton' | 'actions-flash' | 'dfu-util',
  label: string,
  executable: string
): Promise<ToolStatus> {
  try {
    const result = await execFileAsync(executable, ['--version'], { timeout: 3000 });
    const detail = `${result.stdout}${result.stderr}`.trim().split('\n')[0] || executable;
    return { name, label, available: true, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name, label, available: false, detail };
  }
}
