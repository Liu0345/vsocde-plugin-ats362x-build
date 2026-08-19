import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const identityCredentialSession: { username: string; password: string } = { username: '', password: '' };

type Page = 'project' | 'build' | 'dfu' | 'identity' | 'tools';
interface Tool { name: string; label: string; available: boolean; detail: string }
interface BuildOptionInfo { app: string; boards: string[] }
interface EditableChoiceOption { value: string; label?: string }
interface FirmwareChoice { path: string; modified: number }
interface State {
  projectPath?: string;
  recentProjects: string[];
  firmwareOverride?: string;
  defaultFirmwareDirectory?: string;
  discoveredFirmware: FirmwareChoice[];
  serialPorts: SerialPortInfo[];
  tools: Tool[];
  buildOptions: BuildOptionInfo[];
  busy?: string;
}
interface SerialPortInfo { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }
interface HidDevice {
  path: string;
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  serialNumber?: string;
  usagePage?: number;
}
interface UsbDfuDevice {
  key: string;
  vendorId: number;
  productId: number;
  usbPath: string;
  serialNumber?: string;
  product?: string;
  manufacturer?: string;
  dfuName?: string;
  version?: string;
  alt: number;
}
interface Notice { level: string; message: string; time: string }
interface TransferProgress { action: 'usbDfu' | 'hidDfu' | 'flash' | 'erase' | ''; percent: number; detail: string }
type IdentityTarget = 'algorithm' | 'sn' | 'system';
type IdentityStatus = 'authorized' | 'unauthorized' | 'unknown' | 'running' | 'error';
type IdentityAction = 'checkAlgorithm' | 'authorizeAlgorithm' | 'clearAlgorithm' | 'checkSn' | 'authorizeSn' | 'clearSn' | 'runCustom';
interface IdentityCommands {
  algorithmStatus: string;
  algorithmInfo: string;
  algorithmWrite: string;
  algorithmClear: string;
  snStatus: string;
  snInfo: string;
  snWrite: string;
  snClear: string;
  reboot: string;
}
interface IdentityEvent {
  id: number;
  target: IdentityTarget;
  level: 'pending' | 'success' | 'warning' | 'error' | 'output';
  title: string;
  detail?: string;
  raw?: string;
  timestamp: string;
}
interface IdentityResult { target: IdentityTarget; status: IdentityStatus; summary: string; fields?: Record<string, string> }

const initialState: State = { recentProjects: [], discoveredFirmware: [], serialPorts: [], tools: [], buildOptions: [] };

function App(): JSX.Element {
  const [page, setPage] = useState<Page>('project');
  const [state, setState] = useState<State>(initialState);
  const [hidDevices, setHidDevices] = useState<HidDevice[]>([]);
  const [usbDfuDevices, setUsbDfuDevices] = useState<UsbDfuDevice[]>([]);
  const [usbDfuDeviceKey, setUsbDfuDeviceKey] = useState('');
  const [hidDevicePath, setHidDevicePath] = useState('');
  const [usbDfuFirmware, setUsbDfuFirmware] = useState('');
  const [reservedSerialPorts, setReservedSerialPorts] = useState<string[]>([]);
  const [serialReservationResults, setSerialReservationResults] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<TransferProgress>({ action: '', percent: 0, detail: '' });
  const [notices, setNotices] = useState<Notice[]>([]);
  const [identityEvents, setIdentityEvents] = useState<IdentityEvent[]>([]);
  const [identityResults, setIdentityResults] = useState<Partial<Record<IdentityTarget, IdentityResult>>>({});
  const [identityBusy, setIdentityBusy] = useState(false);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'state') setState(message.state);
      if (message.type === 'hidDevices') {
        const devices = message.devices;
        setHidDevices(devices);
        setHidDevicePath((current) => {
          if (!Array.isArray(devices) || devices.length === 0) return '';
          if (current && devices.some((item: HidDevice) => item.path === current)) return current;
          return devices[0].path;
        });
      }
      if (message.type === 'usbDfuDevices') {
        const devices = message.devices;
        setUsbDfuDevices(devices);
        setUsbDfuDeviceKey((current) => {
          if (!Array.isArray(devices) || devices.length === 0) return '';
          if (current && devices.some((item: UsbDfuDevice) => item.key === current)) return current;
          return devices[0].key;
        });
      }
      if (message.type === 'usbDfuFirmwareSelected') setUsbDfuFirmware(message.path);
      if (message.type === 'serialReservations') setReservedSerialPorts(message.paths);
      if (message.type === 'serialReservationResult') {
        setSerialReservationResults((current) => ({ ...current, [message.requestedPort]: message.reserved }));
      }
      if (message.type === 'progress') setProgress({ action: message.action, percent: message.percent, detail: message.detail });
      if (message.type === 'identityBusy') setIdentityBusy(message.busy);
      if (message.type === 'identityEvent') setIdentityEvents((items) => [message.event, ...items].slice(0, 120));
      if (message.type === 'identityResult') setIdentityResults((items) => ({ ...items, [message.result.target]: message.result }));
      if (message.type === 'notice') {
        setNotices((items) => [{ level: message.level, message: message.message, time: new Date().toLocaleTimeString() }, ...items].slice(0, 20));
      }
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);

  return <main>
    <nav>
      <Tab id="project" label="项目" icon="▤" active={page} set={setPage} />
      <Tab id="build" label="编译/烧录" icon="⚒" active={page} set={setPage} />
      <Tab id="dfu" label="USB/HID DFU" icon="⇄" active={page} set={setPage} />
      <Tab id="identity" label="身份认证" icon="◇" active={page} set={setPage} />
      <Tab id="tools" label="工具" icon="⚙" active={page} set={setPage} />
    </nav>

    <section className="content">
      {page === 'project' && <ProjectPage state={state} />}
      {page === 'build' && <div className="build-flash-grid">
        <BuildPage state={state} disabled={!state.projectPath} projectPath={state.projectPath} />
        <FlashPage state={state} reservedSerialPorts={reservedSerialPorts} progress={progress} />
      </div>}
      {page === 'dfu' && (
        <DfuPage
          state={state}
          usbDevices={usbDfuDevices}
          hidDevices={hidDevices}
          usbFirmware={usbDfuFirmware}
          progress={progress}
          usbDeviceKey={usbDfuDeviceKey}
          onUsbDeviceKeyChange={setUsbDfuDeviceKey}
          hidDevicePath={hidDevicePath}
          onHidDevicePathChange={setHidDevicePath}
        />
      )}
      {page === 'identity' && <IdentityPage state={state} busy={identityBusy} events={identityEvents} results={identityResults} reservationResults={serialReservationResults} clearEvents={() => setIdentityEvents([])} />}
      {page === 'tools' && <ToolsPage state={state} notices={notices} reservedSerialPorts={reservedSerialPorts} progress={progress} />}
    </section>
  </main>;
}

