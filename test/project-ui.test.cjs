const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'main.tsx'), 'utf8');

test('最近项目支持逐项关闭、完整路径提示和清除全部记忆', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  assert.match(source, /清除全部记忆/);
  assert.match(source, /className="recent-item" key=\{item\} title=\{item\}/);
  assert.match(source, /type: 'removeRecentProject', path: item/);
  assert.match(source, /title="清除此项目记忆"/);
  assert.doesNotMatch(style, /\.recent-item:hover small/, '悬停时不应展开路径并改变列表布局');
});

test('点击已记忆项目不改变最近项目顺序', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'projectStore.ts'), 'utf8');
  assert.match(store, /existing\.some\(\(item\) => path\.resolve\(item\) === normalized\)\s*\? existing/);
  assert.doesNotMatch(store, /\[normalized, \.\.\.this\.recentProjects\.filter/);
});

test('扫描类选择保留空选项且固件入口使用统一名称', () => {
  assert.match(source, /function SerialPortSelect\([^\n]+emptyLabel = '未选择，请提供选择项'/);
  assert.match(source, /function PlaceholderSelect\(/);
  assert.match(source, /<option value="">空白-选项<\/option>/);
  assert.doesNotMatch(source, /默认（自动选择）/);
  assert.doesNotMatch(source, />自选文件</);
  assert.match(source, /type: 'scanFirmware'/);
  assert.match(source, />选择固件</);
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  assert.match(style, /select\.select-empty \{ color: transparent;/, '空值时必须隐藏原生文本，由显示层提供浅色提示且保留下拉箭头');
  assert.match(style, /\.select-placeholder::after \{[^}]*content: '▾';/, '自定义显示层必须始终保留下拉箭头');
  assert.match(style, /\.select-display \{[^}]*right: 24px;/, '显示层应贴近下拉箭头，避免尾部右侧出现过大空白');
});

test('编译与烧录合并并移除重复固件来源卡片', () => {
  assert.match(source, /<Tab id="build" label="编译\/烧录"/);
  assert.doesNotMatch(source, /<Tab id="flash"/);
  assert.match(source, /page === 'build'[\s\S]*?className="build-flash-grid"[\s\S]*?<BuildPage[\s\S]*?<FlashPage/);
  const buildPage = source.match(/function BuildPage[\s\S]*?function EditableBuildOption/)?.[0] ?? '';
  const flashPage = source.match(/function FlashPage[\s\S]*?function UsbDfuPage/)?.[0] ?? '';
  assert.doesNotMatch(buildPage, /当前固件来源/, '固件编译卡片不应显示当前固件来源');
  assert.match(flashPage, /'开始烧录'\}<\/button>[\s\S]*?<div className="flash-firmware-source"><PathValue label="当前固件来源"/, '当前固件来源应位于串口烧录卡片最底部');
  assert.doesNotMatch(flashPage, /仅负责 UART OTA \/ UART ADFU/, '串口烧录卡片不需要额外说明');
});

test('项目和固件来源独立布局且工具状态移入工具页', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  const projectPage = source.match(/function ProjectPage[\s\S]*?function FirmwareCard/)?.[0] ?? '';
  const toolsPage = source.match(/function ToolsPage[\s\S]*?function Card/)?.[0] ?? '';
  assert.match(projectPage, /className="project-source-grid"/);
  assert.doesNotMatch(projectPage, /title="工具状态"/);
  assert.match(toolsPage, /title="工具状态"/);
  assert.match(style, /\.project-source-grid \{[^}]*align-items: start;/, '左右两列高度变化必须互不拉伸');
});

test('工具页继电器默认扫描，CH1～CH8 每次勾选动作临时占用 HID', () => {
  const toolsPage = source.match(/function ToolsPage[\s\S]*?function Card/)?.[0] ?? '';
  const provider = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarProvider.ts'), 'utf8');
  assert.match(toolsPage, /title="USB HID 继电器"/);
  assert.match(toolsPage, /state\.relayDevices\.map/);
  assert.match(toolsPage, /Array\.from\(\{ length: 8 \}/);
  assert.match(toolsPage, /type: 'relayChannel'/);
  assert.match(toolsPage, /每次操作仅临时占用 HID/);
  assert.match(provider, /case 'ready':[\s\S]*?this\.refresh\(\)/);
  assert.match(provider, /case 'relayChannel'/);
});

test('插件开头始终说明每个工具的版本要求与检测结果', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  assert.match(source, /<ToolRequirements tools=\{state\.tools\} \/>/);
  assert.match(source, /function ToolRequirements\(/);
  assert.match(source, /工具版本要求/);
  assert.match(source, /tool\.minimumVersion/);
  assert.match(style, /\.tool-requirements \{[^}]*grid-column: 1 \/ -1;/);
});

test('可输入选择项原位切换自行输入且不增加第二个框', () => {
  assert.match(source, /placeholder = '未选择，请提供选择项'/);
  assert.match(source, /<option value=\{customOption\}>自行输入…<\/option>/);
  assert.match(source, /className="editable-choice-manual"/);
  assert.match(source, /placeholder="请输入…"/);
  assert.doesNotMatch(source, /\{manual && <input/);
  assert.doesNotMatch(source, /editable-choice-options/);
  assert.match(source, /selectedLabel=\{selectedChoice\?\.label \?\? selectedChoice\?\.value \?\? value\}/, '选中后必须使用扫描选项的显示标签');
});

test('编译复选框使用紧凑尺寸而不继承普通输入框高度', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  assert.match(style, /\.check input \{[^}]*width: 14px; height: 14px;/);
  assert.match(style, /\.checks \{[^}]*row-gap: 6px;/);
});

test('USB 和 HID DFU 在右上角显示已选设备身份摘要', () => {
  assert.match(source, /function DeviceSummary\(/);
  assert.match(source, /`0x\$\{hex\(vendorId\)\} \/ 0x\$\{hex\(productId\)\}`/);
  assert.match(source, /\['DFU 字符串', dfuName\]/);
  assert.match(source, /headerAside=\{device && <DeviceSummary/);
  assert.match(source, /function findCompanionDevice/);
  assert.match(source, /selectedLabel=\{deviceLabel\} preferTail=\{false\}/, 'DFU 设备选中后必须复用选项标签，不能显示内部 key 或路径');
  assert.match(source, /function formatDfuDeviceLabel/);
});

test('烧录串口和波特率使用同一水平对齐结构', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  assert.match(source, /className="columns flash-serial-fields"/);
  assert.match(style, /\.flash-serial-fields > \.field \{[^}]*grid-template-rows: 16px auto;/);
});

test('串口烧录默认自动选择方式且 manual 入口统一显示为 ADFU', () => {
  const flashPage = source.match(/function FlashPage[\s\S]*?function UsbDfuPage/)?.[0] ?? '';
  const toolsPage = source.match(/function ToolsPage[\s\S]*?function Card/)?.[0] ?? '';
  assert.match(flashPage, /useState\('auto'\)/);
  assert.match(flashPage, /<option value="auto">自动（按固件类型）<\/option>/);
  assert.match(flashPage, /<option value="manual">ADFU<\/option>/);
  assert.match(toolsPage, /<option value="manual">ADFU<\/option>/);
  assert.doesNotMatch(flashPage, />manual<\/option>/);
  assert.doesNotMatch(toolsPage, />manual<\/option>/);
});

test('串口烧录显示递进进度并在执行期间提供取消按钮', () => {
  const flashPage = source.match(/function FlashPage[\s\S]*?function UsbDfuPage/)?.[0] ?? '';
  const provider = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebarProvider.ts'), 'utf8');
  assert.match(flashPage, /<TransferProgressBar progress=\{flashProgress\}/);
  assert.match(flashPage, /busy && flashProgress\.percent < 100/);
  assert.match(flashPage, /const transferComplete = busy && flashProgress\.percent >= 100/);
  assert.match(flashPage, /flashQueued/);
  assert.match(flashPage, /transferComplete \? '开始烧录'/);
  assert.match(flashPage, /type: 'flashAbort'/);
  assert.match(flashPage, />取消烧录<\/button>/);
  assert.match(flashPage, /dbg reboot adfu/);
  assert.match(flashPage, /shellPort: shellPort \|\| uart/);
  assert.match(provider, /case 'flashAbort':[\s\S]*?this\.flashRunner\.cancel\(\)/);
  assert.match(provider, /queuedFlashRequest/);
  assert.match(provider, /下一次串口烧录已排队/);
});

test('选择内容超出宽度时优先显示末尾', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  assert.match(source, /function TailAwareSelectText\(/);
  assert.match(source, /content\.current\.scrollWidth > viewport\.current\.clientWidth/);
  assert.match(style, /\.select-placeholder select \{[^}]*color: transparent;/, '原生选中值必须隐藏，避免在箭头区域露出额外字符');
  assert.match(style, /\.select-placeholder select option \{[^}]*color: var\(--vscode-dropdown-foreground/, '展开菜单的选项文字必须保持可见');
  assert.match(style, /\.select-display > span \{[^}]*flex: 0 0 auto;/, '测量节点必须保留完整文字宽度，不能在溢出判断前被截断');
  assert.match(style, /\.select-display\.show-tail > span \{[^}]*right: 0;/, '溢出文字必须在可用显示区域内右对齐');
  assert.match(style, /\.select-display\.show-tail::before \{[^}]*content: '…';/);
});

test('身份认证流程将最新记录显示在最上方', () => {
  assert.match(source, /setIdentityEvents\(\(items\) => \[message\.event, \.\.\.items\]\.slice\(0, 120\)\)/);
  assert.match(source, /最新记录显示在最上方/);
});

test('身份认证通信波特率使用紧凑宽度', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'style.css'), 'utf8');
  assert.match(style, /\.identity-connect-fields \{[^}]*grid-template-columns: minmax\(220px, 1fr\) 142px;/);
  assert.match(style, /\.identity-connect-fields > \.field:last-child \{[^}]*width: 142px;/);
});
