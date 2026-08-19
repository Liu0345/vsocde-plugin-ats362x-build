import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExtensionToWebview, ProjectState, WebviewToExtension } from './types';
import { buildCommand } from './services/commandBuilder';
import { chooseFirmware, discoverFirmware, FirmwareEntry } from './services/firmwareLocator';
import { HidDfuService } from './services/hidDfu';
import { ProjectStore, isAriaWorkspace } from './services/projectStore';
import { TerminalRunner } from './services/terminalRunner';
import { FlashRunner, FlashToolPaths } from './services/flashRunner';
import { inspectTools } from './services/tooling';
import { checkSerialPortAvailability, listSerialPorts, SerialPortReservation } from './services/serialPorts';
import { listUsbDfuDevices, UsbDfuService } from './services/usbDfu';
import { IdentityAuthorizationService } from './services/identityAuthorization';
import { discoverBuildOptions } from './services/buildOptions';
import { isWebviewDisposedError, WebviewRegistry } from './services/webviewRegistry';
import {
  createTemporaryEraseInventory,
  pulseSerialResetLines,
  sendShellAdfuCommand,
  TemporaryEraseInventory,
  waitForMacAdfuLocation
} from './services/adfuErase';

export class Ats362xSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private readonly webviews = new WebviewRegistry<vscode.Webview>((error) => {
    console.error('[ATS362X] Webview message delivery failed', error);
  });
  private state: ProjectState = { recentProjects: [], discoveredFirmware: [], serialPorts: [], tools: [], buildOptions: [] };
  private readonly terminal = new TerminalRunner();
  private readonly flashRunner = new FlashRunner();
  private readonly hid = new HidDfuService();
  private readonly usbDfu = new UsbDfuService();
  private readonly identity: IdentityAuthorizationService;
  private readonly serialReservation = new SerialPortReservation();
  private eraseAbort?: AbortController;
  private readonly usbDfuOutput = vscode.window.createOutputChannel('ATS362X USB DFU');
  private readonly flashOutput = vscode.window.createOutputChannel('ATS362X 串口烧录');

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: ProjectStore
  ) {
    const configuration = vscode.workspace.getConfiguration('ats362xBuild');
    this.identity = new IdentityAuthorizationService({
      tokenUrl: configuration.get<string>('identityTokenUrl'),
      snUrl: configuration.get<string>('identitySnUrl'),
      commandTimeoutMs: configuration.get<number>('identityCommandTimeoutMs'),
      httpTimeoutMs: configuration.get<number>('identityHttpTimeoutMs')
    });
    this.context.subscriptions.push(this.usbDfuOutput);
    this.context.subscriptions.push(this.flashOutput);
    this.context.subscriptions.push({ dispose: () => void this.serialReservation.release() });
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.configureWebview(view.webview);
    view.onDidDispose(() => {
      this.webviews.unregister(view.webview);
      if (this.view === view) this.view = undefined;
    });
    await this.refresh();
  }

  /** 在编辑区打开或复用完整控制台页面。 */
  public async openPanel(): Promise<void> {
    if (this.panel) {
      const existing = this.panel;
      try {
        existing.reveal(vscode.ViewColumn.Active);
        this.post({ type: 'state', state: this.state });
        return;
      } catch (error) {
        this.webviews.unregister(existing.webview);
        if (this.panel === existing) this.panel = undefined;
        if (!isWebviewDisposedError(error)) throw error;
      }
    }
    const panel = vscode.window.createWebviewPanel(
      'ats362xBuild.console',
      'ATS362X 构建与烧录',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.configureWebview(panel.webview);
    this.panel = panel;
    panel.onDidDispose(() => {
      this.webviews.unregister(panel.webview);
      if (this.panel === panel) this.panel = undefined;
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
    let overrideEntries: FirmwareEntry[] = [];
    if (override) {
      try {
        const stat = await fs.stat(override);
        if (stat.isDirectory()) {
          const files = (await fs.readdir(override, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && ['.bin', '.dfu', '.fw', '.img', '.hex'].includes(path.extname(entry.name).toLowerCase()))
            .map((entry) => path.join(override, entry.name));
          overrideEntries = await this.collectFirmwareEntries(files);
        } else {
          const statInfo = await fs.stat(override);
          if (statInfo.isFile()) {
            overrideEntries = [{ path: override, modified: statInfo.mtimeMs }];
          }
        }
      } catch {
        // 保留无效覆盖路径供界面显示，实际执行时会给出明确错误。
      }
    }
    const normalizedByPath = new Set<string>(overrideEntries.map((entry) => path.resolve(entry.path)));
    const discoveredFirmware = [
      ...overrideEntries,
      ...discovery.files.filter((entry) => {
        const candidate = path.resolve(entry.path);
        if (normalizedByPath.has(candidate)) return false;
        normalizedByPath.add(candidate);
        return true;
      })
    ];
    this.state = {
      projectPath,
      recentProjects: this.projects.recentProjects,
      firmwareOverride: override,
      defaultFirmwareDirectory: discovery.defaultDirectory,
      discoveredFirmware,
      serialPorts: await listSerialPorts(),
      tools: await inspectTools(),
      buildOptions: await discoverBuildOptions(projectPath),
      busy: this.state.busy
    };
    this.post({ type: 'state', state: this.state });
    this.post({ type: 'serialReservations', paths: this.serialReservation.reservedPaths });
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
          const answer = await vscode.window.showWarningMessage('清除全部项目记忆和固件覆盖路径？', { modal: true }, '清除全部');
          if (answer === '清除全部') {
            await this.projects.clearProjects();
            await this.refresh();
          }
          break;
        }
        case 'removeRecentProject':
          await this.projects.removeRecentProject(message.path);
          await this.refresh();
          this.notice('info', `已清除项目记忆：${message.path}`);
          break;
        case 'selectFirmware':
          await this.selectFirmware(false);
          break;
        case 'selectHidFirmware':
          await this.selectFirmware(false, ['bin']);
          break;
        case 'selectUsbDfuFirmware':
          await this.selectUsbDfuFirmware();
          break;
        case 'selectFirmwareDirectory':
          await this.selectFirmware(true);
          break;
        case 'scanFirmware':
          await this.refresh();
          this.notice(
            'info',
            this.state.discoveredFirmware.length > 0
              ? `已重新扫描到 ${this.state.discoveredFirmware.length} 个固件文件`
              : '当前项目和固件覆盖目录中未发现固件文件'
          );
          break;
        case 'clearFirmwareOverride':
          await this.projects.setFirmwareOverride();
          await this.refresh();
          break;
        case 'scanBuildOptions':
          this.state.buildOptions = await discoverBuildOptions(this.projects.selectedProject);
          this.post({ type: 'state', state: this.state });
          this.notice(
            'info',
            this.state.buildOptions.length > 0
              ? `已扫描 ${this.state.buildOptions.length} 个 App 和 ${new Set(this.state.buildOptions.flatMap((item) => item.boards)).size} 个 Board`
              : '当前项目未发现可用的 App 或 Board，仍可自行输入'
          );
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
        case 'checkSerialPort':
          await this.checkSerialPort(message.port);
          break;
        case 'setSerialPortReservation':
          await this.setSerialPortReservation(message.port, message.reserved);
          break;
        case 'hidDfu':
          await this.runHidDfu(message.path, message.firmware, message.expectedBcd);
          break;
        case 'hidAbort':
          this.hid.cancel();
          this.notice('warning', '正在取消 HID DFU…');
          break;
        case 'eraseAbort':
          this.eraseAbort?.abort();
          this.flashRunner.cancel();
          this.notice('warning', '正在取消全擦除…');
          break;
        case 'identityAction':
          await this.runIdentityAuthorization(message.request);
          break;
        case 'identityCancel':
          this.identity.cancel();
          this.notice('warning', '正在取消身份认证操作…');
          break;
      }
    } catch (error) {
      // A user may close the editor while an asynchronous command is finishing.
      // The disposal is expected lifecycle behavior and must not poison later opens.
      if (isWebviewDisposedError(error)) return;
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

  /** USB DFU 的自选固件只返回给当前页面，不修改项目级固件覆盖路径。 */
  private async selectUsbDfuFirmware(): Promise<void> {
    const base = this.state.defaultFirmwareDirectory ?? this.projects.selectedProject;
    const result = await vscode.window.showOpenDialog({
      title: '选择 USB DFU 固件',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri: base ? vscode.Uri.file(base) : undefined,
      filters: { 'USB DFU 固件': ['bin', 'dfu'] },
      openLabel: '使用该固件'
    });
    if (result?.[0]) {
      this.post({ type: 'usbDfuFirmwareSelected', path: result[0].fsPath });
    }
  }

  private async run(request: import('./types').RunRequest): Promise<void> {
    const cwd = this.projects.selectedProject;
    if (!cwd) throw new Error('请先选择项目目录');
    await this.checkRunSerialPort(request);
    if (request.action === 'erase' && request.options.dryRun !== true) {
      this.validateEraseOptions(request.options);
    }
    const preference = request.action === 'extractFw' || request.options.method === 'fw-usb' || request.options.method === 'fw-uart'
      ? 'fw'
      : request.options.method === 'ota-uart' || request.action === 'usbDfu' ? 'ota' : 'any';
    const explicitFirmware = typeof request.options.firmware === 'string' && request.options.firmware.length > 0
      ? request.options.firmware
      : undefined;
    if (request.action === 'flash' && !explicitFirmware) {
      throw new Error('请先选择需要烧录的固件；“选择-空”表示不选择文件');
    }
    const firmware = chooseFirmware(explicitFirmware, this.state.discoveredFirmware, preference);
    const command = buildCommand(request, firmware);

    if (request.action === 'flash') {
      this.state.busy = 'flash';
      this.post({ type: 'state', state: this.state });
      this.flashOutput.clear();
      this.flashOutput.appendLine(`命令: ${command.executable} ${command.args.join(' ')}`);
      this.flashOutput.show(true);
      this.post({ type: 'progress', action: 'flash', percent: 0, detail: '准备执行串口烧录' });
      try {
        await this.flashRunner.run(cwd, command, (percent, detail) => {
          this.post({ type: 'progress', action: 'flash', percent, detail });
          this.flashOutput.appendLine(`${percent.toString().padStart(3, ' ')}% ${detail}`);
        }, (text) => {
          this.flashOutput.append(text);
        }, '烧录', this.flashToolPaths());
        this.notice('info', `串口固件烧录命令已完成：${command.executable} ${command.args.join(' ')}`);
      } finally {
        this.state.busy = undefined;
        this.post({ type: 'state', state: this.state });
      }
      return;
    }

    if (request.action === 'erase') {
      if (request.options.entry === 'shell' && request.options.dryRun !== true &&
          typeof request.options.shellPort === 'string' && request.options.shellPort.trim() === '') {
        throw new Error('Shell 模式下必须填写 Shell UART 串口');
      }
      if (request.options.dryRun !== true) {
        const answer = await vscode.window.showWarningMessage(
          '全擦除会清除设备 Flash 中的全部内容，确认继续吗？',
          { modal: true },
          '确认全擦除'
        );
        if (answer !== '确认全擦除') return;
      }
      this.state.busy = 'erase';
      this.post({ type: 'state', state: this.state });
      this.flashOutput.clear();
      this.flashOutput.show(true);
      this.post({ type: 'progress', action: 'erase', percent: 0, detail: '准备执行全擦除' });
      const abort = new AbortController();
      this.eraseAbort = abort;
      let temporaryInventory: TemporaryEraseInventory | undefined;
      let highestProgress = 0;

      const appendProgress = (percent: number, detail: string): void => {
        highestProgress = Math.max(highestProgress, percent);
        this.post({ type: 'progress', action: 'erase', percent: highestProgress, detail });
        this.flashOutput.appendLine(`${highestProgress.toString().padStart(3, ' ')}% ${detail}`);
      };
      const executeErase = async (
        runRequest: import('./types').RunRequest
      ): Promise<{ command: string; output: string; }> => {
        const resolvedCommand = buildCommand(runRequest, undefined);
        this.flashOutput.appendLine(`执行命令: ${resolvedCommand.executable} ${resolvedCommand.args.join(' ')}`);
        let outputBuffer = '';
        await this.flashRunner.run(cwd, resolvedCommand, (percent, detail) => {
          appendProgress(percent, detail);
          outputBuffer += `${detail}\n`;
        }, (text) => {
          outputBuffer += text;
          this.flashOutput.append(text);
          if (/SPI erase payload uploaded/i.test(text)) appendProgress(18, '擦除负载已上传');
          if (/Flash ID:/i.test(text)) appendProgress(20, '已识别 SPI Flash');
        }, '全擦除', this.flashToolPaths());
        return {
          command: `${resolvedCommand.executable} ${resolvedCommand.args.join(' ')}`,
          output: outputBuffer
        };
      };

      try {
        if (request.options.dryRun === true) {
          const result = await executeErase(request);
          this.notice('info', `全擦除预演命令已完成：${result.command}`);
          return;
        }

        const shellPort = String(request.options.shellPort ?? '').trim();
        const timeoutSeconds = Number.parseInt(String(request.options.timeout || '120'), 10);
        const [vidText, pidText] = String(request.options.vidPid || '10d6:10d6').split(':');
        const vendorId = Number.parseInt(vidText, 16);
        const productId = Number.parseInt(pidText, 16);

        if (request.options.entry === 'shell') {
          appendProgress(5, `正在通过 ${shellPort} 发送 Shell 进入命令`);
          const response = await sendShellAdfuCommand(
            shellPort,
            Number.parseInt(String(request.options.shellBaud || '3000000'), 10),
            String(request.options.shellCmd || 'dbg reboot adfu'),
            abort.signal
          );
          if (response.trim()) {
            this.flashOutput.appendLine('Shell 回显:');
            this.flashOutput.appendLine(response);
          }
          appendProgress(10, 'Shell 命令已发送，正在等待 ADFU');
        }

        let runRequest: import('./types').RunRequest = {
          ...request,
          options: {
            ...request.options,
            entry: 'manual',
            shellPort: '',
            shellBaud: '',
            shellCmd: ''
          }
        };

        if (process.platform === 'darwin') {
          const location = await waitForMacAdfuLocation(vendorId, productId, timeoutSeconds, abort.signal);
          appendProgress(15, `已检测到 ADFU，物理槽位 ${location.slotId}`);
          temporaryInventory = await createTemporaryEraseInventory(location.slotId, shellPort || undefined);
          runRequest = {
            ...runRequest,
            options: {
              ...runRequest.options,
              inventory: temporaryInventory.path,
              device: temporaryInventory.device
            }
          };
        }

        let result: { command: string; output: string };
        try {
          result = await executeErase(runRequest);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const recoverableUsbFailure = /USB error: (?:Input\/Output Error|Pipe error)|READRAM CBW|WRITERAM CBW/i.test(detail);
          if (!recoverableUsbFailure || !shellPort || process.platform !== 'darwin') throw error;
          this.flashOutput.appendLine('检测到擦除负载 USB 中断，正在通过串口控制线复位并完整重试一次…');
          appendProgress(15, 'USB 中断，正在复位到 ADFU 后重试');
          await pulseSerialResetLines(shellPort, abort.signal);
          const location = await waitForMacAdfuLocation(vendorId, productId, timeoutSeconds, abort.signal);
          await temporaryInventory?.dispose();
          temporaryInventory = await createTemporaryEraseInventory(location.slotId, shellPort);
          runRequest = {
            ...runRequest,
            options: {
              ...runRequest.options,
              inventory: temporaryInventory.path,
              device: temporaryInventory.device
            }
          };
          result = await executeErase(runRequest);
        }

        if (!this.hasEraseSuccessOutput(result.output)) {
          throw new Error('全擦除命令退出，但未收到 Flash erase complete 成功标记');
        }
        this.notice('info', `全擦除成功：${result.command}`);
      } finally {
        this.eraseAbort = undefined;
        await temporaryInventory?.dispose();
        this.state.busy = undefined;
        this.post({ type: 'state', state: this.state });
      }
      return;
    }

    await this.terminal.run(command, cwd);
    this.notice('info', `已在终端运行：${command.executable} ${command.args.join(' ')}`);
  }

  private validateEraseOptions(options: Record<string, string | number | boolean | undefined>): void {
    const parsePositiveInt = (value: unknown, label: string): number | undefined => {
      if (value === undefined || value === null || String(value).trim() === '') {
        return undefined;
      }
      const text = String(value).trim();
      if (!/^\d+$/.test(text)) {
        throw new Error(`${label}必须为正整数`);
      }
      const parsed = Number.parseInt(text, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${label}必须为正整数`);
      }
      return parsed;
    };
    parsePositiveInt(options.size, '擦除大小');
    parsePositiveInt(options.timeout, '超时秒数');
    if (options.vidPid && !/^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$/.test(String(options.vidPid).trim())) {
      throw new Error('ADFU VID:PID 格式应为 XXXX:XXXX');
    }
  }

  private flashToolPaths(): FlashToolPaths {
    const configuration = vscode.workspace.getConfiguration('ats362xBuild');
    return {
      baton: configuration.get<string>('batonPath', 'baton'),
      'actions-flash': configuration.get<string>('actionsFlashPath', 'actions-flash')
    };
  }

  private hasEraseSuccessOutput(output: string): boolean {
    return /Flash erase complete:\s*\d+KB,\s*chip_id=0x[0-9a-f]+,\s*verified\s+3\s+sectors/i.test(output);
  }

  /** 对执行请求中的显式串口做最后一次占用检查，探测完成后立即释放。 */
  private async checkRunSerialPort(request: import('./types').RunRequest): Promise<void> {
    if (request.action === 'flash' && typeof request.options.uart === 'string' && request.options.uart.trim()) {
      await this.assertSerialPortAvailable(request.options.uart, '固件烧录');
    }
    if (request.action === 'erase' && request.options.entry === 'shell' && request.options.dryRun !== true &&
        typeof request.options.shellPort === 'string' && request.options.shellPort.trim()) {
      await this.assertSerialPortAvailable(request.options.shellPort, 'Shell 操作');
    }
  }

  private async runHidDfu(devicePath: string, firmware: string, expectedBcd: number): Promise<void> {
    const selected = firmware;
    if (!selected) throw new Error('请先选择用于 HID DFU 的 OTA .bin 固件');
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
    const selected = firmware;
    if (!selected) throw new Error('请先选择用于 USB DFU 的 .bin/.dfu 固件');
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

  private async runIdentityAuthorization(request: import('./types').IdentityRequest): Promise<void> {
    if (request.action === 'clearAlgorithm' || request.action === 'clearSn') {
      const label = request.action === 'clearAlgorithm' ? '算法身份授权' : 'SN 身份授权';
      const answer = await vscode.window.showWarningMessage(
        `确定仅清除当前设备的${label}？插件不会下发另一项授权的清除命令，并会在操作前后检查另一项状态。`,
        { modal: true },
        '确认清除'
      );
      if (answer !== '确认清除') return;
    }
    const resolvedPort = this.resolveSerialPort(request.port);
    const restoreReservation = request.keepPortReserved || this.serialReservation.isReserved(resolvedPort);
    if (this.serialReservation.isReserved(resolvedPort)) {
      await this.serialReservation.release(resolvedPort);
    }
    this.state.busy = 'identity';
    this.post({ type: 'state', state: this.state });
    this.post({ type: 'identityBusy', busy: true, action: request.action });
    try {
      const result = await this.identity.run(
        { ...request, port: resolvedPort },
        (event) => this.post({ type: 'identityEvent', event })
      );
      this.post({ type: 'identityResult', result });
      if (result.status === 'error') {
        this.notice('error', result.summary);
      } else {
        this.notice('info', result.summary);
      }
    } finally {
      if (restoreReservation) {
        try {
          await this.serialReservation.reserve(resolvedPort, request.baudRate);
          this.notice('info', `${resolvedPort}：身份认证结束，已恢复持续占用`);
          this.post({ type: 'serialReservationResult', requestedPort: request.port, resolvedPort, reserved: true });
        } catch (error) {
          this.notice('warning', `${resolvedPort}：身份认证结束，但恢复持续占用失败：${error instanceof Error ? error.message : String(error)}`);
          this.post({ type: 'serialReservationResult', requestedPort: request.port, resolvedPort, reserved: false });
        }
        this.post({ type: 'serialReservations', paths: this.serialReservation.reservedPaths });
      }
      this.state.busy = undefined;
      this.post({ type: 'state', state: this.state });
      this.post({ type: 'identityBusy', busy: false });
    }
  }

  /** 选择时只做短暂探测，不保留串口句柄，也不清空用户选择。 */
  private async checkSerialPort(value: string): Promise<void> {
    const resolved = this.resolveSerialPort(value);
    if (this.serialReservation.isReserved(resolved)) {
      this.notice('info', `${resolved}：当前由插件持续占用`);
      return;
    }
    const result = await checkSerialPortAvailability(resolved);
    if (!result.available) {
      const message = `${resolved}：${result.reason}`;
      this.notice('warning', message);
      void vscode.window.showWarningMessage(message);
      return;
    }
    this.notice('info', `${resolved}：串口可用，检查后已释放`);
  }

  private async setSerialPortReservation(value: string, reserved: boolean): Promise<void> {
    const resolved = this.resolveSerialPort(value);
    if (!reserved) {
      const wasReserved = this.serialReservation.isReserved(resolved);
      await this.serialReservation.release(resolved);
      if (wasReserved) this.notice('info', `${resolved}：已取消持续占用并释放串口`);
      this.post({ type: 'serialReservations', paths: this.serialReservation.reservedPaths });
      this.post({ type: 'serialReservationResult', requestedPort: value, resolvedPort: resolved, reserved: false });
      return;
    }

    try {
      await this.serialReservation.reserve(resolved);
      this.notice('info', `${resolved}：已开启持续占用`);
      this.post({ type: 'serialReservationResult', requestedPort: value, resolvedPort: resolved, reserved: true });
    } catch (error) {
      const message = `${resolved}：${error instanceof Error ? error.message : String(error)}`;
      this.notice('warning', message);
      void vscode.window.showWarningMessage(message);
      this.post({ type: 'serialReservationResult', requestedPort: value, resolvedPort: resolved, reserved: false });
    } finally {
      this.post({ type: 'serialReservations', paths: this.serialReservation.reservedPaths });
    }
  }

  private async assertSerialPortAvailable(value: string, purpose: string): Promise<void> {
    const resolved = this.resolveSerialPort(value);
    if (this.serialReservation.isReserved(resolved)) {
      throw new Error(`${purpose}无法使用 ${resolved}：该串口已由插件持续占用，请先取消“持续占用串口”`);
    }
    const result = await checkSerialPortAvailability(resolved);
    if (!result.available) {
      throw new Error(`${purpose}无法使用 ${resolved}：${result.reason}`);
    }
  }

  /** 支持完整串口路径，也支持输入面板常用的尾号（例如 891）。 */
  private resolveSerialPort(value: string): string {
    const input = value.trim();
    if (!input) throw new Error('请选择或输入身份认证串口');
    const exact = this.state.serialPorts.find((port) => port.path === input);
    if (exact) return exact.path;

    if (/^\d+$/.test(input)) {
      const matches = this.state.serialPorts.filter((port) => port.path.endsWith(input));
      if (matches.length === 1) return matches[0].path;
      if (matches.length > 1) throw new Error(`串口尾号 ${input} 匹配到多个设备，请选择完整路径`);
      if (process.platform === 'darwin') return `/dev/cu.usbmodem01234567${input}`;
      if (process.platform === 'win32') return `COM${input}`;
    }
    return input;
  }

  private post(message: ExtensionToWebview): void {
    this.webviews.post(message);
  }

  private async collectFirmwareEntries(files: string[]): Promise<FirmwareEntry[]> {
    const entries: FirmwareEntry[] = [];
    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) {
          entries.push({ path: file, modified: stat.mtimeMs });
        }
      } catch {
        // 发现路径无效时静默跳过，实际扫描后端会返回更明确状态。
      }
    }
    return entries;
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
    this.webviews.register(webview);
    webview.onDidReceiveMessage((message: WebviewToExtension) => {
      void this.handle(message);
    });
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}
