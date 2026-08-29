const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'viewport.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const moduleShim = { exports: {} };
new Function('module', 'exports', output)(moduleShim, moduleShim.exports);
const { constrainViewport, zoomViewAt } = moduleShim.exports;

test('260% 放大后四条边都能移动到可视区且不能越过边界', () => {
  const scale = 2.6;
  const left = constrainViewport({ x: 1e9, y: 0, scale });
  const right = constrainViewport({ x: -1e9, y: 0, scale });
  const top = constrainViewport({ x: 0, y: 1e9, scale });
  const bottom = constrainViewport({ x: 0, y: -1e9, scale });

  assert.equal(left.x, 96);
  assert.equal(right.x + 1120 * scale, 1024);
  assert.equal(top.y, 96);
  assert.equal(bottom.y + 900 * scale, 804);
  assert.ok(bottom.y + 846 * scale < 730, '底部 Pin 编号应能移动到画布内部，而不是贴着下边缘');
});

test('常用缩放比例下底部 Pin 编号都有足够的完整显示空间', () => {
  for (const scale of [1, 1.15, 1.5, 2, 2.6]) {
    const bottom = constrainViewport({ x: 0, y: -1e9, scale });
    const bottomPinBaseline = bottom.y + 846 * scale;
    assert.ok(bottomPinBaseline <= 750, `${Math.round(scale * 100)}% 时底部 Pin 仍过于贴近裁剪线：${bottomPinBaseline}`);
  }
});

test('无效平移值不会进入 SVG transform', () => {
  const result = constrainViewport({ x: Number.NaN, y: Number.NaN, scale: Number.NaN });
  assert.equal(Number.isFinite(result.x), true);
  assert.equal(Number.isFinite(result.y), true);
  assert.equal(Number.isFinite(result.scale), true);
});

test('缩放保持鼠标锚点并始终返回有限边界值', () => {
  const result = zoomViewAt({ x: 0, y: 0, scale: 1 }, 0.15, 560, 450);
  assert.equal(result.scale, 1.15);
  assert.equal(Number.isFinite(result.x), true);
  assert.equal(Number.isFinite(result.y), true);
});