function Tab({ id, label, icon, active, set }: { id: Page; label: string; icon: string; active: Page; set: (value: Page) => void }): JSX.Element {
  return <button className={active === id ? 'active' : ''} onClick={() => set(id)}><span>{icon}</span>{label}</button>;
}

function ProjectPage({ state }: { state: State }): JSX.Element {
  return <div className="project-source-grid">
    <Card title="项目目录" subtitle="支持 ARIA workspace 与隔离 workspace track">
      <PathValue label="当前项目" value={state.projectPath} empty="未选择" />
      <div className="button-row">
        <button onClick={() => vscode.postMessage({ type: 'selectProject' })}>选择项目目录</button>
        <button className="danger-ghost" onClick={() => vscode.postMessage({ type: 'clearProjects' })}>清除全部记忆</button>
        <button className="secondary" onClick={() => vscode.postMessage({ type: 'openPanel' })}>编辑区显示</button>
      </div>
      {state.recentProjects.length > 0 && <div className="recent-list">
        <span className="eyebrow">最近项目</span>
        {state.recentProjects.map((item) => <div className="recent-item" key={item} title={item}>
          <button className="recent-select" onClick={() => vscode.postMessage({ type: 'selectRecentProject', path: item })}>
            <strong>{basename(item)}</strong><small>{item}</small>
          </button>
          <button
            className="recent-remove"
            title="清除此项目记忆"
            aria-label={`清除 ${basename(item)} 的项目记忆`}
            onClick={() => vscode.postMessage({ type: 'removeRecentProject', path: item })}
          >×</button>
        </div>)}
      </div>}
    </Card>
    <FirmwareCard state={state} />
  </div>;
}

function FirmwareCard({ state }: { state: State }): JSX.Element {
  return <Card title="固件来源" subtitle="未设置覆盖路径时，自动使用项目最新的 _firmware 目录">
    <div className="source-pill">{state.firmwareOverride ? '自定义' : '默认（自动）'}</div>
    <PathValue label={state.firmwareOverride ? '覆盖路径' : '默认固件目录'} value={state.firmwareOverride ?? state.defaultFirmwareDirectory} empty="构建后自动发现" />
    <div className="button-row wrap">
      <button className="secondary" onClick={() => vscode.postMessage({ type: 'scanFirmware' })}>扫描固件</button>
      <button className="secondary" onClick={() => vscode.postMessage({ type: 'selectFirmware' })}>选择固件</button>
      <button className="secondary" onClick={() => vscode.postMessage({ type: 'selectFirmwareDirectory' })}>选择目录</button>
      {state.firmwareOverride && <button className="ghost" onClick={() => vscode.postMessage({ type: 'clearFirmwareOverride' })}>恢复默认</button>}
    </div>
    {state.discoveredFirmware.length > 0 && <details><summary>已发现 {state.discoveredFirmware.length} 个固件</summary>
      <div className="file-list">{state.discoveredFirmware.map((file) => <code key={file.path} title={file.path}>{formatFirmwareOption(file)}</code>)}</div>
    </details>}
  </Card>;
}

function BuildPage({ state, disabled, projectPath }: { state: State; disabled: boolean; projectPath?: string }): JSX.Element {
  const [host, setHost] = useState('builder-ubuntu');
  const [download, setDownload] = useState('ota-fw');
  const [board, setBoard] = useState('');
  const [app, setApp] = useState('');
  const [dspOnly, setDspOnly] = useState(false);
  const [skipDsp, setSkipDsp] = useState(false);
  const [keep, setKeep] = useState(false);
  const [mapSummary, setMapSummary] = useState(false);
  const apps = state.buildOptions.map((item) => item.app);
  const boards = [...new Set(
    (state.buildOptions.find((item) => item.app === app)?.boards ?? state.buildOptions.flatMap((item) => item.boards))
  )].sort((left, right) => left.localeCompare(right, 'en'));
  useEffect(() => {
    if (!projectPath) {
      setApp('');
      setBoard('');
      return;
    }
    if (app && !apps.includes(app)) {
      setApp('');
    }
  }, [app, apps, projectPath]);
  useEffect(() => {
    if (!app) {
      setBoard('');
      return;
    }
    if (board && !boards.includes(board)) {
      setBoard('');
    }
  }, [app, board, boards]);
  const options = { buildHost: host, download, board, app, dspOnly, skipDsp, keep, mapSummary };
  return <Card title="固件编译" subtitle="默认在 builder-ubuntu 远程构建，避免本机 QEMU 慢编译">
    <Field label="构建主机"><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="builder-ubuntu" /></Field>
    <Field label="下载项"><select value={download} onChange={(e) => setDownload(e.target.value)}><option value="ota">ota</option><option value="ota-fw">ota-fw</option><option value="all">all</option></select></Field>
    <div className="build-option-stack">
      <EditableBuildOption label="Board（可选）" listId="build-board-options" value={board} set={setBoard} options={boards} placeholder="可选择或自行输入" />
      <EditableBuildOption label="App（可选）" listId="build-app-options" value={app} set={setApp} options={apps} placeholder="可选择或自行输入" />
    </div>
    <div className="checks">
      <Check label="仅 DSP" checked={dspOnly} set={(value) => { setDspOnly(value); if (value) setSkipDsp(false); }} />
      <Check label="跳过 DSP" checked={skipDsp} set={(value) => { setSkipDsp(value); if (value) setDspOnly(false); }} />
      <Check label="保留远端目录" checked={keep} set={setKeep} />
      <Check label="生成 Map 摘要" checked={mapSummary} set={setMapSummary} />
    </div>
    <div className="button-row"><button disabled={disabled} onClick={() => run('build', options)}>开始编译</button><button className="secondary" disabled={disabled} onClick={() => run('buildFlashVerify', options)}>编译 → 烧录 → 校验</button></div>
  </Card>;
}

function EditableBuildOption({ label, listId, value, set, options, placeholder }: {
  label: string;
  listId: string;
  value: string;
  set: (value: string) => void;
  options: string[];
  placeholder: string;
}): JSX.Element {
  return <Field label={label}>
    <div className="input-action build-option-control">
      <EditableChoice id={listId} value={value} set={set} options={options.map((option) => ({ value: option }))} placeholder={placeholder} />
      <button className="secondary" title={`重新扫描${label.split('（')[0]}`} onClick={() => vscode.postMessage({ type: 'scanBuildOptions' })}>扫描</button>
    </div>
  </Field>;
}

