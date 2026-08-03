import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionToWebview, ProjectState, WebviewToExtension } from './types';
import { buildCommand } from './services/commandBuilder';
import { chooseFirmware, discoverFirmware } from './services/firmwareLocator';
import { HidDfuService } from './services/hidDfu';
import { ProjectStore, isAriaWorkspace } from './services/projectStore';
import { TerminalRunner } from './services/terminalRunner';
import { inspectTools } from './services/tooling';

export class Ats362xSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private state: ProjectState = { recentProjects: [], discoveredFirmware: [], tools: [] };
  private readonly terminal = new TerminalRunner();
  private readonly hid = new HidDfuService();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectStore
  ) {}

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist-webview')
      ]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewToExtension) => {
      void this.handle(message);
    });
    await this.refresh();
  }

  public async selectProject(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      title: '选择 ARIA workspace 或 workspace track',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: this.projects.selectedProject ? vscode.Uri.file(this.projects.selectedProject) : undefined,
      openLabel: '选择项目'
    });
    if (!result?.[0]) return;
    const projectPath = result[0].fsPath;
    if (!await isAriaWorkspace(projectPath)) {
      const answer = await vscode.window.showWarningMessage(
        '该目录未检测到典型 ARIA workspace 结构，仍然使用吗？',
        { modal: true },
        '仍然使用'
      );
      if (answer !== '仍然使用') return;
    }
    await this.projects.selectProject(projectPath);
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    const projectPath = this.projects.selectedProject;
    const discovery = await discoverFirmware(projectPath);
    const override = this.projects.firmwareOverride;
    let overrideFiles: string[] = [];
    if (override) {
      try {
        const stat = await fs.stat(override);
        if (stat.isDirectory()) {
          const entries = await fs.readdir(override, { withFileTypes: true });
          overrideFiles = entries
            .filter((entry) => entry.isFile() && ['.bin', '.fw', '.img', '.hex'].includes(path.extname(entry.name).toLowerCase()))
            .map((entry) => path.join(override, entry.name));
        } else {
          overrideFiles = [override];
        }
      } catch {
        // 保留无效覆盖路径供界面显示，实际执行时会给出明确错误。
      }
    }
    this.state = {
      projectPath,
      recentProjects: this.projects.recentProjects,
      firmwareOverride: override,
      defaultFirmwareDirectory: discovery.defaultDirectory,
      discoveredFirmware: [...overrideFiles, ...discovery.files.filter((file) => !overrideFiles.includes(file))],
      tools: await inspectTools(),
      busy: this.state.busy
    };
    this.post({ type: 'state', state: this.state });
  }

  private async handle(message: WebviewToExtension): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.refresh();
          break;
        case 'selectProject':
          await this.selectProject();
          break;
        case 'selectRecentProject':
          await this.projects.selectProject(message.path);
          await this.refresh();
          break;
        case 'clearProjects': {
          const answer = await vscode.window.showWarningMessage('清除全部项目历史和固件覆盖路径？', { modal: true }, '清除');
          if (answer === '清除') {
            await this.projects.clearProjects();
            await this.refresh();
          }
          break;
        }
        case 'selectFirmware':
          await this.selectFirmware(false);
          break;
        case 'selectFirmwareDirectory':
          await this.selectFirmware(true);
          break;
        case 'clearFirmwareOverride':
          await this.projects.setFirmwareOverride();
          await this.refresh();
          break;
        case 'run':
          await this.run(message.request);
          break;
        case 'listHid':
          this.post({ type: 'hidDevices', devices: this.hid.list() });
          break;
        case 'hidDfu':
          await this.runHidDfu(message.path, message.firmware, message.expectedBcd);
          break;
        case 'hidAbort':
          this.hid.cancel();
          this.notice('warning', '正在取消 HID DFU…');
          break;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.notice('error', messageText);
      void vscode.window.showErrorMessage(`ATS362X：${messageText}`);
    }
  }

  private async selectFirmware(directory: boolean): Promise<void> {
    const base = this.projects.firmwareOverride ?? this.state.defaultFirmwareDirectory ?? this.projects.selectedProject;
    const result = await vscode.window.showOpenDialog({
      title: directory ? '选择固件目录' : '选择固件文件',
      canSelectFiles: !directory,
      canSelectFolders: directory,
      canSelectMany: false,
      defaultUri: base ? vscode.Uri.file(base) : undefined,
      filters: directory ? undefined : { 'ATS362X 固件': ['bin', 'fw', 'img', 'hex'], '所有文件': ['*'] },
      openLabel: directory ? '使用该目录' : '使用该固件'
    });
    if (result?.[0]) {
      await this.projects.setFirmwareOverride(result[0].fsPath);
      await this.refresh();
    }
  }

  private async run(request: import('./types').RunRequest): Promise<void> {
    const cwd = this.projects.selectedProject;
    if (!cwd) throw new Error('请先选择项目目录');
    const preference = request.action === 'extractFw' || request.options.method === 'fw-usb' || request.options.method === 'fw-uart'
      ? 'fw'
      : request.options.method === 'ota-uart' ? 'ota' : 'any';
    const firmware = chooseFirmware(undefined, this.state.discoveredFirmware, preference);
    const command = buildCommand(request, firmware);
    await this.terminal.run(command, cwd);
    this.notice('info', `已在终端运行：${command.executable} ${command.args.join(' ')}`);
  }

  private async runHidDfu(devicePath: string, firmware: string, expectedBcd: number): Promise<void> {
    const selected = firmware || chooseFirmware(undefined, this.state.discoveredFirmware, 'ota');
    if (!selected) throw new Error('没有找到可用于 HID DFU 的 OTA .bin 固件');
    if (path.extname(selected).toLowerCase() !== '.bin') {
      throw new Error('HID DFU 需要选择 OTA .bin 固件');
    }
    this.state.busy = 'hidDfu';
    this.post({ type: 'state', state: this.state });
    const timeout = vscode.workspace.getConfiguration('ats362xBuild').get<number>('hidAckTimeoutMs', 2500);
    try {
      await this.hid.upload(devicePath, selected, expectedBcd, timeout, (percent, detail) => {
        this.post({ type: 'progress', action: 'hidDfu', percent, detail });
      });
      this.notice('info', 'HID DFU 传输完成，设备将自动重启');
    } finally {
      this.state.busy = undefined;
      this.post({ type: 'state', state: this.state });
    }
  }

  private post(message: ExtensionToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private notice(level: 'info' | 'warning' | 'error', message: string): void {
    this.post({ type: 'notice', level, message });
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist-webview', 'assets', 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist-webview', 'assets', 'index.css'));
    const nonce = getNonce();
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>ATS362X</title>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}
