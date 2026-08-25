import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SELECTED_PROJECT = 'ats362x.selectedProject';
const RECENT_PROJECTS = 'ats362x.recentProjects';
const FIRMWARE_OVERRIDE = 'ats362x.firmwareOverride';
const MAX_RECENT = 10;

export class ProjectStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public get selectedProject(): string | undefined {
    return this.context.workspaceState.get<string>(SELECTED_PROJECT);
  }

  public get recentProjects(): string[] {
    return this.context.globalState.get<string[]>(RECENT_PROJECTS, []);
  }

  public get firmwareOverride(): string | undefined {
    return this.context.workspaceState.get<string>(FIRMWARE_OVERRIDE);
  }

  public async initialize(): Promise<void> {
    if (this.selectedProject) {
      return;
    }
    const candidates = vscode.workspace.workspaceFolders ?? [];
    for (const folder of candidates) {
      if (await isAriaWorkspace(folder.uri.fsPath)) {
        await this.selectProject(folder.uri.fsPath);
        return;
      }
    }
  }

  public async selectProject(projectPath: string): Promise<void> {
    const normalized = path.resolve(projectPath);
    await this.context.workspaceState.update(SELECTED_PROJECT, normalized);
    const existing = this.recentProjects;
    const recent = existing.some((item) => path.resolve(item) === normalized)
      ? existing
      : [normalized, ...existing].slice(0, MAX_RECENT);
    await this.context.globalState.update(RECENT_PROJECTS, recent);
    await this.context.workspaceState.update(FIRMWARE_OVERRIDE, undefined);
  }

  public async clearProjects(): Promise<void> {
    await this.context.workspaceState.update(SELECTED_PROJECT, undefined);
    await this.context.globalState.update(RECENT_PROJECTS, []);
    await this.context.workspaceState.update(FIRMWARE_OVERRIDE, undefined);
  }

  /** 只移除指定项目的记忆；若它正被选中，同时清除当前选择和固件覆盖。 */
  public async removeRecentProject(projectPath: string): Promise<void> {
    const normalized = path.resolve(projectPath);
    await this.context.globalState.update(
      RECENT_PROJECTS,
      this.recentProjects.filter((item) => path.resolve(item) !== normalized)
    );
    if (this.selectedProject && path.resolve(this.selectedProject) === normalized) {
      await this.context.workspaceState.update(SELECTED_PROJECT, undefined);
      await this.context.workspaceState.update(FIRMWARE_OVERRIDE, undefined);
    }
  }

  public async setFirmwareOverride(value?: string): Promise<void> {
    await this.context.workspaceState.update(FIRMWARE_OVERRIDE, value ? path.resolve(value) : undefined);
  }
}

export async function isAriaWorkspace(directory: string): Promise<boolean> {
  const markers = ['.west', '.workspace-track.json', 'manifest', 'application'];
  let matches = 0;
  for (const marker of markers) {
    try {
      await fs.access(path.join(directory, marker));
      matches += 1;
    } catch {
      // 一个有效的 workspace track 不要求所有可选标记同时存在。
    }
  }
  return matches >= 2;
}
