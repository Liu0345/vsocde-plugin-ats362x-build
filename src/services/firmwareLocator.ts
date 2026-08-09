import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const FIRMWARE_SUFFIXES = ['.fw', '.bin', '.dfu', '.img', '.hex'];

export interface FirmwareDiscovery {
  defaultDirectory?: string;
  files: string[];
}

export async function discoverFirmware(projectPath?: string): Promise<FirmwareDiscovery> {
  if (!projectPath) {
    return { files: [] };
  }

  const candidates = await findKnownFirmwareDirectories(projectPath);
  const ranked: Array<{ directory: string; modified: number; files: string[] }> = [];
  for (const directory of candidates) {
    const files = await listFirmwareFiles(directory);
    const modified = files.length > 0
      ? Math.max(...await Promise.all(files.map(async (file) => (await fs.stat(file)).mtimeMs)))
      : (await fs.stat(directory)).mtimeMs;
    ranked.push({ directory, modified, files });
  }
  ranked.sort((left, right) => right.modified - left.modified);

  return {
    defaultDirectory: ranked[0]?.directory,
    files: ranked.flatMap((item) => item.files)
      .sort((left, right) => scoreFirmware(right) - scoreFirmware(left))
  };
}

async function findKnownFirmwareDirectories(root: string): Promise<string[]> {
  const found = new Set<string>();
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 6) {
      continue;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.git', 'node_modules', '.cache'].includes(entry.name)) {
        continue;
      }
      const child = path.join(current.directory, entry.name);
      if (entry.name === '_firmware' || entry.name === 'firmware') {
        found.add(child);
        continue;
      }
      const shouldDescend = current.depth < 2 ||
        ['application', 'arm_mcu_code', 'outdir', 'build', 'builds'].includes(entry.name) ||
        current.directory.includes(`${path.sep}application${path.sep}`) ||
        current.directory.includes(`${path.sep}outdir${path.sep}`);
      if (shouldDescend) {
        queue.push({ directory: child, depth: current.depth + 1 });
      }
    }
  }
  return [...found];
}

async function listFirmwareFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const entries = await fs.readdir(current.directory, { withFileTypes: true });
      for (const entry of entries) {
        const item = path.join(current.directory, entry.name);
        if (entry.isFile() && FIRMWARE_SUFFIXES.includes(path.extname(entry.name).toLowerCase())) {
          files.push(item);
        } else if (entry.isDirectory() && current.depth < 2 && !entry.name.startsWith('.')) {
          queue.push({ directory: item, depth: current.depth + 1 });
        }
      }
    } catch {
      // 构建过程可能替换输出目录，单个目录短暂消失时继续扫描其他目录。
    }
  }
  return files;
}

function scoreFirmware(file: string): number {
  const name = path.basename(file).toLowerCase();
  let score = 0;
  if (name.includes('_ota')) score += 100;
  if (name.endsWith('.fw')) score += 50;
  if (name.includes('firmware')) score += 10;
  return score;
}

export function chooseFirmware(
  override: string | undefined,
  discovered: string[],
  preference: 'ota' | 'fw' | 'any'
): string | undefined {
  if (override) {
    return override;
  }
  const match = discovered.find((file) => {
    const name = path.basename(file).toLowerCase();
    if (preference === 'ota') return name.includes('ota') && name.endsWith('.bin');
    if (preference === 'fw') return name.endsWith('.fw');
    return true;
  });
  return match ?? discovered[0];
}
