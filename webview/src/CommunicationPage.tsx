import React, { useEffect, useMemo, useRef, useState } from 'react';

export type CommunicationTransport = 'uart' | 'hid';
type DataMode = 'text' | 'hex';
type LineEnding = 'none' | 'cr' | 'lf' | 'crlf';

export interface CommunicationEvent {
  id: number;
  transport: CommunicationTransport;
  direction: 'rx' | 'tx';
  bytes: number[];
  timestamp: string;
}

export interface CommunicationStatus {
  transport: CommunicationTransport;
  connected: boolean;
  target?: string;
  detail: string;
}

export interface CommunicationQuickCommand {
  id: string;
  transport: CommunicationTransport;
  name: string;
  mode: DataMode;
  payload: string;
  lineEnding: LineEnding;
}

interface SerialPortInfo { path: string; manufacturer?: string; serialNumber?: string }
interface HidDevice { path: string; vendorId: number; productId: number; product?: string; manufacturer?: string; serialNumber?: string; interface?: number; usagePage?: number; usage?: number }

export interface FilterWindow {
  id: string;
  name: string;
  query: string;
  mode: DataMode;
  direction: 'all' | 'rx' | 'tx';
  paused: boolean;
  pausedAt: number;
  clearedAt: number;
}

export interface AutoResponseRule {
  id: string;
  enabled: boolean;
  name: string;
  matchMode: DataMode;
  match: string;
  responseMode: DataMode;
  response: string;
  lineEnding: LineEnding;
  hits: number;
}

export interface CommunicationSavedState {
  defaultsVersion?: number;
  target?: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl?: 'none' | 'rtscts' | 'xonxoff';
  packetTimeoutMs?: number | string;
  displayMode?: DataMode;
  sendMode?: DataMode;
  lineEnding?: LineEnding;
  payload?: string;
  autoSendInterval?: number | string;
  reportId?: number | string;
  reportLength?: number | string;
  hidLengthMode?: 'flexible' | 'fixed64';
  filters?: FilterWindow[];
  autoResponseRules?: AutoResponseRule[];
}

interface Props {
  transport: CommunicationTransport;
  serialPorts: SerialPortInfo[];
  hidDevices: HidDevice[];
  status: CommunicationStatus;
  events: CommunicationEvent[];
  quickCommands: CommunicationQuickCommand[];
  postMessage(message: unknown): void;
  persisted?: CommunicationSavedState;
  persist(state: CommunicationSavedState): void;
}

const UART_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 2500000, 3000000];