function FlashPage({
  state,
  reservedSerialPorts,
  progress
}: {
  state: State;
  reservedSerialPorts: string[];
  progress: TransferProgress;
}): JSX.Element {
  const [method, setMethod] = useState('ota-uart');
  const [entry, setEntry] = useState('power-cycle');
  const [verify, setVerify] = useState('boot');
  const [uart, setUart] = useState('');
  const [baud, setBaud] = useState('2000000');
  const [timeout, setTimeoutValue] = useState('');
  const [vidPid, setVidPid] = useState('10d6:10d6');
  const [dryRun, setDryRun] = useState(false);
  const [selectedFirmware, setSelectedFirmware] = useState('');
  const firmware = state.firmwareOverride ?? state.defaultFirmwareDirectory;
  const firmwareCandidates = useMemo(
    () => state.discoveredFirmware.filter((file) => /\.(bin|dfu|fw|img|hex)$/i.test(file.path)),
    [state.discoveredFirmware]
  );
  useFirmwareOverride(state.firmwareOverride, state.discoveredFirmware, setSelectedFirmware);
  useEffect(() => {
    if (selectedFirmware && !state.discoveredFirmware.some((file) => file.path === selectedFirmware)) {
      setSelectedFirmware('');
    }
    if (!selectedFirmware && firmwareCandidates.length > 0) {
      setSelectedFirmware(firmwareCandidates[0].path);
    }
  }, [state.discoveredFirmware, selectedFirmware, firmwareCandidates]);
  const busy = state.busy === 'flash';
  const flashProgress = progress.action === 'flash' ? progress : { action: '', percent: 0, detail: '' };
  return <Card title="串口固件烧录">
      <Field label="烧录固件"><div className="input-action"><PlaceholderSelect value={selectedFirmware} onChange={(event) => setSelectedFirmware(event.target.value)}><option value="">空白-选项</option>{state.discoveredFirmware.map((file) => <option key={file.path} value={file.path} title={file.path}>{formatFirmwareOption(file)}</option>)}</PlaceholderSelect><div className="inline-actions"><button className="secondary" onClick={() => vscode.postMessage({ type: 'scanFirmware' })}>扫描</button><button className="secondary" onClick={() => vscode.postMessage({ type: 'selectFirmware' })}>选择固件</button></div></div></Field>
      <Field label="烧录方式"><select value={method} onChange={(e) => setMethod(e.target.value)}>
        <option value="ota-uart">UART OTA (.bin)</option><option value="fw-uart">UART ADFU (.fw)</option>
      </select></Field>
      <div className="columns"><Field label="进入方式"><select value={entry} onChange={(e) => setEntry(e.target.value)}><option value="power-cycle">power-cycle</option><option value="manual">manual</option><option value="shell">shell</option></select></Field><Field label="烧录后校验"><select value={verify} onChange={(e) => setVerify(e.target.value)}><option value="boot">boot</option><option value="enum">enum</option><option value="none">none</option></select></Field></div>
      <div className="columns flash-serial-fields"><Field label="UART 串口"><SerialPortControl value={uart} set={setUart} ports={state.serialPorts} reserved={reservedSerialPorts.includes(uart)} /></Field><Field label="波特率"><BaudSelect value={baud} set={setBaud} /></Field></div>
      <div className="columns"><Field label="超时秒数"><input value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} /></Field><Field label="ADFU VID:PID"><input value={vidPid} onChange={(e) => setVidPid(e.target.value)} /></Field></div>
      <Check label="仅预演，不写设备" checked={dryRun} set={setDryRun} />
      {(busy || flashProgress.detail) && <TransferProgressBar progress={flashProgress} />}
      <button disabled={busy || !state.projectPath || !selectedFirmware} onClick={() => run('flash', { firmware: selectedFirmware, method, entry, verify, uart, baud, timeout, vidPid, dryRun })}>开始烧录</button>
      <div className="flash-firmware-source"><PathValue label="当前固件来源" value={firmware} empty="未发现固件" /></div>
  </Card>;
}

function UsbDfuPage({ state, devices, hidDevices, selectedFirmware, selectedDeviceKey, onDeviceKeyChange, progress }: { state: State; devices: UsbDfuDevice[]; hidDevices: HidDevice[]; selectedFirmware: string; selectedDeviceKey: string; onDeviceKeyChange: (value: string) => void; progress: TransferProgress }): JSX.Element {
  const candidates = useMemo(
    () => {
      const firmwareFiles = state.discoveredFirmware
        .map((file) => file.path)
        .filter((file) => /\.(bin|dfu)$/i.test(file));
      const values = [selectedFirmware, ...firmwareFiles].filter((file) => file && /\.(bin|dfu)$/i.test(file));
      return [...new Set(values)];
    },
    [selectedFirmware, state.discoveredFirmware]
  );
  const [firmware, setFirmware] = useState('');
  const [reset, setReset] = useState(false);
  useEffect(() => {
    if (selectedFirmware) setFirmware(selectedFirmware);
  }, [selectedFirmware]);
  useEffect(() => {
    if (firmware && !candidates.includes(firmware)) {
      setFirmware('');
    }
    if (!firmware && candidates.length > 0) {
      setFirmware(candidates[0]);
    }
  }, [candidates, firmware]);
  useEffect(() => {
    if (!Array.isArray(devices) || devices.length === 0) {
      onDeviceKeyChange('');
      return;
    }
    if (!selectedDeviceKey || !devices.some((item) => item.key === selectedDeviceKey)) {
      onDeviceKeyChange(devices[0].key);
    }
  }, [devices, selectedDeviceKey, onDeviceKeyChange]);
  const device = devices.find((item) => item.key === selectedDeviceKey);
  const hidDevice = device ? findCompanionDevice(device, hidDevices) : undefined;
  const deviceLabel = device ? usbDfuDeviceLabel(device, hidDevice) : undefined;
  const busy = state.busy === 'usbDfu';
  const hasFirmware = Boolean(firmware);
  const usbProgress = progress.action === 'usbDfu' ? progress : { action: '', percent: 0, detail: '' };

  return <Card
    title="USB DFU"
    subtitle="无需选择项目，可直接扫描设备并选择任意 .bin/.dfu 固件"
    headerAside={device && <DeviceSummary
      manufacturer={device.manufacturer ?? hidDevice?.manufacturer}
      product={device.product ?? hidDevice?.product}
      vendorId={device.vendorId}
      productId={device.productId}
      serialNumber={device.serialNumber ?? hidDevice?.serialNumber}
      version={device.version}
      dfuName={device.dfuName}
    />}
  >
    <div className="callout">只显示同时枚举 USB Audio Class 与标准 DFU Runtime 接口的设备；传输时按 VID:PID 和 USB 物理路径锁定所选设备。单独选择的固件仅供本页面使用，不会改变其他功能的固件来源。</div>
    <div className="button-row"><button className="secondary" disabled={busy} onClick={scanDfuDevices}>扫描 UAC 设备</button><span className="muted">发现 {devices.length} 个可用设备</span></div>
    <Field label="UAC 设备"><PlaceholderSelect disabled={busy} value={selectedDeviceKey} selectedLabel={deviceLabel} preferTail={false} onChange={(event) => onDeviceKeyChange(event.target.value)}><option value="">空白-选项</option>{devices.map((item) => {
      const companion = findCompanionDevice(item, hidDevices);
      return <option key={item.key} value={item.key}>{usbDfuDeviceLabel(item, companion)}</option>;
    })}</PlaceholderSelect></Field>
    {device && <div className="device-meta"><code>USB 路径 {device.usbPath}</code></div>}
    <Field label="DFU 固件"><div className="input-action"><PlaceholderSelect disabled={busy} value={firmware} onChange={(event) => setFirmware(event.target.value)}><option value="">空白-选项</option>{state.discoveredFirmware.filter((file) => /\.(bin|dfu)$/i.test(file.path)).map((file) => <option key={file.path} value={file.path} title={file.path}>{formatFirmwareOption(file)}</option>)}</PlaceholderSelect><div className="inline-actions"><button className="secondary" disabled={busy} onClick={() => vscode.postMessage({ type: 'scanFirmware' })}>扫描</button><button className="secondary" disabled={busy} onClick={() => vscode.postMessage({ type: 'selectUsbDfuFirmware' })}>选择固件</button></div></div></Field>
    <Check label="传输完成后请求 USB 复位" checked={reset} set={setReset} />
    {(busy || usbProgress.detail) && <TransferProgressBar progress={usbProgress} />}
    <div className="button-row"><button disabled={busy || !device || !hasFirmware} onClick={() => device && vscode.postMessage({ type: 'usbDfu', device, firmware, reset })}>开始 USB DFU</button>{busy && <button className="danger" onClick={() => vscode.postMessage({ type: 'usbDfuAbort' })}>取消</button>}</div>
  </Card>;
}

