const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'webview', 'src', 'main.tsx'), 'utf8');
const page = fs.readFileSync(path.join(root, 'webview', 'src', 'ChipPage.tsx'), 'utf8');
const viewport = fs.readFileSync(path.join(root, 'webview', 'src', 'viewport.ts'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'webview', 'src', 'chipRegistry.ts'), 'utf8');
const style = fs.readFileSync(path.join(root, 'webview', 'src', 'style.css'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(root, 'webview', 'src', 'data', 'ats362x.json'), 'utf8'));

test('工具后增加芯片页且筛选项集中在顶部一栏', () => {
  assert.match(main, /<Tab id="tools" label="工具"[\s\S]*?<Tab id="chip" label="芯片"/);
  assert.match(main, /page === 'chip' && <ChipPage \/>/);
  const bar = page.match(/<header className="chip-filter-bar">[\s\S]*?<\/header>/)?.[0] ?? '';
  for (const label of ['芯片型号', '模组型号', '功能大类', '功能小类', 'MFP 值', '功能对应引脚', '搜索']) assert.match(bar, new RegExp(label));
  assert.match(style, /\.chip-filter-bar \{[^}]*display: grid;/);
});

test('芯片数据使用可扩展注册表且 ATS362x 为默认型号', () => {
  assert.equal(data.id, 'ats362x');
  assert.equal(data.label, 'ATS362x');
  assert.equal(data.defaultModule, 'pro-interface-m1');
  assert.equal(data.modules[0].id, 'pro-interface-m1');
  assert.equal(data.modules[0].label, 'PRO-INTERFACE-M1');
  assert.match(registry, /export const chipRegistry: ChipDefinition\[]/);
  assert.match(registry, /新芯片只需按 RawChipDefinition 结构增加数据文件/);
  assert.match(page, /useState\(chipRegistry\[0\]\.id\)/);
  assert.match(page, /useState\(chip\.defaultModule\)/);
});

