import React, { useEffect, useMemo, useRef, useState } from 'react';
import { chipCategories, ChipFunction, ChipPin, chipRegistry, ModulePin } from './chipRegistry';
import { constrainViewport, DEFAULT_VIEW, Viewport, zoomViewAt } from './viewport';

interface FunctionMatch { pin: ChipPin; fn: ChipFunction }
interface SignalColor { label: string; color: string }

export function ChipPage(): JSX.Element {
  const [chipId, setChipId] = useState(chipRegistry[0].id);
  const chip = chipRegistry.find((item) => item.id === chipId) ?? chipRegistry[0];
  const [moduleId, setModuleId] = useState(chip.defaultModule);
  const moduleDefinition = chip.modules.find((item) => item.id === moduleId) ?? chip.modules[0];
  const [category, setCategory] = useState(chip.defaults.category);
  const [instance, setInstance] = useState(chip.defaults.instance);
  const [mfp, setMfp] = useState('');
  const [pinName, setPinName] = useState('');
  const [query, setQuery] = useState('');
  const [queryRevision, setQueryRevision] = useState(0);
  const [lastQueryTime, setLastQueryTime] = useState('');
  const [selectedModulePinNumber, setSelectedModulePinNumber] = useState<number>();
  const [hiddenFunctionNames, setHiddenFunctionNames] = useState<Set<string>>(new Set());
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEW);
  const diagram = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number }>();
  const zoomKeyPressed = useRef(false);

  const exposedChipNames = useMemo(() => new Set(moduleDefinition.pins.map((pin) => pin.chipPinName).filter(Boolean)), [moduleDefinition]);
  const exposedFunctions = useMemo(() => chip.pins.filter((pin) => exposedChipNames.has(pin.name)).flatMap((pin) => pin.functions), [chip, exposedChipNames]);
  const categories = useMemo(() => chipCategories(chip).filter((item) => item !== 'GPIO' && exposedFunctions.some((fn) => fn.category === item)), [chip, exposedFunctions]);
  const instances = useMemo(() => [...new Set(exposedFunctions.filter((fn) => fn.category === category).map((fn) => fn.instance))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true })), [category, exposedFunctions]);
  const categoryMatches = useMemo(() => chip.pins
    .filter((pin) => exposedChipNames.has(pin.name))
    .flatMap((pin) => pin.functions.map((fn) => ({ pin, fn })))
    .filter(({ fn }) => (!category || fn.category === category) && (!instance || fn.instance === instance)), [chip, category, exposedChipNames, instance]);
  const pinOptions = useMemo(() => {
    const matchingNames = new Set(categoryMatches.filter(({ fn }) => !mfp || fn.mfp === mfp).map(({ pin }) => pin.name));
    return chip.pins.filter((pin) => matchingNames.has(pin.name));
  }, [categoryMatches, chip.pins, mfp]);
  const mfpValues = useMemo(() => [...new Set(categoryMatches.map(({ fn }) => fn.mfp).filter(Boolean))]
    .sort((left, right) => mfpOrder(left) - mfpOrder(right)), [categoryMatches]);

  useEffect(() => {
    setCategory(chip.defaults.category);
    setModuleId(chip.defaultModule);
    setInstance(chip.defaults.instance);
    setMfp('');
    setPinName('');
    setSelectedModulePinNumber(undefined);
    setHiddenFunctionNames(new Set());
    setViewport(DEFAULT_VIEW);
  }, [chip]);
  useEffect(() => {
    setPinName('');
    setSelectedModulePinNumber(undefined);
  }, [moduleDefinition]);
  useEffect(() => {
    if (instances.length > 0 && !instances.includes(instance)) {
      setInstance(category === chip.defaults.category && instances.includes(chip.defaults.instance) ? chip.defaults.instance : instances[0]);
    }
    if (instances.length === 0 && instance) setInstance('');
  }, [category, chip.defaults.category, chip.defaults.instance, instance, instances]);
  useEffect(() => {
    if (mfp && !mfpValues.includes(mfp)) setMfp('');
  }, [mfp, mfpValues]);
  useEffect(() => {
    if (pinName && !pinOptions.some((pin) => pin.name === pinName)) {
      setPinName('');
      setSelectedModulePinNumber(undefined);
    }
  }, [pinName, pinOptions]);
  useEffect(() => {
    setHiddenFunctionNames(new Set());
  }, [category, instance, mfp, moduleDefinition, pinName, query]);
  useEffect(() => {
    const element = diagram.current;
    if (!element) return;
    const handleKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Control' || event.key === 'Meta') zoomKeyPressed.current = true; };
    const handleKeyUp = (event: KeyboardEvent): void => { if (event.key === 'Control' || event.key === 'Meta') zoomKeyPressed.current = false; };
    const releaseZoomKey = (): void => { zoomKeyPressed.current = false; };
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const scaleX = rect.width > 0 ? 1120 / rect.width : 1;
      const scaleY = rect.height > 0 ? 900 / rect.height : 1;
      const viewX = (event.clientX - rect.left) * scaleX;
      const viewY = (event.clientY - rect.top) * scaleY;
      if (event.ctrlKey || event.metaKey || zoomKeyPressed.current) {
        setViewport((current) => zoomViewAt(current, event.deltaY < 0 ? 0.12 : -0.12, viewX, viewY));
      } else {
        setViewport((current) => constrainViewport({ ...current, x: current.x - event.deltaX * scaleX, y: current.y - event.deltaY * scaleY }));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseZoomKey);
    element.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseZoomKey);
      element.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return categoryMatches.filter(({ pin, fn }) => {
      if (mfp && fn.mfp !== mfp) return false;
      if (pinName && pin.name !== pinName) return false;
      if (!needle) return true;
      return [pin.packagePin, pin.name, pin.description, fn.name, fn.mfp].some((value) => value.toUpperCase().includes(needle));
    });
  }, [categoryMatches, mfp, pinName, query, queryRevision]);
  const matchingChipNames = useMemo(() => new Set(matches.map(({ pin }) => pin.name)), [matches]);
  const selectedModulePin = moduleDefinition.pins.find((pin) => pin.number === selectedModulePinNumber);
  const selectedPin = chip.pins.find((pin) => pin.name === selectedModulePin?.chipPinName) ?? chip.pins.find((pin) => pin.name === pinName);
  const allReverseGroups = useMemo(() => groupMatches(matches), [matches]);
  const visibleMatches = useMemo(() => matches.filter(({ fn }) => !hiddenFunctionNames.has(fn.name)), [hiddenFunctionNames, matches]);
  const reverseGroups = useMemo(() => groupMatches(visibleMatches), [visibleMatches]);
  const colorBySignal = useMemo(() => {
    const keys = [...new Set(matches.map(({ fn }) => signalColorKey(fn, !instance)))].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    return new Map(keys.map((key, index) => [key, SIGNAL_COLORS[index % SIGNAL_COLORS.length]]));
  }, [instance, matches]);
  const signalsByChipName = useMemo(() => {
    const byPin = new Map<string, SignalColor[]>();
    for (const { pin, fn } of visibleMatches) {
      const label = signalColorKey(fn, !instance);
      const current = byPin.get(pin.name) ?? [];
      if (!current.some((item) => item.label === label)) current.push({ label, color: colorBySignal.get(label) ?? SIGNAL_COLORS[0] });
      byPin.set(pin.name, current);
    }
    return byPin;
  }, [colorBySignal, instance, visibleMatches]);
  const signalLegend = useMemo(() => [...colorBySignal.entries()].map(([label, color]) => ({ label, color })), [colorBySignal]);

  const selectModulePin = (modulePin: ModulePin): void => {
    setSelectedModulePinNumber(modulePin.number);
    const chipPin = chip.pins.find((pin) => pin.name === modulePin.chipPinName);
    setPinName(chipPin?.functions.length ? chipPin.name : '');
  };
  const resetFilters = (): void => {
    setCategory(chip.defaults.category);
    setInstance(chip.defaults.instance);
    setMfp('');
    setPinName('');
    setQuery('');
    setLastQueryTime('');
    setSelectedModulePinNumber(undefined);
    setHiddenFunctionNames(new Set());
  };
  const runQuery = (): void => {
    setQueryRevision((current) => current + 1);
    setLastQueryTime(new Date().toLocaleTimeString());
    setSelectedModulePinNumber(pinName ? moduleDefinition.pins.find((pin) => pin.chipPinName === pinName)?.number : undefined);
  };
  const toggleFunctionVisibility = (name: string): void => {
    setHiddenFunctionNames((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return <section className="chip-page">
    <header className="chip-filter-bar">
      <Filter label="芯片型号"><select value={chipId} onChange={(event) => setChipId(event.target.value)}>{chipRegistry.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Filter>
      <Filter label="模组型号"><select value={moduleId} onChange={(event) => setModuleId(event.target.value)}>{chip.modules.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Filter>
      <Filter label="功能大类"><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></Filter>
      <Filter label="功能小类"><select value={instance} disabled={instances.length === 0} onChange={(event) => setInstance(event.target.value)}>{instances.length === 0 && <option value="">无细分小类</option>}{instances.map((item) => <option key={item} value={item}>{item}</option>)}</select></Filter>
      <Filter label="MFP 值"><select value={mfp} onChange={(event) => setMfp(event.target.value)}><option value="">全部 MFP</option>{mfpValues.map((item) => <option key={item} value={item}>{item}</option>)}</select></Filter>
      <Filter label="功能对应引脚"><select value={pinName} onChange={(event) => { const next = event.target.value; setPinName(next); setSelectedModulePinNumber(moduleDefinition.pins.find((pin) => pin.chipPinName === next)?.number); }}><option value="">全部对应引脚</option>{pinOptions.map((pin) => <option key={pin.packagePin} value={pin.name}>{pin.name} · Pin {moduleDefinition.pins.find((item) => item.chipPinName === pin.name)?.number ?? '内部'}</option>)}</select></Filter>
      <Filter label="搜索"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="功能、GPIO、模组 Pin 或 MFP" /></Filter>
      <div className="chip-filter-actions">
        <button onClick={runQuery}>查询</button>
        <button className="secondary" onClick={resetFilters}>重置</button>
      </div>
    </header>

    <div className="chip-summary">
      <div><strong>{chip.label}</strong><span>{moduleDefinition.label} · 88 Pin 模组</span></div>
      <span>匹配 {matches.length} 项功能 / {matchingChipNames.size} 个 GPIO</span>
      {lastQueryTime && <span className="chip-query-confirmation">查询已更新 · {lastQueryTime}</span>}
      <small>滚轮移动 · Ctrl + 滚轮缩放 · 拖动平移</small>
    </div>

    <div className="chip-workspace">
      <article className="chip-diagram-card">
        <div className="chip-diagram-toolbar">
          <strong>模组引脚定义</strong>
          <div><button className="secondary" title="缩小" onClick={() => setViewport((current) => zoomViewAt(current, -0.15, 560, 450))}>−</button><button className="secondary chip-zoom-ratio" title="还原为 100%" onClick={() => setViewport(DEFAULT_VIEW)}>{Math.round(viewport.scale * 100)}%</button><button className="secondary" title="放大" onClick={() => setViewport((current) => zoomViewAt(current, 0.15, 560, 450))}>+</button></div>
        </div>
        {signalLegend.length > 0 && <div className="module-signal-legend" aria-label="模组引脚信号颜色"><strong>信号颜色</strong>{signalLegend.map((item) => <span key={item.label} title={item.label}><i style={{ backgroundColor: item.color }} />{item.label}</span>)}</div>}
        <svg
          ref={diagram}
          className="chip-diagram"
          viewBox="0 0 1120 900"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: viewport.x, originY: viewport.y };
          }}
          onPointerMove={(event) => {
            const activeDrag = drag.current;
            if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const scaleX = rect.width > 0 ? 1120 / rect.width : 1;
            const scaleY = rect.height > 0 ? 900 / rect.height : 1;
            const deltaX = (event.clientX - activeDrag.x) * scaleX;
            const deltaY = (event.clientY - activeDrag.y) * scaleY;
            // React 可能在 pointerup 之后才执行状态回调；必须使用本次事件的快照，
            // 不能在回调里再次读取已被清空的 drag.current。
            setViewport((current) => constrainViewport({ ...current, x: activeDrag.originX + deltaX, y: activeDrag.originY + deltaY }));
          }}
          onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = undefined; }}
          onPointerCancel={() => { drag.current = undefined; }}
        >
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
            <rect x="150" y="120" width="820" height="660" className="module-body" />
            <text x="560" y="436" className="module-body-title" textAnchor="middle">{moduleDefinition.label}</text>
            <text x="560" y="462" className="module-body-subtitle" textAnchor="middle">{chip.label} · 模组 Pin 定义</text>
            {moduleDefinition.pins.map((pin) => <ModulePinMarker
              key={pin.number}
              pin={pin}
              signals={pin.chipPinName ? signalsByChipName.get(pin.chipPinName) ?? [] : []}
              selected={pin.number === selectedModulePinNumber}
              dimmed={selectedModulePinNumber !== undefined && pin.number !== selectedModulePinNumber}
              select={selectModulePin}
            />)}
          </g>
        </svg>
      </article>

      <aside className="chip-results">
        <PinDetails modulePin={selectedModulePin} pin={selectedPin} matches={matches} selectFunction={(fn) => { setCategory(fn.category); setInstance(fn.instance); setMfp(fn.mfp); }} />
        <article className="chip-result-card">
          <div className="chip-result-heading chip-function-heading">
            <div className="chip-function-heading-title"><strong>功能 → GPIO</strong><span>{reverseGroups.length === allReverseGroups.length ? `${allReverseGroups.length} 个功能` : `显示 ${reverseGroups.length} / ${allReverseGroups.length} 个功能`}</span></div>
            {allReverseGroups.length > 0 && <div className="function-toggle-row">
              <span className="function-toggle-label">显示分组</span>
              <div className="function-list-toggles" aria-label="功能列表显示开关">{allReverseGroups.map(([name]) => <button
                key={name}
                type="button"
                className={`function-list-toggle ${hiddenFunctionNames.has(name) ? 'is-off' : ''}`}
                aria-pressed={!hiddenFunctionNames.has(name)}
                title={`${name}：${hiddenFunctionNames.has(name) ? '点击开启显示' : '点击关闭显示'}`}
                onClick={() => toggleFunctionVisibility(name)}
              >{name}</button>)}</div>
            </div>}
          </div>
          <div className="chip-function-list">{reverseGroups.length === 0 ? <p className="chip-empty">{allReverseGroups.length > 0 ? '所有功能组已关闭显示' : '当前筛选没有匹配项'}</p> : reverseGroups.map(([name, items]) => <section key={name} className="chip-function-group"><h3>{name}</h3>{items.map(({ pin, fn }) => { const modulePin = moduleDefinition.pins.find((item) => item.chipPinName === pin.name); return <button key={`${pin.packagePin}-${fn.mfp}`} className="chip-function-pin" onClick={() => modulePin && selectModulePin(modulePin)}><span>{pin.name}<small>模组 Pin {modulePin?.number ?? '未引出'}</small></span><code>MFP {fn.mfp}</code></button>; })}</section>)}</div>
        </article>
      </aside>
    </div>
    <footer className="chip-source">数据源：{chip.source.join('；')}</footer>
  </section>;
}