function DfuPage({ state, usbDevices, hidDevices, usbFirmware, progress, usbDeviceKey, onUsbDeviceKeyChange, hidDevicePath, onHidDevicePathChange }: {
  state: State;
  usbDevices: UsbDfuDevice[];
  hidDevices: HidDevice[];
  usbFirmware: string;
  progress: TransferProgress;
  usbDeviceKey: string;
  onUsbDeviceKeyChange: (value: string) => void;
  hidDevicePath: string;
  onHidDevicePathChange: (value: string) => void;
}): JSX.Element {
  return <div className="dfu-stack">
    <UsbDfuPage
      state={state}
      devices={usbDevices}
      hidDevices={hidDevices}
      selectedFirmware={usbFirmware}
      selectedDeviceKey={usbDeviceKey}
      onDeviceKeyChange={onUsbDeviceKeyChange}
      progress={progress}
    />
    <HidPage
      state={state}
      devices={hidDevices}
      usbDevices={usbDevices}
      selectedDevicePath={hidDevicePath}
      onDevicePathChange={onHidDevicePathChange}
      progress={progress}
    />
  </div>;
}

function HidPage({ state, devices, usbDevices, progress, selectedDevicePath, onDevicePathChange }: { state: State; devices: HidDevice[]; usbDevices: UsbDfuDevice[]; progress: TransferProgress; selectedDevicePath: string; onDevicePathChange: (value: string) => void }): JSX.Element {
  const [firmware, setFirmware] = useState('');
  const firmwareCandidates = useMemo(
    () => state.discoveredFirmware.filter((file) => /\.bin$/i.test(file.path)),
    [state.discoveredFirmware]
  );
  useEffect(() => {
    if (!Array.isArray(devices) || devices.length === 0) {
      onDevicePathChange('');
      return;
    }
    if (!selectedDevicePath || !devices.some((device) => device.path === selectedDevicePath)) {
      onDevicePathChange(devices[0].path);
    }
  }, [devices, selectedDevicePath, onDevicePathChange]);
  useFirmwareOverride(
    state.firmwareOverride && /\.bin$/i.test(state.firmwareOverride) ? state.firmwareOverride : undefined,
    state.discoveredFirmware,
    setFirmware
  );
  const device = devices.find((item) => item.path === selectedDevicePath);
  const usbDevice = device ? findCompanionDevice(device, usbDevices) : undefined;
  const deviceLabel = device ? hidDfuDeviceLabel(device, usbDevice) : undefined;
  const busy = state.busy === 'hidDfu';
  const hidProgress = progress.action === 'hidDfu' ? progress : { action: '', percent: 0, detail: '' };
  useEffect(() => {
    if (firmware && !firmwareCandidates.some((file) => file.path === firmware)) {
      setFirmware('');
    }
    if (!firmware && firmwareCandidates.length > 0) {
      setFirmware(firmwareCandidates[0].path);
    }
  }, [firmware, firmwareCandidates]);
  return <Card
    title="HID DFU"
    subtitle="通过 DSPTuner v2 HID 协议传输 OTA .bin；每帧 CRC16，整包 CRC32"
    headerAside={device && <DeviceSummary
      manufacturer={device.manufacturer ?? usbDevice?.manufacturer}
      product={device.product ?? usbDevice?.product}
      vendorId={device.vendorId}
      productId={device.productId}
      serialNumber={device.serialNumber ?? usbDevice?.serialNumber}
      version={usbDevice?.version}
      dfuName={usbDevice?.dfuName}
    />}
  >
    <div className="callout">HID DFU 不进入 ADFU 模式。设备必须已枚举普通 HID 接口，固件上需启用 HID 更新模块。</div>
    <div className="button-row"><button className="secondary" disabled={busy} onClick={scanDfuDevices}>扫描 UAC HID</button><span className="muted">发现 {devices.length} 个 UAC 厂商 HID 接口</span></div>
    <Field label="HID 设备"><PlaceholderSelect disabled={busy} value={selectedDevicePath} selectedLabel={deviceLabel} preferTail={false} onChange={(e) => onDevicePathChange(e.target.value)}><option value="">空白-选项</option>{devices.map((item) => {
      const companion = findCompanionDevice(item, usbDevices);
      return <option key={item.path} value={item.path}>{hidDfuDeviceLabel(item, companion)}</option>;
    })}</PlaceholderSelect></Field>
    <Field label="OTA .bin 固件"><div className="input-action"><PlaceholderSelect value={firmware} onChange={(e) => setFirmware(e.target.value)}><option value="">空白-选项</option>{firmwareCandidates.map((file) => <option key={file.path} value={file.path} title={file.path}>{formatFirmwareOption(file)}</option>)}</PlaceholderSelect><div className="inline-actions"><button className="secondary" disabled={busy} onClick={() => vscode.postMessage({ type: 'scanFirmware' })}>扫描</button><button className="secondary" disabled={busy} onClick={() => vscode.postMessage({ type: 'selectHidFirmware' })}>选择固件</button></div></div></Field>
    {(busy || hidProgress.detail) && <TransferProgressBar progress={hidProgress} />}
    <div className="button-row"><button disabled={busy || !selectedDevicePath || !firmware} onClick={() => vscode.postMessage({ type: 'hidDfu', path: selectedDevicePath, firmware, expectedBcd: 0 })}>开始 HID DFU</button>{busy && <button className="danger" onClick={() => vscode.postMessage({ type: 'hidAbort', path: selectedDevicePath })}>取消</button>}</div>
  </Card>;
}

