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
import { listSerialPorts } from './services/serialPorts';
import { listUsbDfuDevices, UsbDfuService } from './services/usbDfu';

export class Ats362xSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private readonly webviews = new Set<vscode.Webview>();
  private state: ProjectState = { recentProjects: [], discoveredFirmware: [], serialPorts: [], tools: [] };
  private readonly terminal = new TerminalRunner();
  private readonly hid = new HidDfuService();
  private readonly usbDfu = new UsbDfuService();
  private readonly usbDfuOutput = vscode.window.createOutputChannel('ATS362X USB DFU');

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectStore
  ) {
    this.context.subscriptions.push(this.usbDfuOutput);
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.configureWebview(view.webview);
    view.onDidDispose(() => this.webviews.delete(view.webview));
    await this.refresh();
  }

  /** 在编辑区打开或复用完整控制台页面。 */
  public async openPanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.post({ type: 'state', state: this.state });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'ats362xBuild.console',
      'ATS362X 构建与烧录',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;
    this.configureWebview(panel.webview);
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview);
      this.panel = undefined;
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
            .filter((entry) => entry.isFile() && ['.bin', '.dfu', '.fw', '.img', '.hex'].includes(path.extname(entry.name).toLowerCase()))
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
      serialPorts: await listSerialPorts(),
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
        case 'openPanel':
          await this.openPanel();
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
        case 'selectHidFirmware':
          await this.selectFirmware(false, ['bin']);
          break;
        case 'selectUsbDfuFirmware':
          await this.selectFirmware(false, ['bin', 'dfu']);
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
          this.post({ type: 'hidDevices', devices: await this.hid.list() });
          break;
        case 'listUsbDfu':
          this.post({
            type: 'usbDfuDevices',
            devices: await listUsbDfuDevices(
              vscode.workspace.getConfiguration('ats362xBuild').get<string>('dfuUtilPath', 'dfu-util')
            )
          });
          break;
        case 'usbDfu':
          await this.runUsbDfu(message.device, message.firmware, message.reset);
          break;
        case 'usbDfuAbort':
          this.usbDfu.cancel();
          this.notice('warning', '正在取消 USB DFU…');
          break;
        case 'listSerial':
          this.state.serialPorts = await listSerialPorts();
          this.post({ type: 'state', state: this.state });
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

  private async selectFirmware(directory: boolean, extensions = ['bin', 'dfu', 'fw', 'img', 'hex']): Promise<void> {
    const base = this.projects.firmwareOverride ?? this.state.defaultFirmwareDirectory ?? this.projects.selectedProject;
    const result = await vscode.window.showOpenDialog({
      title: directory ? '选择固件目录' : '选择固件文件',
      canSelectFiles: !directory,
      canSelectFolders: directory,
      canSelectMany: false,
      defaultUri: base ? vscode.Uri.file(base) : undefined,
      filters: directory ? undefined : { 'ATS362X 固件': extensions },
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
      : request.options.method === 'ota-uart' || request.action === 'usbDfu' ? 'ota' : 'any';
    const explicitFirmware = typeof request.options.firmware === 'string' && request.options.firmware.length > 0
      ? request.options.firmware
      : undefined;
    const firmware = chooseFirmware(explicitFirmware, this.state.discoveredFirmware, preference);
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

  private async runUsbDfu(
    device: import('./types').UsbDfuDeviceInfo,
    firmware: string,
    reset: boolean
  ): Promise<void> {
    const selected = firmware || chooseFirmware(undefined, this.state.discoveredFirmware, 'ota');
    if (!selected) throw new Error('没有找到可用于 USB DFU 的 .bin/.dfu 固件');
    if (!['.bin', '.dfu'].includes(path.extname(selected).toLowerCase())) {
      throw new Error('USB DFU 需要选择 .bin 或 .dfu 固件');
    }
    const executable = vscode.workspace.getConfiguration('ats362xBuild').get<string>('dfuUtilPath', 'dfu-util');
    this.state.busy = 'usbDfu';
    this.post({ type: 'state', state: this.state });
    this.usbDfuOutput.clear();
    this.usbDfuOutput.appendLine(`设备：${device.vendorId.toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')} @ ${device.usbPath}`);
    this.usbDfuOutput.appendLine(`固件：${selected}`);
    this.usbDfuOutput.show(true);
    try {
      await this.usbDfu.upload(
        executable,
        device,
        selected,
        reset,
        (percent, detail) => this.post({ type: 'progress', action: 'usbDfu', percent, detail }),
        (text) => this.usbDfuOutput.append(text)
      );
      this.notice('info', 'USB DFU 传输完成');
    } finally {
      this.state.busy = undefined;
      this.post({ type: 'state', state: this.state });
    }
  }

  private post(message: ExtensionToWebview): void {
    for (const webview of this.webviews) {
      void webview.postMessage(message);
    }
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

  private configureWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist-webview')]
    };
    webview.html = this.html(webview);
    this.webviews.add(webview);
    webview.onDidReceiveMessage((message: WebviewToExtension) => {
      void this.handle(message);
    });
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}
