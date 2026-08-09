const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { discoverBuildOptions } = require('../dist/services/buildOptions.js');

test('扫描 App 相对路径和各自的 Board 候选项', async (context) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ats362x-build-options-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));

  await fs.mkdir(path.join(workspace, 'application', 'usb-audio-template', 'arm_mcu_code', 'boards', 'arm', 'ats362x_dvb'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'application', 'usb-audio-template', 'baton-target.toml'), 'name = "USB Audio Template"\n');
  await fs.mkdir(path.join(workspace, 'custom-product', 'boards', 'arm', 'custom_board'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'custom-product', 'baton-target.toml'), 'name = "Custom"\n');
  await fs.mkdir(path.join(workspace, 'ATS362X-sdk', 'boards', 'arm', 'sdk_board'), { recursive: true });

  assert.deepEqual(await discoverBuildOptions(workspace), [
    { app: 'application/usb-audio-template', boards: ['ats362x_dvb'] },
    { app: 'custom-product', boards: ['custom_board'] }
  ]);
});

test('未选择项目时不产生固定候选项', async () => {
  assert.deepEqual(await discoverBuildOptions(), []);
});

test('编译界面保留自行输入并为 App 和 Board 分别提供扫描按钮', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'webview', 'src', 'main.tsx'), 'utf8');
  assert.match(source, /<EditableChoice id=\{listId\}/, 'App 和 Board 必须使用不会过滤掉其他项目的可输入组合框');
  assert.match(source, /EditableBuildOption label="Board（可选）"/);
  assert.match(source, /EditableBuildOption label="App（可选）"/);
  assert.match(source, /className="build-option-stack">\s*<EditableBuildOption label="Board（可选）"[\s\S]*?<EditableBuildOption label="App（可选）"/, 'Board 必须在上，App 必须在下');
  assert.match(source, /type: 'scanBuildOptions'/);
  assert.match(source, /placeholder = '未选择，请提供选择项'/, '组合框必须在未选择时显示弱化提示');
  assert.match(source, /<option value="">空白-选项<\/option>/, '下拉列表中的空值必须显示为空白选项');
  assert.match(source, /<option value=\{customOption\}>自行输入…<\/option>/, '组合框必须保留自行输入入口');
});

test('USB DFU 和 HID DFU 位于同一页面并保持上下顺序', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'webview', 'src', 'main.tsx'), 'utf8');
  assert.match(source, /<Tab id="dfu" label="USB\/HID DFU"/);
  assert.match(source, /<div className="dfu-stack">\s*<UsbDfuPage[\s\S]*?<HidPage/);
});