const defaultIdentityCommands: IdentityCommands = {
  algorithmStatus: 'auth_mode get_auth_flag',
  algorithmInfo: 'auth_mode get_id',
  algorithmWrite: 'auth_mode set_key {key}',
  algorithmClear: 'auth_mode set_key {zeroKey}',
  snStatus: 'device_id sn status',
  snInfo: 'device_id info',
  snWrite: 'device_id sn write {key} --force',
  snClear: 'device_id sn write {zeroKey} --force',
  reboot: 'dbg reboot'
};

interface SavedIdentitySettings {
  port?: string;
  baudRate?: string;
  commands?: IdentityCommands;
  customCommand?: string;
  rebootAfterWrite?: boolean;
}

function IdentityPage({
  state,
  busy,
  events,
  results,
  reservationResults,
  clearEvents
}: {
  state: State;
  busy: boolean;
  events: IdentityEvent[];
  results: Partial<Record<IdentityTarget, IdentityResult>>;
  reservationResults: Record<string, boolean>;
  clearEvents: () => void;
}): JSX.Element {
  const persisted = (vscode.getState()?.identity ?? {}) as SavedIdentitySettings;
  const [port, setPort] = useState(persisted.port ?? '');
  const [baudRate, setBaudRate] = useState(persisted.baudRate ?? '3000000');
  const [username, setUsername] = useState(identityCredentialSession.username);
  const [password, setPassword] = useState(identityCredentialSession.password);
  const [showPassword, setShowPassword] = useState(false);
  const [rebootAfterWrite, setRebootAfterWrite] = useState(persisted.rebootAfterWrite ?? true);
  const [keepPortReserved, setKeepPortReserved] = useState(false);
  const [commands, setCommands] = useState<IdentityCommands>(persisted.commands ?? defaultIdentityCommands);
  const [customCommand, setCustomCommand] = useState(persisted.customCommand ?? 'device_id info');

  useEffect(() => {
    const existing = vscode.getState() ?? {};
    vscode.setState({
      ...existing,
      identity: { port, baudRate, commands, customCommand, rebootAfterWrite }
    });
  }, [port, baudRate, commands, customCommand, rebootAfterWrite]);

  useEffect(() => {
    identityCredentialSession.username = username;
    identityCredentialSession.password = password;
  }, [username, password]);

  useEffect(() => {
    if (reservationResults[port] !== undefined) setKeepPortReserved(reservationResults[port]);
  }, [port, reservationResults]);

  const execute = (action: IdentityAction): void => {
    vscode.postMessage({
      type: 'identityAction',
      request: {
        action,
        port,
        baudRate: Number(baudRate),
        username,
        password,
        rebootAfterWrite,
        keepPortReserved,
        commands,
        customCommand
      }
    });
  };
  const setCommand = (key: keyof IdentityCommands, value: string): void => {
    setCommands((current) => ({ ...current, [key]: value }));
  };
  const inspectIdentityPort = (candidate = port): void => {
    if (!candidate.trim()) return;
    vscode.postMessage(keepPortReserved
      ? { type: 'setSerialPortReservation', port: candidate, reserved: true }
      : { type: 'checkSerialPort', port: candidate });
  };
  const updatePortReservation = (reserved: boolean): void => {
    setKeepPortReserved(reserved);
    vscode.postMessage({ type: 'setSerialPortReservation', port, reserved });
  };
  const updateIdentityPort = (next: string): void => {
    if (keepPortReserved && port.trim() && next !== port) {
      vscode.postMessage({ type: 'setSerialPortReservation', port, reserved: false });
      setKeepPortReserved(false);
    }
    setPort(next);
  };

  return <>
    <div className="identity-wide">
      <Card title="身份认证连接" subtitle="串口号可输入 891 这类尾号，也可扫描并选择完整路径；授权通信默认使用 3M baud">
        <div className="identity-connection-grid">
          <div className="identity-connection-group">
            <span className="eyebrow">设备连接</span>
            <div className="identity-connect-fields">
              <Field label="串口号或完整路径">
                <div className="serial-port-control">
                  <div className="input-action">
                    <EditableChoice
                      id="identity-serial-ports"
                      value={port}
                      set={updateIdentityPort}
                      options={state.serialPorts.map((item) => ({ value: item.path, label: `${tailName(item.path)}${item.manufacturer ? ` · ${item.manufacturer}` : ''}` }))}
                      placeholder="例如 891 或 /dev/cu.usbmodem…"
                      disabled={busy}
                      onCommit={inspectIdentityPort}
                    />
                    <button className="secondary" disabled={busy} onClick={() => vscode.postMessage({ type: 'listSerial' })}>扫描</button>
                  </div>
                  <Check label="持续占用串口" checked={keepPortReserved} set={updatePortReservation} disabled={!port.trim()} />
                </div>
              </Field>
              <Field label="通信波特率"><BaudSelect value={baudRate} set={setBaudRate} /></Field>
            </div>
          </div>
          <div className="identity-connection-group">
            <span className="eyebrow">授权凭据</span>
            <div className="identity-account-fields">
              <Field label="授权账号"><input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} /></Field>
              <Field label="授权密码">
                <div className="field-option-control">
                  <input type={showPassword ? 'text' : 'password'} value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
                  <Check label="显示密码" checked={showPassword} set={setShowPassword} />
                </div>
              </Field>
            </div>
          </div>
        </div>
        <div className="button-row identity-connection-actions">
          <Check label="写入或清除后重启并复核" checked={rebootAfterWrite} set={setRebootAfterWrite} />
          {busy && <button className="danger" onClick={() => vscode.postMessage({ type: 'identityCancel' })}>取消当前流程</button>}
        </div>
      </Card>
    </div>

    <div className="identity-wide identity-auth-grid">
      <IdentityAuthCard
        title="算法身份授权"
        subtitle="使用 auth_mode 协议；授权、状态检查和清除均独立执行"
        status={results.algorithm}
        busy={busy}
        onCheck={() => execute('checkAlgorithm')}
        onAuthorize={() => execute('authorizeAlgorithm')}
        onClear={() => execute('clearAlgorithm')}
      />

      <IdentityAuthCard
        title="SN 身份授权"
        subtitle="使用 device_id 协议；完整保留产品名中的空格"
        status={results.sn}
        busy={busy}
        onCheck={() => execute('checkSn')}
        onAuthorize={() => execute('authorizeSn')}
        onClear={() => execute('clearSn')}
      />
    </div>

    <Card title="授权命令配置" subtitle="可在默认命令基础上修改；{key} 为服务端授权数据，{zeroKey} 为清除载荷">
      <details className="command-settings">
        <summary>展开 9 条命令模板</summary>
        <div className="command-grid">
          <CommandField label="算法状态" value={commands.algorithmStatus} set={(value) => setCommand('algorithmStatus', value)} />
          <CommandField label="算法信息" value={commands.algorithmInfo} set={(value) => setCommand('algorithmInfo', value)} />
          <CommandField label="算法写入" value={commands.algorithmWrite} set={(value) => setCommand('algorithmWrite', value)} />
          <CommandField label="算法清除" value={commands.algorithmClear} set={(value) => setCommand('algorithmClear', value)} />
          <CommandField label="SN 状态" value={commands.snStatus} set={(value) => setCommand('snStatus', value)} />
          <CommandField label="SN 信息" value={commands.snInfo} set={(value) => setCommand('snInfo', value)} />
          <CommandField label="SN 写入" value={commands.snWrite} set={(value) => setCommand('snWrite', value)} />
          <CommandField label="SN 清除" value={commands.snClear} set={(value) => setCommand('snClear', value)} />
          <CommandField label="设备重启" value={commands.reboot} set={(value) => setCommand('reboot', value)} />
        </div>
        <button className="ghost" disabled={busy} onClick={() => setCommands(defaultIdentityCommands)}>恢复默认命令</button>
      </details>
    </Card>

    <Card title="设备命令与状态信息" subtitle="用于读取额外状态或执行其他单条 Shell 命令">
      <Field label="Shell 命令">
        <div className="input-action identity-custom-command">
          <input list="identity-command-presets" value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} />
          <datalist id="identity-command-presets">
            {['device_id info', 'device_id sn status', 'device_id sn verify', 'auth_mode get_id', 'auth_mode get_auth_flag', 'kernel version', 'help'].map((command) => <option key={command} value={command} />)}
          </datalist>
          <button className="secondary" disabled={busy || !port || !customCommand.trim()} onClick={() => execute('runCustom')}>执行</button>
        </div>
      </Field>
      {results.system?.fields?.response && <pre className="identity-output">{results.system.fields.response}</pre>}
    </Card>

    <div className="identity-wide">
      <Card title="认证流程" subtitle="最新记录显示在最上方；授权数据、令牌和密码自动隐藏">
        <div className="button-row identity-flow-actions"><span className="muted">共 {events.length} 条记录</span><button className="ghost" disabled={busy || events.length === 0} onClick={clearEvents}>清空记录</button></div>
        {events.length === 0 ? <p className="muted">选择一个授权操作后，这里会按顺序显示连接、读取、服务请求、写入和复核结果。</p> : <div className="identity-timeline">
          {events.map((event) => <div key={event.id} className={`identity-step ${event.level}`}>
            <span className="identity-step-dot" />
            <div><div className="identity-step-head"><strong>{event.title}</strong><time>{event.timestamp}</time></div>{event.detail && <p>{event.detail}</p>}{event.raw && <pre>{event.raw}</pre>}</div>
          </div>)}
        </div>}
      </Card>
    </div>
  </>;
}

