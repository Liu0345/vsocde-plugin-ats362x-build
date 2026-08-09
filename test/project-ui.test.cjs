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
  assert.match(flashPage, /开始烧录<\/button>\s*<div className="flash-firmware-source"><PathValue label="当前固件来源"/, '当前固件来源应位于串口烧录卡片最底部');
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