export function CommunicationPage({ transport, serialPorts, hidDevices, status, events, quickCommands, postMessage, persisted = {}, persist }: Props): JSX.Element {
  const usesCurrentDefaults = persisted.defaultsVersion === 2;
  const [target, setTarget] = useState(persisted.target ?? '');
  const [baudRate, setBaudRate] = useState(persisted.baudRate ?? 115200);
  const [dataBits, setDataBits] = useState<5 | 6 | 7 | 8>(persisted.dataBits ?? 8);
  const [stopBits, setStopBits] = useState<1 | 2>(persisted.stopBits ?? 1);
  const [parity, setParity] = useState<'none' | 'even' | 'odd' | 'mark' | 'space'>(persisted.parity ?? 'none');
  const [flowControl, setFlowControl] = useState<'none' | 'rtscts' | 'xonxoff'>(persisted.flowControl ?? 'none');
  const [dtr, setDtr] = useState(false);
  const [rts, setRts] = useState(false);
  const [packetTimeoutMs, setPacketTimeoutMs] = useState(String(usesCurrentDefaults ? persisted.packetTimeoutMs ?? 50 : 50));
  const [displayMode, setDisplayMode] = useState<DataMode>(usesCurrentDefaults ? persisted.displayMode ?? 'hex' : 'hex');
  const [sendMode, setSendMode] = useState<DataMode>(usesCurrentDefaults ? persisted.sendMode ?? 'hex' : 'hex');
  const [lineEnding, setLineEnding] = useState<LineEnding>(persisted.lineEnding ?? 'none');
  const [payload, setPayload] = useState(persisted.payload ?? '');
  const [paused, setPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState(0);
  const [autoSend, setAutoSend] = useState(false);
  const [autoSendInterval, setAutoSendInterval] = useState(String(persisted.autoSendInterval ?? 1000));
  const [reportId, setReportId] = useState(String(persisted.reportId ?? 0));
  const [reportLength, setReportLength] = useState(String(persisted.reportLength ?? 64));
  const [hidLengthMode, setHidLengthMode] = useState<'flexible' | 'fixed64'>(persisted.hidLengthMode ?? 'flexible');
  const [filters, setFilters] = useState<FilterWindow[]>(() => (persisted.filters ?? []).map((filter) => ({ ...filter, paused: false, pausedAt: 0, clearedAt: 0 })));
  const [autoResponseRules, setAutoResponseRules] = useState<AutoResponseRule[]>(() => (persisted.autoResponseRules ?? []).map((rule) => ({ ...rule, hits: 0 })));
  const consoleRef = useRef<HTMLDivElement>(null);
  const handledRxId = useRef<number | null>(null);

  const rawDevices = transport === 'uart' ? serialPorts.map((port) => ({ id: port.path, path: port.path, label: port.path })) : hidDevices.map((device) => ({
    id: hidOptionId(device),
    path: device.path,
    label: `${hex4(device.vendorId)}:${hex4(device.productId)} · ${device.product ?? device.manufacturer ?? 'HID'} · ${device.serialNumber ?? pathTail(device.path)}${device.interface === undefined ? '' : ` · IF ${device.interface}`}${device.usagePage === undefined ? '' : ` · Usage ${hex(device.usagePage)}:${hex(device.usage ?? 0)}`}`
  }));
  // 同一路径下允许存在多个 Usage collection；仅合并所有区分字段都
  // 完全相同的重复记录，避免 React 出现重复 key。
  const devices = [...new Map(rawDevices.map((device) => [device.id, device])).values()];
  const transportEvents = useMemo(() => events.filter((event) => event.transport === transport), [events, transport]);
  const visibleEvents = paused ? transportEvents.filter((event) => event.id <= pausedAt) : transportEvents;
  const transportCommands = quickCommands.filter((command) => command.transport === transport);
  const rxBytes = transportEvents.filter((event) => event.direction === 'rx').reduce((sum, event) => sum + event.bytes.length, 0);
  const txBytes = transportEvents.filter((event) => event.direction === 'tx').reduce((sum, event) => sum + event.bytes.length, 0);
  const setLinkedDataMode = (mode: DataMode): void => {
    setDisplayMode(mode);
    setSendMode(mode);
  };

  useEffect(() => {
    if (devices.length === 0) return;
    if (target && devices.some((device) => device.id === target)) return;
    const legacySelection = target ? devices.find((device) => device.path === target) : undefined;
    setTarget((legacySelection ?? devices[0]).id);
  }, [devices.map((device) => device.path).join('\n'), target]);

  useEffect(() => {
    if (!paused) consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [visibleEvents.length, paused]);

  useEffect(() => {
    persist({ defaultsVersion: 2, target, baudRate, dataBits, stopBits, parity, flowControl, packetTimeoutMs, displayMode, sendMode, lineEnding, payload, autoSendInterval, reportId, reportLength, hidLengthMode, filters, autoResponseRules });
  }, [target, baudRate, dataBits, stopBits, parity, flowControl, packetTimeoutMs, displayMode, sendMode, lineEnding, payload, autoSendInterval, reportId, reportLength, hidLengthMode, filters, autoResponseRules]);

  useEffect(() => {
    if (!autoSend || !status.connected || !payload) return;
    const timer = window.setInterval(() => send(), parseAutoSendInterval(autoSendInterval));
    return () => window.clearInterval(timer);
  }, [autoSend, status.connected, payload, autoSendInterval, sendMode, lineEnding, reportId, reportLength, hidLengthMode]);

  const send = (command?: CommunicationQuickCommand): void => {
    const activePayload = command?.payload ?? payload;
    if (!activePayload) return;
    postMessage({
      type: 'communicationSend',
      transport,
      mode: command?.mode ?? sendMode,
      payload: activePayload,
      lineEnding: command?.lineEnding ?? lineEnding,
      reportId: parseReportId(reportId),
      reportLength: hidLengthMode === 'fixed64' ? 64 : parseReportLength(reportLength),
      fixedHid64: hidLengthMode === 'fixed64'
    });
  };

  useEffect(() => {
    const newestId = transportEvents.at(-1)?.id ?? 0;
    if (handledRxId.current === null) {
      handledRxId.current = newestId;
      return;
    }
    const lastHandledId = handledRxId.current;
    const received = transportEvents.filter((event) => event.direction === 'rx' && event.id > lastHandledId);
    handledRxId.current = newestId;
    if (!status.connected || received.length === 0) return;
    const hitCounts = new Map<string, number>();
    for (const event of received) {
      for (const rule of autoResponseRules) {
        if (!rule.enabled || !rule.match || !rule.response || !matchesQuery(event.bytes, rule.match, rule.matchMode)) continue;
        postMessage({
          type: 'communicationSend', transport, mode: rule.responseMode, payload: rule.response,
          lineEnding: rule.lineEnding, reportId: parseReportId(reportId),
          reportLength: hidLengthMode === 'fixed64' ? 64 : parseReportLength(reportLength),
          fixedHid64: hidLengthMode === 'fixed64'
        });
        hitCounts.set(rule.id, (hitCounts.get(rule.id) ?? 0) + 1);
      }
    }
    if (hitCounts.size > 0) setAutoResponseRules((rules) => rules.map((rule) => ({ ...rule, hits: rule.hits + (hitCounts.get(rule.id) ?? 0) })));
  }, [transportEvents.at(-1)?.id, status.connected, autoResponseRules, transport, reportId, reportLength, hidLengthMode]);

  const connect = (): void => {
    const selectedDevice = devices.find((device) => device.id === target);
    if (!selectedDevice) return;
    postMessage(transport === 'uart'
      ? { type: 'communicationConnect', transport, path: selectedDevice.path, baudRate, dataBits, stopBits, parity, flowControl, packetTimeoutMs: parsePacketTimeout(packetTimeoutMs) }
      : { type: 'communicationConnect', transport, path: selectedDevice.path, packetTimeoutMs: parsePacketTimeout(packetTimeoutMs) });
  };

  const saveCommands = (commands: CommunicationQuickCommand[]): void => postMessage({ type: 'communicationQuickCommandsSave', commands });
  const updateCommand = (id: string, patch: Partial<CommunicationQuickCommand>): void => {
    saveCommands(quickCommands.map((command) => command.id === id ? { ...command, ...patch } : command));
  };
  const addCommand = (): void => saveCommands([...quickCommands, {
    id: makeId(), transport, name: `命令 ${transportCommands.length + 1}`, mode: 'text', payload: '', lineEnding: 'none'
  }]);
  const addFilter = (): void => setFilters((current) => [...current, {
    id: makeId(), name: `过滤窗口 ${current.length + 1}`, query: '', mode: 'text', direction: 'all', paused: false, pausedAt: 0, clearedAt: 0
  }]);

  return <div className="communication-layout">
    <section className="card communication-settings">
      <div className="card-head"><div><h2>{transport === 'uart' ? 'UART 通讯' : 'HID 通讯'}</h2><small>稳定收发、空闲分包、测试数据和调试日志</small></div><span className={`connection-state ${status.connected ? 'is-connected' : ''}`}>{status.connected ? '已连接' : '未连接'}</span></div>
      <label className="field"><span>{transport === 'uart' ? '串口' : 'UAC HID 接口'}</span><div className="input-action"><TailSelect value={target} onChange={setTarget} options={devices} /><button className="secondary" onClick={() => postMessage({ type: transport === 'uart' ? 'listSerial' : 'listGenericHid' })}>扫描</button></div></label>
      {transport === 'uart' && <>
        <label className="field"><span>波特率</span><select value={baudRate} onChange={(event) => setBaudRate(Number(event.target.value))}>{UART_BAUD_RATES.map((baud) => <option key={baud} value={baud}>{baud}</option>)}</select></label>
        <div className="uart-format-grid"><label className="field"><span>数据位</span><select value={dataBits} onChange={(event) => setDataBits(Number(event.target.value) as 5 | 6 | 7 | 8)}><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></label><label className="field"><span>停止位</span><select value={stopBits} onChange={(event) => setStopBits(Number(event.target.value) as 1 | 2)}><option value="1">1</option><option value="2">2</option></select></label><label className="field"><span>校验位</span><select value={parity} onChange={(event) => setParity(event.target.value as typeof parity)}><option value="none">无校验</option><option value="even">偶校验</option><option value="odd">奇校验</option><option value="mark">Mark</option><option value="space">Space</option></select></label><label className="field"><span>流控</span><select value={flowControl} onChange={(event) => setFlowControl(event.target.value as typeof flowControl)}><option value="none">无流控</option><option value="rtscts">RTS/CTS</option><option value="xonxoff">XON/XOFF</option></select></label></div>
        <div className="uart-signal-row"><span>控制线</span><label><input type="checkbox" disabled={!status.connected} checked={dtr} onChange={(event) => { const next = event.target.checked; setDtr(next); postMessage({ type: 'communicationSetSignals', dtr: next, rts }); }} />DTR</label><label><input type="checkbox" disabled={!status.connected} checked={rts} onChange={(event) => { const next = event.target.checked; setRts(next); postMessage({ type: 'communicationSetSignals', dtr, rts: next }); }} />RTS</label></div>
      </>}
      <div className="columns">
        <label className="field"><span>分包超时（ms）</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={packetTimeoutMs} onChange={(event) => { if (/^\d{0,4}$/.test(event.target.value)) setPacketTimeoutMs(event.target.value); }} onBlur={() => { const value = parsePacketTimeout(packetTimeoutMs); setPacketTimeoutMs(String(value)); if (status.connected) postMessage({ type: 'communicationSetPacketTimeout', transport, packetTimeoutMs: value }); }} /></label>
        <label className="field"><span>收发显示格式</span><select value={displayMode} onChange={(event) => setLinkedDataMode(event.target.value as DataMode)}><option value="text">普通字符串</option><option value="hex">十六进制</option></select></label>
      </div>
      {transport === 'hid' && <>
        <div className="hid-length-mode" role="group" aria-label="HID 长度模式">
          <button className={hidLengthMode === 'flexible' ? 'active' : 'secondary'} onClick={() => setHidLengthMode('flexible')}>灵活长度（默认）</button>
          <button className={hidLengthMode === 'fixed64' ? 'active' : 'secondary'} onClick={() => setHidLengthMode('fixed64')}>固定 64 字节</button>
        </div>
        <small className="mode-help">{hidLengthMode === 'fixed64' ? '每次发送都补零到完整 64 字节；接收仍显示设备实际报告长度。' : '按实际数据长度发送，最大不超过 64 字节报告。'}</small>
        <div className="columns"><label className="field"><span>Report ID</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={reportId} onChange={(event) => { if (/^\d{0,3}$/.test(event.target.value)) setReportId(event.target.value); }} onBlur={() => setReportId(String(parseReportId(reportId)))} /></label><label className="field"><span>报告长度</span><input type="text" inputMode="numeric" pattern="[0-9]*" disabled={hidLengthMode === 'fixed64'} value={hidLengthMode === 'fixed64' ? '64' : reportLength} onChange={(event) => { if (/^\d{0,2}$/.test(event.target.value)) setReportLength(event.target.value); }} onBlur={() => setReportLength(String(parseReportLength(reportLength)))} /></label></div>
      </>}
      <div className="button-row"><button disabled={!target} onClick={status.connected ? () => postMessage({ type: 'communicationDisconnect', transport }) : connect}>{status.connected ? (transport === 'uart' ? '断开串口' : '断开 HID') : (transport === 'uart' ? '连接串口' : '连接 HID')}</button></div>
      <small className="connection-detail" title={status.target}>{status.detail}</small>
    </section>

    <section className="card communication-terminal-card">
      <div className="communication-toolbar"><div><strong>通讯日志</strong><span>← RX {rxBytes} B</span><span>→ TX {txBytes} B</span></div><div><button className="secondary" onClick={() => { setPaused((value) => !value); setPausedAt(transportEvents.at(-1)?.id ?? 0); }}>{paused ? '继续显示' : '暂停显示'}</button><button className="secondary" onClick={() => postMessage({ type: 'communicationClear', transport })}>清空接收</button><button className="secondary" onClick={() => postMessage({ type: 'communicationExport', transport, format: 'txt' })}>导出接收</button></div></div>
      <div className="communication-console" ref={consoleRef}>{visibleEvents.length === 0 ? <p className="communication-empty">等待接收或发送数据…</p> : visibleEvents.map((event) => <LogLine key={event.id} event={event} mode={displayMode} />)}</div>
      <div className="communication-send">
        <div className="communication-send-options"><select value={sendMode} onChange={(event) => setLinkedDataMode(event.target.value as DataMode)}><option value="text">普通字符串</option><option value="hex">十六进制</option></select><select value={lineEnding} disabled={sendMode === 'hex'} onChange={(event) => setLineEnding(event.target.value as LineEnding)}><option value="none">无换行</option><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select><label><input type="checkbox" checked={autoSend} onChange={(event) => setAutoSend(event.target.checked)} />自动发送</label><input className="auto-send-interval" type="text" inputMode="numeric" pattern="[0-9]*" value={autoSendInterval} onChange={(event) => { if (/^\d{0,7}$/.test(event.target.value)) setAutoSendInterval(event.target.value); }} onBlur={() => setAutoSendInterval(String(parseAutoSendInterval(autoSendInterval)))} title="自动发送间隔（ms，20～3600000）" /></div>
        <textarea value={payload} onChange={(event) => setPayload(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') send(); }} placeholder={sendMode === 'hex' ? 'AA 55 01 02' : '输入要发送的字符串；Ctrl/⌘ + Enter 发送'} />
        <div className="button-row"><button disabled={!status.connected || !payload} onClick={() => send()}>→ TX 发送</button><small>{transport === 'hid' && hidLengthMode === 'fixed64' ? '固定 64 字节报告' : '按实际长度发送'}</small></div>
      </div>
    </section>

    <section className="card quick-command-card">
      <div className="communication-toolbar"><strong>快捷命令</strong><div><button onClick={addCommand}>新增命令</button><button className="secondary" onClick={() => postMessage({ type: 'communicationQuickCommandsImport' })}>导入命令</button><button className="secondary" onClick={() => postMessage({ type: 'communicationQuickCommandsExport' })}>导出命令</button></div></div>
      <div className="quick-command-list">{transportCommands.length === 0 ? <p className="communication-empty">暂无快捷命令</p> : transportCommands.map((command) => <div className="quick-command" key={command.id}><input value={command.name} onChange={(event) => updateCommand(command.id, { name: event.target.value })} /><select value={command.mode} onChange={(event) => updateCommand(command.id, { mode: event.target.value as DataMode })}><option value="text">字符串</option><option value="hex">HEX</option></select><input value={command.payload} onChange={(event) => updateCommand(command.id, { payload: event.target.value })} placeholder="命令数据" /><select value={command.lineEnding} disabled={command.mode === 'hex'} onChange={(event) => updateCommand(command.id, { lineEnding: event.target.value as LineEnding })}><option value="none">无换行</option><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select><button disabled={!status.connected || !command.payload} onClick={() => send(command)}>发送</button><button className="danger-ghost" onClick={() => saveCommands(quickCommands.filter((item) => item.id !== command.id))}>删除命令</button></div>)}</div>
    </section>

    <section className="card communication-filter-card">
      <div className="communication-toolbar"><div><strong>过滤窗口</strong><span>可同时创建多个互不影响的视图</span></div><button onClick={addFilter}>新建过滤窗口</button></div>
      <div className="filter-window-grid">{filters.length === 0 ? <p className="communication-empty">尚未创建过滤窗口；主通讯日志始终保留完整数据。</p> : filters.map((filter) => <FilterPane key={filter.id} filter={filter} events={transportEvents} update={(patch) => setFilters((items) => items.map((item) => item.id === filter.id ? { ...item, ...patch } : item))} remove={() => setFilters((items) => items.filter((item) => item.id !== filter.id))} />)}</div>
    </section>

    <section className="card auto-response-card">
      <div className="communication-toolbar"><div><strong>自动应答</strong><span>每条规则独立开关，仅由新收到的 RX 数据触发</span></div><button onClick={() => setAutoResponseRules((rules) => [...rules, { id: makeId(), enabled: false, name: `应答规则 ${rules.length + 1}`, matchMode: 'text', match: '', responseMode: 'text', response: '', lineEnding: 'none', hits: 0 }])}>新增应答规则</button></div>
      <div className="auto-response-list">{autoResponseRules.length === 0 ? <p className="communication-empty">暂无自动应答规则</p> : autoResponseRules.map((rule) => <div className={`auto-response-rule ${rule.enabled ? 'is-enabled' : ''}`} key={rule.id}>
        <label className="rule-switch"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateAutoResponse(setAutoResponseRules, rule.id, { enabled: event.target.checked })} /><span>{rule.enabled ? '已开启' : '已关闭'}</span></label>
        <input value={rule.name} onChange={(event) => updateAutoResponse(setAutoResponseRules, rule.id, { name: event.target.value })} />
        <select value={rule.matchMode} onChange={(event) => updateAutoResponse(setAutoResponseRules, rule.id, { matchMode: event.target.value as DataMode })}><option value="text">收到字符串</option><option value="hex">收到 HEX</option></select>
        <input value={rule.match} onChange={(event) => updateAutoResponse(setAutoResponseRules, rule.id, { match: event.target.value })} placeholder="匹配内容" />
        <span className="response-arrow">自动返回 →</span>
        <select value={rule.responseMode} onChange={(event) => updateAutoResponse(setAutoResponseRules, rule.id, { responseMode: event.target.value as DataMode })}><option value="text">发送字符串</option><option value="hex">发送 HEX</option></select>
        <input value={rule.response} onChange={(event) => updateAutoResponse(setAutoResponseRules, rule.id, { response: event.target.value })} placeholder="返回内容" />
        <select value={rule.lineEnding} disabled={rule.responseMode === 'hex'} onChange={(event) => updateAutoResponse(setAutoResponseRules, rule.id, { lineEnding: event.target.value as LineEnding })}><option value="none">无换行</option><option value="cr">CR</option><option value="lf">LF</option><option value="crlf">CRLF</option></select>
        <span className="rule-hits">触发 {rule.hits} 次</span><button className="danger-ghost" onClick={() => setAutoResponseRules((rules) => rules.filter((item) => item.id !== rule.id))}>删除</button>
      </div>)}</div>
    </section>
  </div>;
}

function LogLine({ event, mode }: { event: CommunicationEvent; mode: DataMode }): JSX.Element {
  return <div className={`communication-line ${event.direction}`}><time>{new Date(event.timestamp).toLocaleTimeString()}</time><strong>{event.direction === 'rx' ? '← RX' : '→ TX'}</strong><span className="byte-count">[{event.bytes.length} B]</span><code>{formatBytes(event.bytes, mode)}</code></div>;
}

function FilterPane({ filter, events, update, remove }: { filter: FilterWindow; events: CommunicationEvent[]; update: (patch: Partial<FilterWindow>) => void; remove: () => void }): JSX.Element {
  const ceiling = filter.paused ? filter.pausedAt : Number.MAX_SAFE_INTEGER;
  const matches = events.filter((event) => event.id > filter.clearedAt && event.id <= ceiling && (filter.direction === 'all' || event.direction === filter.direction) && matchesQuery(event.bytes, filter.query, filter.mode));
  return <article className="filter-window"><div className="filter-window-head"><input value={filter.name} onChange={(event) => update({ name: event.target.value })} /><span>{matches.length} 条</span><button className="danger-ghost" onClick={remove}>关闭</button></div><div className="filter-controls"><select value={filter.direction} onChange={(event) => update({ direction: event.target.value as FilterWindow['direction'] })}><option value="all">全部方向</option><option value="rx">仅 RX</option><option value="tx">仅 TX</option></select><select value={filter.mode} onChange={(event) => update({ mode: event.target.value as DataMode })}><option value="text">字符串过滤</option><option value="hex">十六进制过滤</option></select><input value={filter.query} onChange={(event) => update({ query: event.target.value })} placeholder={filter.mode === 'hex' ? '例如 AA 55' : '输入关键字（留空显示全部）'} /><button className="secondary" onClick={() => update(filter.paused ? { paused: false } : { paused: true, pausedAt: events.at(-1)?.id ?? 0 })}>{filter.paused ? '继续' : '暂停'}</button><button className="secondary" onClick={() => update({ clearedAt: events.at(-1)?.id ?? 0 })}>清空视图</button></div><div className="filter-console">{matches.length === 0 ? <p className="communication-empty">暂无匹配数据</p> : matches.map((event) => <LogLine key={event.id} event={event} mode={filter.mode} />)}</div></article>;
}

function TailSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: Array<{ id: string; path: string; label: string }> }): JSX.Element {
  const selectedLabel = options.find((option) => option.id === value)?.label ?? '未选择';
  return <div className="select-placeholder communication-device-select">
    <select className={value ? '' : 'select-empty'} value={value} title={selectedLabel} onChange={(event) => onChange(event.target.value)}>
      <option value="">未选择</option>
      {options.map((option) => <option value={option.id} key={option.id} title={option.label}>{option.label}</option>)}
    </select>
    <div className={`select-display${value ? ' show-tail' : ''}`} aria-hidden="true"><span>{selectedLabel}</span></div>
  </div>;
}

function matchesQuery(bytes: number[], query: string, mode: DataMode): boolean {
  const needle = query.trim();
  if (!needle) return true;
  return formatBytes(bytes, mode).toLocaleLowerCase().includes(needle.replace(/0x/gi, '').replace(/[,_:-]+/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase());
}

function formatBytes(bytes: number[], mode: DataMode): string {
  if (mode === 'hex') return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\r/g, '\\r').replace(/\n/g, '\\n\n');
}

function parsePacketTimeout(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5000 ? parsed : 50;
}

function parseReportId(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : 0;
}

function parseReportLength(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : 64;
}

function parseAutoSendInterval(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 20 && parsed <= 3_600_000 ? parsed : 1000;
}

function hex(value: number): string { return `0x${value.toString(16).toUpperCase()}`; }
function hex4(value: number): string { return value.toString(16).padStart(4, '0').toUpperCase(); }
function pathTail(value: string): string { return value.length > 22 ? `…${value.slice(-21)}` : value; }
function hidOptionId(device: HidDevice): string { return `${device.path}\u001f${device.interface ?? ''}\u001f${device.usagePage ?? ''}\u001f${device.usage ?? ''}`; }
function makeId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function updateAutoResponse(
  setRules: React.Dispatch<React.SetStateAction<AutoResponseRule[]>>,
  id: string,
  patch: Partial<AutoResponseRule>
): void {
  setRules((rules) => rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));
}