function Filter({ label, children }: React.PropsWithChildren<{ label: string }>): JSX.Element {
  return <label className="chip-filter"><span>{label}</span>{children}</label>;
}

function ModulePinMarker({ pin, signals, selected, dimmed, select }: { pin: ModulePin; signals: SignalColor[]; selected: boolean; dimmed: boolean; select: (pin: ModulePin) => void }): JSX.Element {
  const className = `module-pin ${pin.label.startsWith('GPIO') ? 'is-gpio' : 'is-fixed'} ${signals.length ? 'is-match' : ''} ${selected ? 'is-selected' : ''} ${dimmed ? 'is-dimmed' : ''}`;
  const style = { '--module-pin-color': signals[0]?.color ?? 'var(--accent)' } as React.CSSProperties;
  const activate = (event: React.MouseEvent<SVGGElement> | React.KeyboardEvent<SVGGElement>): void => {
    event.stopPropagation();
    select(pin);
  };
  let marker: JSX.Element;
  if (pin.number <= 20) {
    const x = 190 + (pin.number - 1) * (740 / 19);
    marker = <g><rect className="module-pin-hit" x={x - 18} y="744" width="36" height="104" /><line x1={x} y1="780" x2={x} y2="824" /><text className="module-signal" x={x} y="762" transform={`rotate(-90 ${x} 762)`}>{pin.label}</text><text className="module-number" x={x} y="846" textAnchor="middle">{pin.number}</text></g>;
  } else if (pin.number <= 44) {
    const y = 720 - (pin.number - 21) * (540 / 23);
    marker = <g><rect className="module-pin-hit" x="930" y={y - 12} width="116" height="24" /><line x1="970" y1={y} x2="1015" y2={y} /><text className="module-signal" x="954" y={y + 4} textAnchor="end">{pin.label}</text><text className="module-number" x="1037" y={y + 4} textAnchor="middle">{pin.number}</text></g>;
  } else if (pin.number <= 64) {
    const x = 930 - (pin.number - 45) * (740 / 19);
    marker = <g><rect className="module-pin-hit" x={x - 18} y="48" width="36" height="104" /><line x1={x} y1="120" x2={x} y2="76" /><text className="module-signal" x={x} y="138" transform={`rotate(90 ${x} 138)`}>{pin.label}</text><text className="module-number" x={x} y="58" textAnchor="middle">{pin.number}</text></g>;
  } else {
    const y = 180 + (pin.number - 65) * (540 / 23);
    marker = <g><rect className="module-pin-hit" x="74" y={y - 12} width="116" height="24" /><line x1="150" y1={y} x2="105" y2={y} /><text className="module-signal" x="166" y={y + 4}>{pin.label}</text><text className="module-number" x="82" y={y + 4} textAnchor="middle">{pin.number}</text></g>;
  }
  return <g className={className} style={style} role="button" tabIndex={0} onClick={activate} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') activate(event); }}>
    <title>模组 Pin {pin.number} · {pin.label || '未定义'}{pin.chipPinName ? ` · 内部 ${pin.chipPinName}` : ''}{signals.length ? ` · ${signals.map((item) => item.label).join(' / ')}` : ''}</title>
    {marker}
  </g>;
}

