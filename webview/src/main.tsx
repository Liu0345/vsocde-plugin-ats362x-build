import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

type Page = 'project' | 'build' | 'flash' | 'hid' | 'tools';
interface Tool { name: string; label: string; available: boolean; detail: string }
interface State {
  projectPath?: string;
  recentProjects: string[];
  firmwareOverride?: string;
  defaultFirmwareDirectory?: string;
  discoveredFirmware: string[];
  tools: Tool[];
  busy?: string;
}
interface HidDevice {
  path: string;
  vendorId: number;
  productId: number;
  product?: string;
  manufacturer?: string;
  serialNumber?: string;
  usagePage?: number;
}
interface Notice { level: string; message: string; time: string }

const initialState: State = { recentProjects: [], discoveredFirmware: [], tools: [] };

function App(): JSX.Element {
  const [page, setPage] = useState<Page>('project');
  const [state, setState] = useState<State>(initialState);
  const [hidDevices, setHidDevices] = useState<HidDevice[]>([]);
  const [progress, setProgress] = useState({ percent: 0, detail: '' });
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'state') setState(message.state);
      if (message.type === 'hidDevices') setHidDevices(message.devices);
      if (message.type === 'progress') setProgress({ percent: message.percent, detail: message.detail });
      if (message.type === 'notice') {
        setNotices((items) => [{ level: message.level, message: message.message, time: new Date().toLocaleTimeString() }, ...items].slice(0, 20));
      }
    };
    window.addEventListener('message', listener);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);

  const otaFirmware = useMemo(() => state.discoveredFirmware.find((file) => /ota.*\.bin$/i.test(file)) ?? state.discoveredFirmware.find((file) => /\.bin$/i.test(file)) ?? '', [state.discoveredFirmware]);

  return <main>
    <header className="hero">
      <div className="chip-icon">A</div>
      <div>
        <h1>ATS362X</h1>
        <p>构建、DFU 与烧录控制台</p>
      </div>
      <button className="icon-button" title="刷新" onClick={() => vscode.postMessage({ type: 'refresh' })}>↻</button>
    </header>

    <ProjectBar state={state} />
    <nav>
      <Tab id="project" label="项目" icon="◇" active={page} set={setPage} />
      <Tab id="build" label="编译" icon="⌁" active={page} set={setPage} />
      <Tab id="flash" label="烧录" icon="⇩" active={page} set={setPage} />
      <Tab id="hid" label="HID DFU" icon="USB" active={page} set={setPage} />
      <Tab id="tools" label="工具" icon="⋯" active={page} set={setPage} />
    </nav>

    <section className="content">
      {page === 'project' && <ProjectPage state={state} />}
      {page === 'build' && <BuildPage disabled={!state.projectPath} />}
      {page === 'flash' && <FlashPage state={state} />}
      {page === 'hid' && <HidPage state={state} devices={hidDevices} defaultFirmware={otaFirmware} progress={progress} />}
      {page === 'tools' && <ToolsPage state={state} notices={notices} />}
    </section>
  </main>;
}

function Tab({ id, label, icon, active, set }: { id: Page; label: string; icon: string; active: Page; set: (value: Page) => void }): JSX.Element {
  return <button className={active === id ? 'active' : ''} onClick={() => set(id)}><span>{icon}</span>{label}</button>;
}

function ProjectBar({ state }: { state: State }): JSX.Element {
  return <div className="project-bar">
    <div className="path-block">
      <span className="eyebrow">当前项目</span>
      <strong title={state.projectPath}>{state.projectPath ? basename(state.projectPath) : '尚未选择'}</strong>
      <small title={state.projectPath}>{state.projectPath ?? '请选择 ARIA workspace track'}</small>
    </div>
    <button className="secondary" onClick={() => vscode.postMessage({ type: 'selectProject' })}>选择</button>
  </div>;
}

