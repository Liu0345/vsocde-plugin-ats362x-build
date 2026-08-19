const assert = require('node:assert/strict');
const test = require('node:test');
const { FlashProgressTracker, FlashRunner, extractFlashPercentages, requiredToolsForFlashCommand, sanitizeTerminalOutput } = require('../dist/services/flashRunner');

test('串口烧录进度解析支持百分比输出', () => {
  const output = 'Preparing...\n12%\nDownloading 45%\nDone 99%';
  assert.deepEqual(extractFlashPercentages(output), [12, 45, 99]);
});

test('串口烧录进度解析支持分子分母进度格式', () => {
  const output = '发送中 250/1000\n发送中 500/1000\n发送中 1000/1000';
  assert.deepEqual(extractFlashPercentages(output), [25, 50, 100]);
});

test('阶段编号不会被误判为传输百分比', () => {
  const output = '[1/3] Initializing storage\n[2/3] Found 5 partitions';
  assert.deepEqual(extractFlashPercentages(output), []);
});

test('输出日志移除 ANSI 颜色控制码并保留正文', () => {
  const raw = '\u001b[2m2026-08-19T11:02:37Z\u001b[0m \u001b[32m INFO\u001b[0m \u001b[2mactions_flash\u001b[0m: READY\n';
  assert.equal(sanitizeTerminalOutput(raw), '2026-08-19T11:02:37Z  INFO actions_flash: READY\n');
});

test('串口烧录进度只按握手、初始化和实际写入递进', () => {
  const tracker = new FlashProgressTracker();
  assert.deepEqual(tracker.push('READY — power on now\n'), [{ percent: 8, detail: '等待设备上电并握手' }]);
  assert.deepEqual(tracker.push('[UART] ✓✓✓ Handshake completed successfully ✓✓✓\n'), [{ percent: 18, detail: '串口握手完成' }]);
  assert.deepEqual(tracker.push('[1/3] Initializing storage...\n'), [{ percent: 25, detail: '正在初始化存储' }]);
  assert.deepEqual(tracker.push('[2/3] Found 4 partitions to upgrade\n'), [{ percent: 30, detail: '准备写入 4 个分区' }]);
  assert.deepEqual(tracker.push('Overall Progress: 25% (250/1000 bytes)\n'), [{ percent: 46, detail: '正在写入固件 25%' }]);
  assert.deepEqual(tracker.push('Overall Progress: 100% (1000/1000 bytes)\n'), [{ percent: 95, detail: '正在提交固件写入' }]);
  assert.deepEqual(tracker.push('OTA Upgrade Completed Successfully\n'), [{ percent: 100, detail: '固件烧录完成' }]);
  assert.deepEqual(tracker.push('Flash succeeded, verifying...\n'), []);
});

test('单个分区写入百分比不会提前触发烧录完成', () => {
  const tracker = new FlashProgressTracker();
  assert.deepEqual(tracker.push('Partition 1/1 [100%]\n'), [{ percent: 95, detail: '正在提交固件写入' }]);
  assert.deepEqual(tracker.push('OTA Upgrade Completed Successfully\n'), [{ percent: 100, detail: '固件烧录完成' }]);
});

test('同一个 FlashRunner 完成后可以立即执行第二次烧录', async () => {
  const runner = new FlashRunner();
  const command = { executable: 'actions-flash', args: ['-e', "console.log('Overall Progress: 50% (1/2 bytes)')"] };
  const toolPaths = { baton: process.execPath, 'actions-flash': process.execPath };
  const first = [];
  const second = [];
  await runner.run(process.cwd(), command, (percent) => first.push(percent), undefined, '烧录', toolPaths);
  await runner.run(process.cwd(), command, (percent) => second.push(percent), undefined, '烧录', toolPaths);
  assert.equal(first.at(-1), 63);
  assert.equal(second.at(-1), 63);
});

test('取消烧录会结束整个任务并释放下一次烧录', async () => {
  const runner = new FlashRunner();
  const toolPaths = { baton: process.execPath, 'actions-flash': process.execPath };
  const running = runner.run(
    process.cwd(),
    { executable: 'actions-flash', args: ['-e', "console.log('READY — power on now'); setInterval(() => {}, 1000)"] },
    undefined,
    undefined,
    '烧录',
    toolPaths
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  runner.cancel();
  await assert.rejects(running, /串口烧录已取消/);
  const progress = [];
  await runner.run(
    process.cwd(),
    { executable: 'actions-flash', args: ['-e', "console.log('Overall Progress: 100% (2/2 bytes)')"] },
    (percent) => progress.push(percent),
    undefined,
    '烧录',
    toolPaths
  );
  assert.equal(progress.at(-1), 95);
});

test('Baton 串口烧录和全擦除执行前同时检查 Baton 与 actions-flash', () => {
  assert.deepEqual(requiredToolsForFlashCommand({ executable: 'baton', args: ['flash', '/tmp/a.bin'] }), ['baton', 'actions-flash']);
  assert.deepEqual(requiredToolsForFlashCommand({ executable: 'baton', args: ['erase-flash'] }), ['baton', 'actions-flash']);
  assert.deepEqual(requiredToolsForFlashCommand({ executable: 'actions-flash', args: ['list'] }), ['actions-flash']);
});