function PinDetails({ modulePin, pin, matches, selectFunction }: { modulePin?: ModulePin; pin?: ChipPin; matches: FunctionMatch[]; selectFunction: (fn: ChipFunction) => void }): JSX.Element {
  const matchingKeys = new Set(matches.filter((item) => item.pin.packagePin === pin?.packagePin).map((item) => `${item.fn.name}-${item.fn.mfp}`));
  return <article className="chip-result-card pin-details">
    <div className="chip-result-heading"><strong>GPIO → 功能</strong>{modulePin && <span>模组 Pin {modulePin.number}</span>}</div>
    {!modulePin ? <p className="chip-empty">点击模组引脚或从顶部选择 GPIO</p> : <>
      <div className="pin-identity"><strong>{modulePin.label || '未定义'}</strong><span>{pin ? `内部 ${pin.name}${pin.description ? ` · ${pin.description}` : ''}` : '该模组 Pin 未连接到可复用 GPIO'}</span></div>
      {!pin ? <p className="chip-empty">没有可查询的 GPIO 复用功能</p> :
      <div className="pin-function-table">{pin.functions.length === 0 ? <p className="chip-empty">该模组引脚没有 GPIO 复用功能</p> : pin.functions.map((fn) => <button key={`${fn.name}-${fn.mfp}`} className={matchingKeys.has(`${fn.name}-${fn.mfp}`) ? 'matches-filter' : ''} onClick={() => selectFunction(fn)}><span><strong>{fn.name}</strong><small>{fn.category} / {fn.instance}</small></span><code>{fn.mfp}</code></button>)}</div>
      }
    </>}
  </article>;
}