function ProjectPage({ state }: { state: State }): JSX.Element {
  return <>
    <Card title="项目目录" subtitle="支持 ARIA workspace 与隔离 workspace track">
      <PathValue label="当前项目" value={state.projectPath} empty="未选择" />
      <div className="button-row">
        <button onClick={() => vscode.postMessage({ type: 'selectProject' })}>选择项目目录</button>
        <button className="danger-ghost" onClick={() => vscode.postMessage({ type: 'clearProjects' })}>清除记忆</button>
      </div>
      {state.recentProjects.length > 0 && <div className="recent-list">
        <span className="eyebrow">最近项目</span>
        {state.recentProjects.map((item) => <button key={item} title={item} onClick={() => vscode.postMessage({ type: 'selectRecentProject', path: item })}>
          <strong>{basename(item)}</strong><small>{item}</small>
        </button>)}
      </div>}
    </Card>
    <FirmwareCard state={state} />
    <Card title="工具状态" subtitle="插件调用现有 Baton / Actions Flash，并内置 HID 传输层">
      <div className="tool-grid">{state.tools.map((tool) => <div className="tool" key={tool.name}>
        <span className={`dot ${tool.available ? 'ok' : 'bad'}`} />
        <div><strong>{tool.label}</strong><small>{tool.detail}</small></div>
      </div>)}</div>
    </Card>
  </>;
}

function FirmwareCard({ state }: { state: State }): JSX.Element {
  return <Card title="固件来源" subtitle="未设置覆盖路径时，自动使用项目最新的 _firmware 目录">
    <div className="source-pill">{state.firmwareOverride ? '自定义' : '默认（自动）'}</div>
    <PathValue label={state.firmwareOverride ? '覆盖路径' : '默认固件目录'} value={state.firmwareOverride ?? state.defaultFirmwareDirectory} empty="构建后自动发现" />
    <div className="button-row wrap">
      <button className="secondary" onClick={() => vscode.postMessage({ type: 'selectFirmware' })}>选择固件</button>
      <button className="secondary" onClick={() => vscode.postMessage({ type: 'selectFirmwareDirectory' })}>选择目录</button>
      {state.firmwareOverride && <button className="ghost" onClick={() => vscode.postMessage({ type: 'clearFirmwareOverride' })}>恢复默认</button>}
    </div>
    {state.discoveredFirmware.length > 0 && <details><summary>已发现 {state.discoveredFirmware.length} 个固件</summary>
      <div className="file-list">{state.discoveredFirmware.slice(0, 12).map((file) => <code key={file} title={file}>{basename(file)}</code>)}</div>
    </details>}
  </Card>;
}

function BuildPage({ disabled }: { disabled: boolean }): JSX.Element {
  const [host, setHost] = useState('builder-ubuntu');
  const [download, setDownload] = useState('ota');
  const [board, setBoard] = useState('');
  const [app, setApp] = useState('');
  const [dspOnly, setDspOnly] = useState(false);
  const [skipDsp, setSkipDsp] = useState(false);
  const [keep, setKeep] = useState(false);
  const [mapSummary, setMapSummary] = useState(false);
  const options = { buildHost: host, download, board, app, dspOnly, skipDsp, keep, mapSummary };
  return <Card title="固件编译" subtitle="默认在 builder-ubuntu 远程构建，避免本机 QEMU 慢编译">
    <Field label="构建主机"><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="builder-ubuntu" /></Field>
    <Field label="下载项"><select value={download} onChange={(e) => setDownload(e.target.value)}><option value="ota">ota</option><option value="ota-fw">ota-fw</option><option value="all">all</option></select></Field>
    <div className="columns"><Field label="Board（可选）"><input value={board} onChange={(e) => setBoard(e.target.value)} /></Field><Field label="App（可选）"><input value={app} onChange={(e) => setApp(e.target.value)} /></Field></div>
    <div className="checks">
      <Check label="仅 DSP" checked={dspOnly} set={(value) => { setDspOnly(value); if (value) setSkipDsp(false); }} />
      <Check label="跳过 DSP" checked={skipDsp} set={(value) => { setSkipDsp(value); if (value) setDspOnly(false); }} />
      <Check label="保留远端目录" checked={keep} set={setKeep} />
      <Check label="生成 Map 摘要" checked={mapSummary} set={setMapSummary} />
    </div>
    <div className="button-row"><button disabled={disabled} onClick={() => run('build', options)}>开始编译</button><button className="secondary" disabled={disabled} onClick={() => run('buildFlashVerify', options)}>编译 → 烧录 → 校验</button></div>
  </Card>;
}