function IdentityAuthCard({ title, subtitle, status, busy, onCheck, onAuthorize, onClear }: {
  title: string;
  subtitle: string;
  status?: IdentityResult;
  busy: boolean;
  onCheck: () => void;
  onAuthorize: () => void;
  onClear: () => void;
}): JSX.Element {
  return <Card title={title} subtitle={subtitle}>
    <div className="identity-status-row">
      <IdentityStatusBadge status={status?.status ?? 'unknown'} />
      <span>{status?.summary ?? '尚未检查设备状态'}</span>
    </div>
    {status?.fields && <div className="device-meta">{Object.entries(status.fields).map(([key, value]) => <code key={key}>{key}={value}</code>)}</div>}
    <div className="button-row wrap identity-auth-actions">
      <button className="secondary" disabled={busy} onClick={onCheck}>检查状态</button>
      <button disabled={busy} onClick={onAuthorize}>开始授权</button>
      <button className="danger-ghost" disabled={busy} onClick={onClear}>清除授权</button>
    </div>
  </Card>;
}

function IdentityStatusBadge({ status }: { status: IdentityStatus }): JSX.Element {
  const labels: Record<IdentityStatus, string> = {
    authorized: '授权正常',
    unauthorized: '未授权',
    unknown: '待检查',
    running: '处理中',
    error: '异常'
  };
  return <span className={`identity-status ${status}`}>{labels[status]}</span>;
}

function CommandField({ label, value, set }: { label: string; value: string; set: (value: string) => void }): JSX.Element {
  return <Field label={label}><input spellCheck={false} value={value} onChange={(event) => set(event.target.value)} /></Field>;
}

