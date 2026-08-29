const assert = require('node:assert/strict');
const test = require('node:test');

const { isWebviewDisposedError, WebviewRegistry } = require('../dist/services/webviewRegistry.js');

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test('异步投递遇到已销毁 Webview 时静默移除且不产生未处理拒绝', async () => {
  const unexpected = [];
  const registry = new WebviewRegistry((error) => unexpected.push(error));
  registry.register({
    postMessage: () => Promise.reject(new Error('Webview is disposed'))
  });

  registry.post({ type: 'state' });
  await flushPromises();

  assert.equal(registry.size, 0);
  assert.deepEqual(unexpected, []);
});

test('同步投递遇到已销毁 Webview 时也会静默移除', () => {
  const registry = new WebviewRegistry();
  registry.register({
    postMessage: () => {
      throw new Error('Webview is disposed');
    }
  });

  assert.doesNotThrow(() => registry.post({ type: 'notice' }));
  assert.equal(registry.size, 0);
});

test('非生命周期错误仍上报并移除故障目标', async () => {
  const unexpected = [];
  const failure = new Error('transport failed');
  const registry = new WebviewRegistry((error) => unexpected.push(error));
  registry.register({ postMessage: () => Promise.reject(failure) });

  registry.post({ type: 'state' });
  await flushPromises();

  assert.equal(registry.size, 0);
  assert.deepEqual(unexpected, [failure]);
  assert.equal(isWebviewDisposedError(failure), false);
  assert.equal(isWebviewDisposedError('Webview is disposed'), true);
  assert.equal(isWebviewDisposedError('Webview panel is disposed'), true);
  assert.equal(isWebviewDisposedError('Calling reveal on disposed panel'), true);
});
