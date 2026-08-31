const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'webview', 'src', 'main.tsx'), 'utf8');
const pagePath = path.join(root, 'webview', 'src', 'CommunicationPage.tsx');
const page = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, 'utf8') : '';
const style = fs.readFileSync(path.join(root, 'webview', 'src', 'style.css'), 'utf8');

test('UART 通讯和 HID 通讯位于工具之前', () => {
  assert.match(main, /<Tab id="uart" label="UART 通讯"[\s\S]*?<Tab id="hidCommunication" label="HID 通讯"[\s\S]*?<Tab id="tools" label="工具"/);
  assert.match(main, /page === 'uart'[\s\S]*?<CommunicationPage transport="uart"/);
  assert.match(main, /page === 'hidCommunication'[\s\S]*?<CommunicationPage transport="hid"/);
});

test('UART 通讯覆盖 9600 到 3000000 波特率和常用串口控制', () => {
  for (const baud of ['9600', '115200', '921600', '1000000', '2000000', '3000000']) assert.match(page, new RegExp(baud));
  assert.match(page, /分包超时/);
  assert.match(page, /CRLF/);
  assert.match(page, /自动发送/);
  assert.match(page, /连接串口/);
  assert.match(page, /数据位/);
  assert.match(page, /停止位/);
  assert.match(page, /校验位/);
  assert.match(page, /RTS\/CTS/);
  assert.match(page, />DTR</);
  assert.match(page, />RTS</);
});

test('通讯页具备文本十六进制、收发箭头、暂停清空和导出', () => {
  assert.match(page, /普通字符串/);
  assert.match(page, /十六进制/);
  assert.match(page, /← RX/);
  assert.match(page, /→ TX/);
  assert.match(page, /暂停显示/);
  assert.match(page, /清空接收/);
  assert.match(page, /导出接收/);
  assert.match(style, /\.communication-console/);
});

test('通讯显示区位于左侧且设置区位于右侧', () => {
  assert.match(style, /\.communication-terminal-card\s*\{[^}]*grid-column:\s*1/);
  assert.match(style, /\.communication-settings\s*\{[^}]*grid-column:\s*2/);
});

test('上下两个字符串十六进制选择会同步更新主显示区域', () => {
  assert.match(page, /const setLinkedDataMode[\s\S]*?setDisplayMode\(mode\)[\s\S]*?setSendMode\(mode\)/);
  assert.equal((page.match(/onChange=\{\(event\) => setLinkedDataMode\(event\.target\.value as DataMode\)\}/g) ?? []).length, 2);
});

test('通讯默认十六进制显示且分包超时为纯输入的 50 毫秒', () => {
  assert.match(page, /usesCurrentDefaults \? persisted\.displayMode \?\? 'hex' : 'hex'/);
  assert.match(page, /usesCurrentDefaults \? persisted\.sendMode \?\? 'hex' : 'hex'/);
  assert.match(page, /usesCurrentDefaults \? persisted\.packetTimeoutMs \?\? 50 : 50/);
  assert.match(page, /persist\(\{ defaultsVersion: 2/);
  assert.match(page, /分包超时（ms）<\/span><input type="text" inputMode="numeric"/);
  assert.doesNotMatch(page, /分包超时（ms）<\/span><input type="number"/);
});

test('通讯串口和 UAC HID 选择项优先显示末尾', () => {
  assert.match(page, /<TailSelect value=\{target\}/);
  assert.match(page, /id: hidOptionId\(device\)/);
  assert.match(page, /new Map\(rawDevices\.map\(\(device\) => \[device\.id, device\]\)\)/);
  assert.match(page, /path: selectedDevice\.path/);
  assert.match(page, /select-display\$\{value \? ' show-tail' : ''\}/);
  assert.match(page, /title=\{selectedLabel\}/);
});

test('快捷命令支持增删发送以及导入导出', () => {
  assert.match(page, /快捷命令/);
  assert.match(page, /新增命令/);
  assert.match(page, /导入命令/);
  assert.match(page, /导出命令/);
  assert.match(page, /删除命令/);
});

test('HID 通讯支持通用设备扫描、Report ID 与报告长度', () => {
  assert.match(page, /UAC HID 接口/);
  assert.match(page, /<button className="secondary"[\s\S]*?>扫描<\/button>/);
  assert.doesNotMatch(page, /刷新串口|扫描 UAC HID/);
  assert.match(page, /Report ID/);
  assert.match(page, /报告长度/);
  assert.match(page, /Report ID<\/span><input type="text" inputMode="numeric"/);
  assert.match(page, /报告长度<\/span><input type="text" inputMode="numeric"/);
  assert.match(page, /灵活长度（默认）/);
  assert.match(page, /固定 64 字节/);
  assert.match(page, /连接 HID/);
});

test('通讯页面所有数字项均为直接输入且不显示加减按钮', () => {
  assert.doesNotMatch(page, /type="number"/);
  assert.match(page, /auto-send-interval" type="text" inputMode="numeric"/);
  assert.match(page, /parseReportId\(reportId\)/);
  assert.match(page, /parseReportLength\(reportLength\)/);
  assert.match(page, /parseAutoSendInterval\(autoSendInterval\)/);
});

test('UART 与 HID 共用可创建多个的独立过滤窗口', () => {
  assert.match(page, /新建过滤窗口/);
  assert.match(page, /可同时创建多个互不影响的视图/);
  assert.match(page, /字符串过滤/);
  assert.match(page, /十六进制过滤/);
  assert.match(page, /仅 RX/);
  assert.match(style, /\.filter-window-grid/);
});

test('自动应答规则具有独立开关和收发格式', () => {
  assert.match(page, /自动应答/);
  assert.match(page, /每条规则独立开关/);
  assert.match(page, /收到字符串/);
  assert.match(page, /收到 HEX/);
  assert.match(page, /发送字符串/);
  assert.match(page, /发送 HEX/);
});

test('过滤窗口与自动应答配置在切换页面和重开编辑区后保留', () => {
  assert.match(main, /readCommunicationSettings\('uart'\)/);
  assert.match(main, /writeCommunicationSettings\('hid'/);
  assert.match(page, /persist\(\{ defaultsVersion: 2, target, baudRate,[\s\S]*?packetTimeoutMs/);
  assert.match(main, /page === 'hidCommunication'[\s\S]*?listGenericHid/);
});