function FlashPage({ state }: { state: State }): JSX.Element {
  const [method, setMethod] = useState('auto');
  const [entry, setEntry] = useState('power-cycle');
  const [verify, setVerify] = useState('boot');
  const [uart, setUart] = useState('');
  const [baud, setBaud] = useState('');
  const [timeout, setTimeoutValue] = useState('');
  const [vidPid, setVidPid] = useState('10d6:10d6');
  const [dryRun, setDryRun] = useState(false);
  const firmware = state.firmwareOverride ?? state.defaultFirmwareDirectory;
  return <>
    <FirmwareCard state={state} />
    <Card title="固件烧录" subtitle="终端会保留 READY、电源切换和烧录全过程输出">
      <PathValue label="当前固件来源" value={firmware} empty="未发现固件" />
      <Field label="烧录方式"><select value={method} onChange={(e) => setMethod(e.target.value)}>
        <option value="auto">自动判断</option><option value="ota-uart">UART OTA (.bin)</option><option value="fw-uart">UART ADFU (.fw)</option><option value="fw-usb">USB ADFU (.fw)</option><option value="dfu">USB DFU (.bin)</option>
      </select></Field>
      <div className="columns"><Field label="进入方式"><select value={entry} onChange={(e) => setEntry(e.target.value)}><option value="power-cycle">power-cycle</option><option value="manual">manual</option><option value="shell">shell</option></select></Field><Field label="烧录后校验"><select value={verify} onChange={(e) => setVerify(e.target.value)}><option value="boot">boot</option><option value="enum">enum</option><option value="none">none</option></select></Field></div>
      <div className="columns"><Field label="UART（可选）"><input value={uart} onChange={(e) => setUart(e.target.value)} placeholder="/dev/cu.usbserial-…" /></Field><Field label="Baud（可选）"><input value={baud} onChange={(e) => setBaud(e.target.value)} /></Field></div>
      <div className="columns"><Field label="超时秒数"><input value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} /></Field><Field label="ADFU VID:PID"><input value={vidPid} onChange={(e) => setVidPid(e.target.value)} /></Field></div>
      <Check label="仅预演，不写设备" checked={dryRun} set={setDryRun} />
      <button disabled={!state.projectPath} onClick={() => run('flash', { method, entry, verify, uart, baud, timeout, vidPid, dryRun })}>开始烧录</button>
    </Card>
  </>;
}

function HidPage({ state, devices, defaultFirmware, progress }: { state: State; devices: HidDevice[]; defaultFirmware: string; progress: { percent: number; detail: string } }): JSX.Element {
  const [devicePath, setDevicePath] = useState('');
  const [firmware, setFirmware] = useState('');
  const [bcd, setBcd] = useState('0');
  useEffect(() => { if (!devicePath && devices.length > 0) setDevicePath(devices[0].path); }, [devices, devicePath]);
  useEffect(() => { if (!firmware && defaultFirmware) setFirmware(defaultFirmware); }, [defaultFirmware, firmware]);
  const busy = state.busy === 'hidDfu';
  return <Card title="HID 运行时 DFU" subtitle="通过 P1 DSPTuner v2 HID 协议传输 OTA .bin；每帧 CRC16，整包 CRC32">
    <div className="callout">HID DFU 不进入 ADFU 模式。设备必须已枚举普通 HID 接口，固件上需启用 HID 更新模块。</div>
    <div className="button-row"><button className="secondary" disabled={busy} onClick={() => vscode.postMessage({ type: 'listHid' })}>扫描 HID 设备</button><span className="muted">发现 {devices.length} 个接口</span></div>
    <Field label="HID 设备"><select value={devicePath} onChange={(e) => setDevicePath(e.target.value)}><option value="">请选择设备</option>{devices.map((device) => <option key={device.path} value={device.path}>{hex(device.vendorId)}:{hex(device.productId)} · {device.product ?? device.manufacturer ?? 'HID'}{device.usagePage ? ` · usage ${hex(device.usagePage)}` : ''}</option>)}</select></Field>
    <Field label="OTA .bin 固件"><select value={firmware} onChange={(e) => setFirmware(e.target.value)}><option value="">未发现</option>{state.discoveredFirmware.filter((file) => /\.bin$/i.test(file)).map((file) => <option key={file} value={file}>{basename(file)}</option>)}</select></Field>
    <Field label="期望 bcdDevice（十六进制，可选）"><input value={bcd} onChange={(e) => setBcd(e.target.value)} placeholder="例如 0102；0 表示不指定" /></Field>
    {(busy || progress.detail) && <div className="progress"><div><span style={{ width: `${progress.percent}%` }} /></div><small>{progress.percent}% · {progress.detail}</small></div>}
    <div className="button-row"><button disabled={busy || !devicePath || !firmware} onClick={() => vscode.postMessage({ type: 'hidDfu', path: devicePath, firmware, expectedBcd: Number.parseInt(bcd || '0', 16) || 0 })}>开始 HID DFU</button>{busy && <button className="danger" onClick={() => vscode.postMessage({ type: 'hidAbort', path: devicePath })}>取消</button>}</div>
  </Card>;
}