function ToolsPage({ state, notices, reservedSerialPorts, progress }: { state: State; notices: Notice[]; reservedSerialPorts: string[]; progress: TransferProgress }): JSX.Element {
  const [entry, setEntry] = useState('shell');
  const [size, setSize] = useState('8388608');
  const [timeout, setTimeoutValue] = useState('120');
  const [vidPid, setVidPid] = useState('10d6:10d6');
  const [shellPort, setShellPort] = useState('');
  const [shellBaud, setShellBaud] = useState('3000000');
  const [shellCmd, setShellCmd] = useState('dbg reboot adfu');
  const [dryRun, setDryRun] = useState(false);
  const busy = Boolean(state.busy);
  const eraseProgress = progress.action === 'erase' ? progress : { action: '', percent: 0, detail: '' };
  return <>
    <Card title="工具状态" subtitle="插件调用现有 Baton / Actions Flash，并内置 HID 传输层">
      <div className="tool-grid">{state.tools.map((tool) => <div className="tool" key={tool.name}>
        <span className={`dot ${tool.available ? 'ok' : 'bad'}`} />
        <div><strong>{tool.label}</strong><small>{tool.detail}</small></div>
      </div>)}</div>
    </Card>
    <Card title="诊断与设备工具" subtitle="常用 Baton / Actions Flash 操作">
      <div className="action-grid">
        <button disabled={!state.projectPath} onClick={() => run('verify', {})}>校验启动</button>
        <button className="secondary" disabled={!state.projectPath} onClick={() => run('doctor', {})}>环境诊断</button>
        <button className="secondary" disabled={!state.projectPath} onClick={() => run('discover', {})}>发现设备</button>
        <button className="secondary" disabled={!state.projectPath} onClick={() => run('status', {})}>项目状态</button>
        <button className="secondary" disabled={!state.projectPath} onClick={() => run('listAdfu', {})}>列出 ADFU</button>
        <button className="secondary" disabled={!state.projectPath} onClick={() => run('extractFw', {})}>解包 .fw</button>
      </div>
    </Card>
    <Card title="全擦除 Flash" subtitle="危险操作：执行前插件会再次弹窗确认">
      <div className="columns"><Field label="进入方式"><select value={entry} onChange={(e) => setEntry(e.target.value)}><option value="manual">manual</option><option value="shell">shell</option></select></Field><Field label="擦除大小（字节）"><input value={size} onChange={(e) => setSize(e.target.value)} /></Field></div>
      <div className="columns"><Field label="超时秒数"><input value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} /></Field><Field label="ADFU VID:PID"><input value={vidPid} onChange={(e) => setVidPid(e.target.value)} /></Field></div>
      {entry === 'shell' && <><Field label="Shell UART"><SerialPortControl value={shellPort} set={setShellPort} ports={state.serialPorts} emptyLabel="使用设备配置" reserved={reservedSerialPorts.includes(shellPort)} /></Field><div className="columns"><Field label="Shell 波特率"><BaudSelect value={shellBaud} set={setShellBaud} /></Field><Field label="重启命令"><input value={shellCmd} onChange={(e) => setShellCmd(e.target.value)} /></Field></div></>}
      <Check label="仅预演，不擦除" checked={dryRun} set={setDryRun} />
      {(busy || eraseProgress.detail) && <TransferProgressBar progress={eraseProgress} />}
      <button className="danger" disabled={!state.projectPath || busy} onClick={() => run('erase', { entry, size, timeout, vidPid, shellPort: entry === 'shell' ? shellPort : '', shellBaud: entry === 'shell' ? shellBaud : '', shellCmd: entry === 'shell' ? shellCmd : '', dryRun })}>{dryRun ? '预演全擦除' : '全擦除 Flash'}</button>
    </Card>
    <Card title="操作记录" subtitle="完整命令输出位于 ATS362X 集成终端">
      {notices.length === 0 ? <p className="muted">暂无操作</p> : <div className="logs">{notices.map((notice, index) => <div key={`${notice.time}-${index}`} className={notice.level}><time>{notice.time}</time><span>{notice.message}</span></div>)}</div>}
    </Card>
  </>;
}

