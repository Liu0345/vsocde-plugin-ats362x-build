import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface BuildOptionInfo {
  app: string;
  boards: string[];
}

/**
 * 扫描 Baton 可用的应用目录和板级配置。
 *
 * App 返回工作区相对路径，可直接传给 `baton build --app`；Board 只读取
 * 应用自身的板级目录，避免把 SDK 或其他应用的板型混入候选项。
 */
export async function discoverBuildOptions(workspace?: string): Promise<BuildOptionInfo[]> {
  if (!workspace) return [];

  const candidates = [
    ...await visibleDirectories(workspace),
    ...await visibleDirectories(path.join(workspace, 'application'))
  ];
  const uniqueCandidates = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  const options: BuildOptionInfo[] = [];

  for (const candidate of uniqueCandidates) {
    if (!await isBuildApplication(candidate)) continue;
    const relative = normalizeRelativePath(path.relative(workspace, candidate));
    if (!relative || relative.startsWith('../')) continue;
    options.push({ app: relative, boards: await discoverBoards(candidate) });
  }

  return options.sort((left, right) => left.app.localeCompare(right.app, 'en'));
}

async function isBuildApplication(candidate: string): Promise<boolean> {
  return await exists(path.join(candidate, 'baton-target.toml')) ||
    await isDirectory(path.join(candidate, 'arm_mcu_code'));
}

async function discoverBoards(appDirectory: string): Promise<string[]> {
  const roots = [
    path.join(appDirectory, 'arm_mcu_code', 'boards', 'arm'),
    path.join(appDirectory, 'boards', 'arm')
  ];
  const boards = new Set<string>();
  for (const root of roots) {
    for (const directory of await visibleDirectories(root)) {
      boards.add(path.basename(directory));
    }
  }
  return [...boards].sort((left, right) => left.localeCompare(right, 'en'));
}

async function visibleDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}
