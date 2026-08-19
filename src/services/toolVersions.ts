import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolName } from '../types';

const execFileAsync = promisify(execFile);

export const TOOL_REQUIREMENTS: Readonly<Record<ToolName, string>> = {
  baton: '0.23.0',
  'actions-flash': '0.5.0',
  'dfu-util': '0.11',
  'node-hid': '3.2.0'
};

export function parseToolVersion(output: string): string | undefined {
  return output.match(/(?:^|\s|[=:])v?(\d+(?:\.\d+){1,3})(?:[-+][0-9A-Za-z.-]+)?\b/im)?.[1];
}

export function satisfiesMinimumVersion(actual: string, minimum: string): boolean {
  const actualParts = actual.split('.').map((part) => Number.parseInt(part, 10));
  const minimumParts = minimum.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export async function readExecutableVersion(executable: string): Promise<{ output: string; version?: string }> {
  const result = await execFileAsync(executable, ['--version'], { timeout: 3000 });
  const output = `${result.stdout}${result.stderr}`.trim();
  return { output, version: parseToolVersion(output) };
}

export async function assertExecutableVersion(
  name: Exclude<ToolName, 'node-hid'>,
  label: string,
  executable: string
): Promise<void> {
  const minimum = TOOL_REQUIREMENTS[name];
  let detected: Awaited<ReturnType<typeof readExecutableVersion>>;
  try {
    detected = await readExecutableVersion(executable);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 不可用，要求 >= ${minimum}：${detail}`);
  }
  if (!detected.version) {
    throw new Error(`${label} 版本无法识别，要求 >= ${minimum}：${detected.output || executable}`);
  }
  if (!satisfiesMinimumVersion(detected.version, minimum)) {
    const upgrade = name === 'actions-flash'
      ? '请从 Pawpaw-Technology/actions-flash 官方仓库重新安装。'
      : '请升级后重试。';
    throw new Error(`${label} 版本过低：检测到 ${detected.version}，要求 >= ${minimum}。${upgrade}`);
  }
}
