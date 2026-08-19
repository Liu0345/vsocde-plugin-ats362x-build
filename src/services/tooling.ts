import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ToolStatus } from '../types';
import { parseToolVersion, readExecutableVersion, satisfiesMinimumVersion, TOOL_REQUIREMENTS } from './toolVersions';

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
  let hidVersion: string | undefined;
  try {
    const module = require('node-hid') as { devices?: () => unknown[] };
    const packageInfo = require('node-hid/package.json') as { version?: string };
    hidVersion = packageInfo.version && parseToolVersion(packageInfo.version);
    hidAvailable = typeof module.devices === 'function' && Boolean(hidVersion) && satisfiesMinimumVersion(hidVersion!, TOOL_REQUIREMENTS['node-hid']);
    hidDetail = hidVersion
      ? `已内置 ${hidVersion} · 要求 >= ${TOOL_REQUIREMENTS['node-hid']}`
      : '已内置，但版本无法识别';
  } catch (error) {
    hidDetail = error instanceof Error ? error.message : String(error);
  }

  return [
    batonStatus,
    flashStatus,
    dfuStatus,
    {
      name: 'node-hid',
      label: 'HID DFU（node-hid）',
      available: hidAvailable,
      detail: hidDetail,
      minimumVersion: TOOL_REQUIREMENTS['node-hid'],
      detectedVersion: hidVersion
    }
  ];
}

async function inspectExecutable(
  name: 'baton' | 'actions-flash' | 'dfu-util',
  label: string,
  executable: string
): Promise<ToolStatus> {
  const minimumVersion = TOOL_REQUIREMENTS[name];
  try {
    const result = await readExecutableVersion(executable);
    const detectedVersion = result.version;
    const available = Boolean(detectedVersion) && satisfiesMinimumVersion(detectedVersion!, minimumVersion);
    const detected = detectedVersion ? `已检测 ${detectedVersion}` : '版本无法识别';
    return {
      name,
      label,
      available,
      detail: `${detected} · 要求 >= ${minimumVersion}`,
      minimumVersion,
      detectedVersion
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name, label, available: false, detail: `未检测到 · 要求 >= ${minimumVersion} · ${detail}`, minimumVersion };
  }
}
