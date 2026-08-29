const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('新建编辑区不等待耗时刷新，关闭后再次点击会创建新编辑区', async () => {
  const panels = [];
  const vscodeMock = createVscodeMock(panels);
  const Provider = loadProvider(vscodeMock);
  const provider = createProvider(Provider);
  provider.refresh = async () => new Promise(() => {});

  await provider.openPanel();
  assert.equal(panels.length, 1);
  panels[0].fireDispose();

  await provider.openPanel();

  assert.equal(panels.length, 2);
  assert.equal(provider.panel, panels[1]);
  assert.equal(panels[1].disposed, false);
});

test('连续点击编辑区显示时每一次都会重新聚焦现有面板', async () => {
  const panels = [];
  const vscodeMock = createVscodeMock(panels);
  const Provider = loadProvider(vscodeMock);
  const provider = createProvider(Provider);

  await provider.openPanel();
  await provider.openPanel();
  await provider.openPanel();

  assert.equal(panels.length, 1);
  assert.equal(panels[0].revealCount, 2);
  assert.equal(panels[0].postCount, 4);
});

test('reveal 未报错但消息投递发现旧 Webview 已释放时自动重建', async () => {
  const panels = [];
  const vscodeMock = createVscodeMock(panels);
  const Provider = loadProvider(vscodeMock);
  const provider = createProvider(Provider);
  provider.refresh = async () => {};

  await provider.openPanel();
  panels[0].disposed = true;
  await provider.openPanel();

  assert.equal(panels.length, 2);
  assert.equal(provider.panel, panels[1]);
  assert.equal(panels[0].postCount, 1, '复用前必须真实投递一次消息确认 Webview 存活');
});

test('关闭回调不再访问已释放的 panel.webview，随后点击可立即重建', async () => {
  const panels = [];
  const vscodeMock = createVscodeMock(panels, { throwOnDisposedWebviewAccess: true });
  const Provider = loadProvider(vscodeMock);
  const provider = createProvider(Provider);

  await provider.openPanel();
  assert.doesNotThrow(() => panels[0].fireDispose());
  await provider.openPanel();

  assert.equal(panels.length, 2);
  assert.equal(provider.panel, panels[1]);
});

test('活动栏关闭回调不访问已释放的 view.webview', async () => {
  const panels = [];
  const vscodeMock = createVscodeMock(panels);
  const Provider = loadProvider(vscodeMock);
  const provider = createProvider(Provider);
  const view = createWebviewViewMock();
  provider.refresh = async () => {};

  await provider.resolveWebviewView(view);
  assert.doesNotThrow(() => view.fireDispose());
  assert.equal(provider.view, undefined);
});

test('从当前选项打开编辑区时，新建与复用面板都会跳转到该选项', async () => {
  const panels = [];
  const vscodeMock = createVscodeMock(panels);
  const Provider = loadProvider(vscodeMock);
  const provider = createProvider(Provider);
  provider.refresh = async () => {};

  await provider.openPanel('chip');
  await panels[0].fireMessage({ type: 'ready' });
  assert.deepEqual(panels[0].sentMessages.at(-1), { type: 'navigate', page: 'chip' });

  await provider.openPanel('tools');
  assert.deepEqual(panels[0].sentMessages.at(-1), { type: 'navigate', page: 'tools' });
});

function loadProvider(vscodeMock) {
  const originalLoad = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return vscodeMock;
      return originalLoad.call(this, request, parent, isMain);
    };
    const providerPath = path.join(root, 'dist', 'sidebarProvider.js');
    delete require.cache[require.resolve(providerPath)];
    return require(providerPath).Ats362xSidebarProvider;
  } finally {
    Module._load = originalLoad;
  }
}

function createProvider(Provider) {
  const context = {
    extensionUri: { path: '/extension' },
    subscriptions: { push() {} }
  };
  const projects = {
    selectedProject: undefined,
    recentProjects: [],
    firmwareOverride: undefined
  };
  return new Provider(context, projects);
}

function createVscodeMock(panels, options = {}) {
  return {
    ViewColumn: { Active: 1 },
    Uri: {
      joinPath(_base, ...parts) { return { path: parts.join('/'), toString() { return this.path; } }; }
    },
    workspace: {
      getConfiguration() { return { get(_key, fallback) { return fallback; } }; }
    },
    window: {
      createOutputChannel() { return { append() {}, appendLine() {}, clear() {}, show() {}, dispose() {} }; },
      createWebviewPanel() {
        const disposeListeners = [];
        const messageListeners = [];
        const webview = {
          cspSource: 'test-webview',
          options: {},
          html: '',
          asWebviewUri(uri) { return uri; },
          onDidReceiveMessage(listener) { messageListeners.push(listener); return { dispose() {} }; },
          postMessage(message) {
            panel.postCount += 1;
            panel.sentMessages.push(message);
            return panel.disposed ? Promise.reject(new Error('Webview is disposed')) : Promise.resolve(true);
          }
        };
        const panel = {
          disposed: false,
          postCount: 0,
          revealCount: 0,
          sentMessages: [],
          get webview() {
            if (this.disposed && options.throwOnDisposedWebviewAccess) throw new Error('Webview is disposed');
            return webview;
          },
          reveal() { this.revealCount += 1; },
          onDidDispose(listener) { disposeListeners.push(listener); return { dispose() {} }; },
          async fireMessage(message) { await Promise.all(messageListeners.map((listener) => listener(message))); },
          dispose() { this.fireDispose(); },
          fireDispose() {
            if (!this.disposed) this.disposed = true;
            for (const listener of disposeListeners.splice(0)) listener();
          }
        };
        panels.push(panel);
        return panel;
      }
    }
  };
}

function createWebviewViewMock() {
  const disposeListeners = [];
  const webview = {
    cspSource: 'test-sidebar',
    options: {},
    html: '',
    asWebviewUri(uri) { return uri; },
    onDidReceiveMessage() { return { dispose() {} }; },
    postMessage() { return Promise.resolve(true); }
  };
  return {
    disposed: false,
    get webview() {
      if (this.disposed) throw new Error('Webview is disposed');
      return webview;
    },
    onDidDispose(listener) { disposeListeners.push(listener); return { dispose() {} }; },
    fireDispose() {
      this.disposed = true;
      for (const listener of disposeListeners.splice(0)) listener();
    }
  };
}