test('大图使用 PRO-INTERFACE-M1 的 88 Pin 模组定义而不是芯片 BGA 球位', () => {
  const modulePins = data.modules[0].pins;
  assert.equal(modulePins.length, 88);
  assert.deepEqual(modulePins.map((pin) => pin[0]), Array.from({ length: 88 }, (_, index) => index + 1));
  assert.equal(modulePins.some((pin) => /^IO\d+$/.test(pin[1])), false, '模组内部 IOxx 必须统一显示为 GPIOxx');
  assert.deepEqual([1, 21, 88].map((number) => modulePins.find((pin) => pin[0] === number)?.[1]), ['', '', '']);
  const chipPinNames = new Set(data.pins.map((pin) => pin[1]));
  assert.deepEqual(modulePins.filter((pin) => pin[2] && !chipPinNames.has(pin[2])), [], '每个已定义模组信号都必须关联到芯片引脚');
  assert.deepEqual(modulePins.find((pin) => pin[0] === 62), [62, 'GPIO64', 'GPIO64']);
  assert.deepEqual(modulePins.find((pin) => pin[0] === 66), [66, 'GPIO60', 'GPIO60']);
  assert.deepEqual(modulePins.find((pin) => pin[0] === 22), [22, 'GPIO13', 'GPIO13']);
  assert.match(page, /<strong>模组引脚定义<\/strong>/);
  assert.match(page, /function ModulePinMarker\(/);
  assert.match(page, /moduleDefinition\.label/);
  assert.doesNotMatch(page, /function PinBall\(/);
  assert.match(page, /模组 Pin \{modulePin\.number\}/);
});

test('默认过滤为 I2S 大类和 I2SG0 小类', () => {
  assert.deepEqual(data.defaults, { category: 'I2S', instance: 'I2SG0' });
  assert.match(page, /useState\(chip\.defaults\.category\)/);
  assert.match(page, /useState\(chip\.defaults\.instance\)/);
});

test('筛选栏末尾左侧为查询、右侧为重置', () => {
  assert.match(page, /<div className="chip-filter-actions">\s*<button onClick=\{runQuery\}>查询<\/button>\s*<button className="secondary" onClick=\{resetFilters\}>重置<\/button>/);
  assert.doesNotMatch(page, /scrollIntoView|ref=\{workspace\}/);
  assert.match(page, /setQueryRevision\(\(current\) => current \+ 1\)/);
  assert.match(page, /查询已更新 · \{lastQueryTime\}/);
  assert.match(page, /\[categoryMatches, mfp, pinName, query, queryRevision\]/);
  assert.match(style, /\.chip-filter-actions \{ display: grid; grid-template-columns: repeat\(2,/);
});

test('功能小类移除全部小类并始终选择有效的具体实例', () => {
  assert.doesNotMatch(page, /<option value="">全部小类<\/option>/);
  assert.match(page, /disabled=\{instances\.length === 0\}/);
  assert.match(page, /instances\.length === 0 && <option value="">无细分小类<\/option>/);
  assert.match(registry, /GPIO: \/\^\(\?:GPIO\|WIO\)\\d\+\//);
  assert.match(registry, /UART: \/\^UART\\d\+\//);
  assert.match(registry, /SPI: \/\^SPI\\d\+\//);
  assert.match(registry, /return normalized\.match\([\s\S]*?\?\.\[0\] \?\? ''/);
  assert.match(page, /\.filter\(Boolean\)/);
  assert.match(page, /if \(instances\.length > 0 && !instances\.includes\(instance\)\)/);
  assert.match(page, /if \(instances\.length === 0 && instance\) setInstance\(''\)/);
});

test('功能筛选移除 GPIO 类且引脚选项仅来自前置功能条件', () => {
  assert.match(page, /item !== 'GPIO' && exposedFunctions\.some/);
  assert.match(page, /const matchingNames = new Set\(categoryMatches\.filter\(\(\{ fn \}\) => !mfp \|\| fn\.mfp === mfp\)\.map\(\(\{ pin \}\) => pin\.name\)\)/);
  assert.match(page, /<Filter label="功能对应引脚">/);
  assert.match(page, /<option value="">全部对应引脚<\/option>/);
  assert.match(page, /if \(pinName && !pinOptions\.some/);
  assert.doesNotMatch(page, /<Filter label="GPIO \/ 引脚">/);
});

test('功能实例按信号角色分色且功能开关同步控制模组颜色', () => {
  assert.match(page, /signalColorKey\(fn, !instance\)/);
  assert.match(page, /`\$\{fn\.instance\} · \$\{role\}`/);
  assert.match(page, /const visibleMatches = useMemo\(\(\) => matches\.filter\(\(\{ fn \}\) => !hiddenFunctionNames\.has\(fn\.name\)\)/);
  assert.match(page, /for \(const \{ pin, fn \} of visibleMatches\)/);
  assert.match(page, /groupMatches\(visibleMatches\)/);
  assert.match(page, /className="module-signal-legend" aria-label="模组引脚信号颜色"/);
  assert.match(page, /<span key=\{item\.label\} title=\{item\.label\}><i style=\{\{ backgroundColor: item\.color \}\} \/>\{item\.label\}<\/span>/);
  assert.doesNotMatch(page, /module-signal-legend[\s\S]{0,500}<button/);
  assert.doesNotMatch(page, /ModulePinDecoration|module-role-mark|module-role-dot|<circle/);
  assert.match(style, /\.module-pin\.is-match line \{ stroke: var\(--module-pin-color\)/);
  assert.match(style, /\.module-signal-legend/);
});

test('功能到 GPIO 右侧按钮按完整功能名控制下方分组且默认全部显示', () => {
  assert.match(page, /useState<Set<string>>\(new Set\(\)\)/);
  assert.match(page, /const allReverseGroups = useMemo\(\(\) => groupMatches\(matches\)/);
  assert.match(page, /const reverseGroups = useMemo\(\(\) => groupMatches\(visibleMatches\)/);
  assert.match(page, /className="function-list-toggles"/);
  assert.match(page, /className="function-toggle-row">\s*<span className="function-toggle-label">显示分组<\/span>/);
  assert.match(page, /aria-label="功能列表显示开关"/);
  assert.match(page, /allReverseGroups\.map\(\(\[name\]\) => <button/);
  assert.match(page, /aria-pressed=\{!hiddenFunctionNames\.has\(name\)\}/);
  assert.match(page, /toggleFunctionVisibility\(name\)/);
  assert.match(page, /setHiddenFunctionNames\(new Set\(\)\)/);
  assert.doesNotMatch(page, /--signal-color[^\n]*function-list-toggle/);
  assert.match(style, /\.function-list-toggles \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(style, /\.function-list-toggle \{[^}]*width: max-content;/);
});

test('功能按钮独占标题下一行并按文字宽度分区换行', () => {
  assert.match(style, /\.chip-function-heading \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(style, /\.chip-function-heading-title \{[^}]*grid-column: 1 \/ -1;[^}]*justify-content: space-between;/);
  assert.match(style, /\.function-toggle-row \{[^}]*grid-column: 1 \/ -1;[^}]*grid-template-columns: auto minmax\(0, 1fr\);[^}]*border-top:/);
  assert.match(style, /\.function-list-toggles \{[^}]*justify-content: flex-start;/);
});

test('功能按钮跟随文字宽度且功能对应 GPIO 使用双列排列', () => {
  assert.match(style, /\.chip-function-group \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2,/);
  assert.match(style, /\.chip-function-group h3 \{[^}]*grid-column: 1 \/ -1;/);
  assert.match(style, /@media \(max-width: 420px\)[\s\S]*\.chip-function-group \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(style, /\.function-list-toggles[^}]*grid-template-columns/);
});

test('功能到 GPIO 结果全部展开且不使用内部滚动区', () => {
  assert.match(style, /\.chip-function-list \{ max-height: none; overflow: visible; \}/);
  assert.doesNotMatch(style, /\.pin-function-table, \.chip-function-list/);
});

test('模组引脚定义右侧保留原来的缩放控制', () => {
  assert.match(page, /<div className="chip-diagram-toolbar">\s*<strong>模组引脚定义<\/strong>\s*<div><button[^>]*title="缩小"[\s\S]*?className="secondary chip-zoom-ratio"[\s\S]*?title="放大"/);
});

test('直接选择 GPIO 后使用独立强高亮并压低其他模组引脚', () => {
  assert.match(page, /setSelectedModulePinNumber\(moduleDefinition\.pins\.find/);
  assert.match(page, /dimmed=\{selectedModulePinNumber !== undefined && pin\.number !== selectedModulePinNumber\}/);
  assert.doesNotMatch(page, /module-selected-halo|module-selected-core/);
  assert.match(style, /\.module-pin\.is-dimmed \{ opacity: \.16;/);
  assert.match(style, /\.module-pin\.is-selected line \{ stroke: #ff3b30; stroke-width: 7;/);
  assert.doesNotMatch(style, /\.module-selected-halo|\.module-selected-core/);
});

test('引脚功能与 MFP 数据完整且保留关联关系', () => {
  assert.equal(data.pins.length, 139);
  const gpioPins = data.pins.filter((pin) => /^GPIO\d+$/.test(pin[1]));
  assert.equal(gpioPins.length, 55);
  const entries = gpioPins.flatMap((pin) => pin[3].map((fn) => [pin[0], pin[1], ...fn]));
  assert.ok(entries.length > 1000);
  const keys = entries.map((item) => `${item[0]}:${item[2]}:${item[3]}`);
  assert.equal(new Set(keys).size, keys.length, '同一球位、功能、MFP 不应重复');
  assert.ok(entries.some((item) => item[1] === 'GPIO64' && item[2] === 'I2SG0_LRCLK' && item[3] === '0x14' && item[4] === 'I2S'));
  assert.match(page, /MFP \{fn\.mfp\}/);
  assert.match(page, /<code>\{fn\.mfp\}<\/code>/);
});

test('支持 GPIO 到功能及功能到 GPIO 双向查询', () => {
  assert.match(page, />GPIO → 功能</);
  assert.match(page, />功能 → GPIO</);
  assert.match(page, /groupMatches\(matches\)/);
  assert.match(page, /setPinName\(chipPin\?\.functions\.length \? chipPin\.name : ''\)/);
  assert.match(page, /setCategory\(fn\.category\); setInstance\(fn\.instance\); setMfp\(fn\.mfp\)/);
});

test('普通滚轮移动，Ctrl 加滚轮缩放，并支持拖动平移', () => {
  assert.match(page, /event\.ctrlKey \|\| event\.metaKey \|\| zoomKeyPressed\.current/);
  assert.match(page, /event\.deltaX \* scaleX/);
  assert.match(page, /addEventListener\('wheel', handleWheel, \{ passive: false, capture: true \}\)/);
  assert.match(page, /zoomViewAt\(current, event\.deltaY < 0 \? 0\.12 : -0\.12, viewX, viewY\)/);
  assert.match(viewport, /anchorX - \(anchorX - current\.x\) \* ratio/);
  assert.match(viewport, /function constrainViewport\(/);
  assert.match(viewport, /function constrainAxis\(/);
  assert.match(viewport, /const minimum = viewportSize - margin - contentEnd \* scale/);
  assert.match(viewport, /const maximum = margin - contentStart \* scale/);
  assert.match(viewport, /const PAN_SAFE_MARGIN = 96/);
  assert.match(viewport, /x: constrainAxis\(x, scale, 1120, 0, 1120, PAN_SAFE_MARGIN\)/);
  assert.match(viewport, /y: constrainAxis\(y, scale, 900, 0, 900, PAN_SAFE_MARGIN\)/);
  assert.match(page, /setViewport\(\(current\) => constrainViewport/);
  assert.match(page, /const activeDrag = drag\.current/);
  assert.match(page, /activeDrag\.originX \+ deltaX/);
  assert.doesNotMatch(page, /drag\.current!/);
  assert.match(page, /rect\.width > 0 \? 1120 \/ rect\.width : 1/);
  assert.match(viewport, /Number\.isFinite\(viewport\.x\)/);
  assert.match(page, /\{Math\.round\(viewport\.scale \* 100\)\}%/);
  assert.match(style, /\.chip-diagram-toolbar \.chip-zoom-ratio \{ min-width: 58px;/);
  assert.match(page, /onPointerDown=/);
  assert.match(page, /onPointerMove=/);
  assert.match(page, /滚轮移动 · Ctrl \+ 滚轮缩放 · 拖动平移/);
});