function Card({ title, subtitle, headerAside, children }: React.PropsWithChildren<{ title: string; subtitle?: string; headerAside?: React.ReactNode }>): JSX.Element {
  return <article className="card"><div className="card-head"><div className="card-title"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{headerAside}</div>{children}</article>;
}
function DeviceSummary({ manufacturer, product, vendorId, productId, serialNumber, version, dfuName }: {
  manufacturer?: string;
  product?: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
  version?: string;
  dfuName?: string;
}): JSX.Element {
  const items = [
    ['厂商', manufacturer],
    ['设备', product],
    ['VID/PID', `0x${hex(vendorId)} / 0x${hex(productId)}`],
    ['SN', serialNumber],
    ['版本', version],
    ['DFU 字符串', dfuName]
  ].filter((item): item is [string, string] => Boolean(item[1]?.trim()));
  return <dl className="device-summary">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>;
}
function EditableChoice({ id, value, set, options, placeholder, disabled = false, onCommit }: {
  id: string;
  value: string;
  set: (value: string) => void;
  options: EditableChoiceOption[];
  placeholder: string;
  disabled?: boolean;
  onCommit?: (value: string) => void;
}): JSX.Element {
  const customOption = '__manual_input__';
  const selectedChoice = options.find((option) => option.value === value);
  const listed = selectedChoice !== undefined;
  const [manual, setManual] = useState(Boolean(value && !listed));
  useEffect(() => {
    if (value && options.some((option) => option.value === value)) setManual(false);
  }, [options, value]);
  const customValue = Boolean(value && !options.some((option) => option.value === value));
  if (manual) {
    return <input
      id={id}
      className="editable-choice-manual"
      disabled={disabled}
      value={value}
      placeholder="请输入…"
      autoFocus
      title={placeholder}
      onChange={(event) => set(event.target.value)}
      onBlur={() => {
        setManual(false);
        if (value) onCommit?.(value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
      }}
    />;
  }
  return <div className="editable-choice">
    <PlaceholderSelect
      id={id}
      disabled={disabled}
      value={value}
      selectedLabel={selectedChoice?.label ?? selectedChoice?.value ?? value}
      onChange={(event) => {
        const next = event.target.value;
        if (next === customOption) {
          setManual(true);
          if (!customValue) set('');
          return;
        }
        setManual(false);
        set(next);
        if (next) onCommit?.(next);
      }}
    >
      <option value="">空白-选项</option>
      {customValue && <option value={value}>{value}</option>}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label ?? option.value}</option>)}
      <option value={customOption}>自行输入…</option>
    </PlaceholderSelect>
  </div>;
}
function PlaceholderSelect({ value, placeholder = '未选择，请提供选择项', selectedLabel, preferTail = true, children, ...props }:
  React.PropsWithChildren<Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value'> & { value: string; placeholder?: string; selectedLabel?: string; preferTail?: boolean }>): JSX.Element {
  const visibleLabel = value ? selectedLabel ?? selectedOptionLabel(children, value) : placeholder;
  return <div className="select-placeholder">
    <select {...props} value={value} className={!value ? 'select-empty' : undefined}>{children}</select>
    <TailAwareSelectText text={visibleLabel} revealTail={Boolean(value) && preferTail} />
  </div>;
}
function TailAwareSelectText({ text, revealTail }: { text: string; revealTail: boolean }): JSX.Element {
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const update = (): void => {
      if (viewport.current && content.current) {
        setOverflowing(revealTail && content.current.scrollWidth > viewport.current.clientWidth);
      }
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [text, revealTail]);
  return <span ref={viewport} className={`select-display ${overflowing ? 'show-tail' : ''}`} aria-hidden="true"><span ref={content}>{text}</span></span>;
}
function selectedOptionLabel(children: React.ReactNode, value: string): string {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement<{ value?: string; children?: React.ReactNode }>(child) || String(child.props.value ?? '') !== value) continue;
    const label = child.props.children;
    if (typeof label === 'string' || typeof label === 'number') return String(label);
  }
  return value;
}
function Field({ label, children }: React.PropsWithChildren<{ label: string }>): JSX.Element { return <label className="field"><span>{label}</span>{children}</label>; }
function Check({ label, checked, set, disabled = false }: { label: string; checked: boolean; set: (value: boolean) => void; disabled?: boolean }): JSX.Element { return <label className={`check ${disabled ? 'disabled' : ''}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => set(e.target.checked)} /><span>{label}</span></label>; }
function TransferProgressBar({ progress }: { progress: Pick<TransferProgress, 'percent' | 'detail'> }): JSX.Element { return <div className="progress"><div><span style={{ width: `${progress.percent}%` }} /></div><small>{progress.percent}% · {progress.detail || '等待传输进度'}</small></div>; }
function useFirmwareOverride(override: string | undefined, candidates: FirmwareChoice[], setSelected: (value: string) => void): void {
  const lastApplied = useRef<string | undefined>();
  useEffect(() => {
    if (override === lastApplied.current) return;
    lastApplied.current = override;
    if (override && candidates.some((candidate) => candidate.path === override)) setSelected(override);
  }, [override, candidates, setSelected]);
}
function formatFirmwareOption(file: FirmwareChoice): string {
  const timestamp = formatFirmwareTime(file.modified);
  return timestamp ? `${tailName(file.path)} (${timestamp})` : tailName(file.path);
}
function formatFirmwareTime(modified: number): string {
  const timestamp = new Date(modified);
  if (Number.isNaN(timestamp.getTime())) {
    return '';
  }
  const month = `${timestamp.getMonth() + 1}`.padStart(2, '0');
  const day = `${timestamp.getDate()}`.padStart(2, '0');
  const hour = `${timestamp.getHours()}`.padStart(2, '0');
  const minute = `${timestamp.getMinutes()}`.padStart(2, '0');
  return `${month}${day}-${hour}:${minute}`;
}
function BaudSelect({ value, set }: { value: string; set: (value: string) => void }): JSX.Element { return <select value={value} onChange={(event) => set(event.target.value)}>{['460800', '921600', '1000000', '2000000', '3000000'].map((rate) => <option key={rate} value={rate}>{Number(rate).toLocaleString()}</option>)}</select>; }
function SerialPortSelect({ value, set, ports, emptyLabel = '未选择，请提供选择项' }: { value: string; set: (value: string) => void; ports: SerialPortInfo[]; emptyLabel?: string }): JSX.Element {
  const selectedMissing = value.length > 0 && !ports.some((port) => port.path === value);
  return <PlaceholderSelect value={value} placeholder={emptyLabel} onChange={(event) => set(event.target.value)}><option value="">空白-选项</option>{selectedMissing && <option value={value} title={value}>{tailName(value)}</option>}{ports.map((port) => <option key={port.path} value={port.path} title={port.path}>{tailName(port.path)}</option>)}</PlaceholderSelect>;
}
function SerialPortControl({ value, set, ports, emptyLabel, reserved }: { value: string; set: (value: string) => void; ports: SerialPortInfo[]; emptyLabel?: string; reserved: boolean }): JSX.Element {
  const select = (next: string): void => {
    if (reserved && value) vscode.postMessage({ type: 'setSerialPortReservation', port: value, reserved: false });
    set(next);
    checkSerialPort(next);
  };
  const setReserved = (next: boolean): void => {
    if (value) vscode.postMessage({ type: 'setSerialPortReservation', port: value, reserved: next });
  };
  return <div className="serial-port-control">
    <div className="input-action"><SerialPortSelect value={value} set={select} ports={ports} emptyLabel={emptyLabel} /><button className="secondary" title="重新扫描串口" onClick={() => vscode.postMessage({ type: 'listSerial' })}>扫描</button></div>
    <Check label="持续占用串口" checked={reserved} set={setReserved} disabled={!value} />
  </div>;
}
function PathValue({ label, value, empty }: { label: string; value?: string; empty: string }): JSX.Element { return <div className="path-value"><span>{label}</span><code title={value}>{value ?? empty}</code></div>; }
function run(action: string, options: Record<string, string | boolean>): void { vscode.postMessage({ type: 'run', request: { action, options } }); }
function checkSerialPort(port: string): void { if (port.trim()) vscode.postMessage({ type: 'checkSerialPort', port }); }
function scanDfuDevices(): void {
  vscode.postMessage({ type: 'listUsbDfu' });
  vscode.postMessage({ type: 'listHid' });
}
function findCompanionDevice<T extends { vendorId: number; productId: number; serialNumber?: string }>(source: { vendorId: number; productId: number; serialNumber?: string }, candidates: T[]): T | undefined {
  const matches = candidates.filter((item) => item.vendorId === source.vendorId && item.productId === source.productId);
  if (source.serialNumber) {
    const exact = matches.find((item) => item.serialNumber === source.serialNumber);
    if (exact) return exact;
  }
  return matches.length === 1 ? matches[0] : undefined;
}
function usbDfuDeviceLabel(device: UsbDfuDevice, companion?: HidDevice): string {
  return formatDfuDeviceLabel(
    device.manufacturer ?? companion?.manufacturer,
    device.product ?? companion?.product,
    device.vendorId,
    device.productId,
    device.serialNumber ?? companion?.serialNumber,
    device.dfuName ?? `USB ${device.usbPath}`
  );
}
function hidDfuDeviceLabel(device: HidDevice, companion?: UsbDfuDevice): string {
  return formatDfuDeviceLabel(
    device.manufacturer ?? companion?.manufacturer,
    device.product ?? companion?.product,
    device.vendorId,
    device.productId,
    device.serialNumber ?? companion?.serialNumber,
    device.usagePage ? `HID usage 0x${hex(device.usagePage)}` : 'HID'
  );
}
function formatDfuDeviceLabel(manufacturer: string | undefined, product: string | undefined, vendorId: number, productId: number, serialNumber: string | undefined, fallback: string): string {
  const identity = [manufacturer?.trim(), product?.trim()].filter(Boolean).join(' · ') || fallback;
  return `${identity} · 0x${hex(vendorId).toUpperCase()} / 0x${hex(productId).toUpperCase()}${serialNumber?.trim() ? ` · SN ${serialNumber.trim()}` : ''}`;
}
function basename(value: string): string { return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? value; }
function tailName(value: string): string { return basename(value); }
function hex(value: number): string { return value.toString(16).padStart(4, '0'); }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