function ToolsPage({ state, notices }: { state: State; notices: Notice[] }): JSX.Element {
  const [entry, setEntry] = useState('manual');
  const [size, setSize] = useState('8388608');
  const [timeout, setTimeoutValue] = useState('120');
  const [vidPid, setVidPid] = useState('10d6:10d6');
  const [shellPort, setShellPort] = useState('');
  const [shellBaud, setShellBaud] = useState('3000000');
  const [shellCmd, setShellCmd] = useState('dbg reboot adfu');
  const [dryRun, setDryRun] = useState(false);
  return <>
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
      {entry === 'shell' && <><Field label="Shell UART"><input value={shellPort} onChange={(e) => setShellPort(e.target.value)} placeholder="留空则使用设备配置" /></Field><div className="columns"><Field label="Shell Baud"><input value={shellBaud} onChange={(e) => setShellBaud(e.target.value)} /></Field><Field label="重启命令"><input value={shellCmd} onChange={(e) => setShellCmd(e.target.value)} /></Field></div></>}
      <Check label="仅预演，不擦除" checked={dryRun} set={setDryRun} />
      <button className="danger" disabled={!state.projectPath} onClick={() => run('erase', { entry, size, timeout, vidPid, shellPort: entry === 'shell' ? shellPort : '', shellBaud: entry === 'shell' ? shellBaud : '', shellCmd: entry === 'shell' ? shellCmd : '', dryRun })}>{dryRun ? '预演全擦除' : '全擦除 Flash'}</button>
    </Card>
    <Card title="操作记录" subtitle="完整命令输出位于 ATS362X 集成终端">
      {notices.length === 0 ? <p className="muted">暂无操作</p> : <div className="logs">{notices.map((notice, index) => <div key={`${notice.time}-${index}`} className={notice.level}><time>{notice.time}</time><span>{notice.message}</span></div>)}</div>}
    </Card>
  </>;
}

function Card({ title, subtitle, children }: React.PropsWithChildren<{ title: string; subtitle?: string }>): JSX.Element {
  return <article className="card"><div className="card-head"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{children}</article>;
}
function Field({ label, children }: React.PropsWithChildren<{ label: string }>): JSX.Element { return <label className="field"><span>{label}</span>{children}</label>; }
function Check({ label, checked, set }: { label: string; checked: boolean; set: (value: boolean) => void }): JSX.Element { return <label className="check"><input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} /><span>{label}</span></label>; }
function PathValue({ label, value, empty }: { label: string; value?: string; empty: string }): JSX.Element { return <div className="path-value"><span>{label}</span><code title={value}>{value ?? empty}</code></div>; }
function run(action: string, options: Record<string, string | boolean>): void { vscode.postMessage({ type: 'run', request: { action, options } }); }
function basename(value: string): string { return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? value; }
function hex(value: number): string { return value.toString(16).padStart(4, '0'); }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