function groupMatches(matches: FunctionMatch[]): Array<[string, FunctionMatch[]]> {
  const groups = new Map<string, FunctionMatch[]>();
  for (const item of matches) groups.set(item.fn.name, [...(groups.get(item.fn.name) ?? []), item]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }));
}

function mfpOrder(value: string): number {
  if (/^0x[\da-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  if (value === 'JTAG') return 0x100;
  if (value === 'Analog') return 0x101;
  return 0x200;
}

function signalColorKey(fn: ChipFunction, includeInstance: boolean): string {
  const rawRole = fn.instance && fn.name.startsWith(fn.instance)
    ? fn.name.slice(fn.instance.length).replace(/^_/, '')
    : fn.name;
  const role = rawRole
    .replace(/^DO\d+$/, 'DO')
    .replace(/^DI\d+$/, 'DI')
    .replace(/^DAT\d+$/, 'DAT') || fn.name;
  return includeInstance && fn.instance && role !== fn.instance ? `${fn.instance} · ${role}` : role;
}

const SIGNAL_COLORS = [
  '#ff4d4f', '#00b8d9', '#52c41a', '#fa8c16', '#9254de', '#fadb14',
  '#13c2c2', '#eb2f96', '#2f54eb', '#a0d911', '#fa541c', '#722ed1',
  '#08979c', '#d4380d', '#389e0d', '#c41d7f', '#1d39c4', '#d4b106',
  '#7cb305', '#531dab', '#006d75', '#ad2102', '#237804', '#9e1068'
];
