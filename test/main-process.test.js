// The Electron main process (src/main.js), loaded with a stand-in for the
// "electron" module so no window or display is needed. Covers what the main
// process adds on top of the server manager: the IPC interface used by the
// page, error reporting, and the window and quit handling.

const { describe, it, before, after, beforeEach } = require('mocha');
const { expect } = require('chai');
const { EventEmitter } = require('events');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const { VALID_CONFIG, makeTempDir, removeDir, delay, setEnv } = require('./helpers');

const MAIN = require.resolve('../src/main');
const SERVER_MANAGER = require.resolve('../src/server-manager');

function createFakeElectron(tempDir, { gotLock = true } = {}) {
  const windows = [];

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.sent = [];
      this.destroyed = false;
      this.minimized = false;
      this.focused = 0;
      this.webContents = {
        send: (channel, message) => {
          if (this.destroyed) {
            throw new Error('Object has been destroyed');
          }
          this.sent.push([channel, message]);
        }
      };
      windows.push(this);
    }

    loadFile(file) {
      this.loadedFile = file;
    }

    isDestroyed() {
      return this.destroyed;
    }

    isMinimized() {
      if (this.destroyed) {
        throw new Error('Object has been destroyed');
      }
      return this.minimized;
    }

    restore() {
      this.minimized = false;
    }

    focus() {
      this.focused += 1;
    }

    // What Electron does when the user closes the window
    close() {
      this.destroyed = true;
      this.emit('closed');
    }

    static getAllWindows() {
      return windows.filter(window => !window.destroyed);
    }
  }

  const app = new EventEmitter();
  app.quitCalls = 0;
  app.quit = () => {
    app.quitCalls += 1;
  };
  app.requestSingleInstanceLock = () => gotLock;
  app.getPath = name => path.join(tempDir, name);
  app.isReady = () => true;
  app.whenReady = () => Promise.resolve();

  const handlers = {};
  const ipcMain = {
    handle: (channel, handler) => {
      handlers[channel] = handler;
    }
  };

  // Chromium's network stack, which the app downloads through
  const netRequests = [];
  const net = {
    fetch: async (url, options) => {
      netRequests.push([url, options]);
      return new Response('from electron net');
    }
  };

  return { electron: { app, BrowserWindow, ipcMain, net }, app, windows, handlers, netRequests };
}

describe('Electron main process', function() {
  this.timeout(20000);

  let tempDir;
  let restoreEnv;
  let originalLoad;
  let fake;
  let serverManager;

  // Load a fresh copy of main.js (and of the server manager it configures)
  // against a fake Electron.
  async function loadMain(options) {
    fake = createFakeElectron(tempDir, options);
    delete require.cache[MAIN];
    delete require.cache[SERVER_MANAGER];
    Module._load = function(request, ...rest) {
      return request === 'electron' ? fake.electron : originalLoad.call(this, request, ...rest);
    };
    try {
      require(MAIN);
    } finally {
      Module._load = originalLoad;
    }
    serverManager = require(SERVER_MANAGER);
    await delay(20); // let app.whenReady() callbacks run
    return fake;
  }

  const invoke = (channel, ...args) => fake.handlers[channel]({}, ...args);

  before(function() {
    originalLoad = Module._load;
  });

  beforeEach(async function() {
    if (serverManager) {
      await serverManager.stopServers();
    }
    removeDir(tempDir);
    tempDir = makeTempDir('main');
    if (restoreEnv) {
      restoreEnv();
    }
    restoreEnv = setEnv({ DEV_MODE: 'true', HAMICHLOL_DATA_DIR: undefined });
  });

  after(async function() {
    if (serverManager) {
      await serverManager.stopServers();
    }
    // Later suites must get the instance they required at load time back
    delete require.cache[MAIN];
    if (restoreEnv) {
      restoreEnv();
    }
    removeDir(tempDir);
  });

  describe('Start-up', function() {
    it('should open one window showing the app page', async function() {
      const { windows } = await loadMain();

      expect(windows).to.have.lengthOf(1);
      expect(windows[0].loadedFile).to.equal(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    });

    it('should keep its data in the user data folder, not next to the program', async function() {
      process.env.DEV_MODE = 'false';
      await loadMain();

      expect(serverManager.getPaths().dataPath).to.equal(path.join(tempDir, 'userData', 'data'));
    });

    it('should keep dev mode\'s stand-in files apart from the real data', async function() {
      // In the real data folder they would be taken for downloaded servers
      await loadMain();

      expect(serverManager.getPaths().dataPath).to.equal(path.join(tempDir, 'userData', 'data-dev'));
    });

    it('should use HAMICHLOL_DATA_DIR when it is set', async function() {
      process.env.HAMICHLOL_DATA_DIR = path.join(tempDir, 'custom');
      await loadMain();

      expect(serverManager.getPaths().dataPath).to.equal(path.join(tempDir, 'custom'));
    });

    it('should download through Electron\'s network stack', async function() {
      await loadMain();
      const target = path.join(tempDir, 'file.bin');
      fs.mkdirSync(tempDir, { recursive: true });

      // Any failure here would come after the request was made; only the
      // route the request takes matters
      await serverManager._internal.downloadAndExtract(['https://example.invalid/a.zip'], target).catch(() => {});

      expect(fake.netRequests).to.deep.equal([['https://example.invalid/a.zip', { redirect: 'follow' }]]);
    });

    it('should not push messages the page does not listen to', async function() {
      await loadMain();
      const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

      await invoke('download-servers');
      await invoke('stop-servers');

      expect(fake.windows[0].sent).to.deep.equal([]);
      expect(page).to.not.include('ipcRenderer.on(');
    });

    it('should register every channel the page uses', async function() {
      await loadMain();
      const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
      const used = [...page.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]);

      expect(used).to.not.be.empty;
      for (const channel of new Set(used)) {
        expect(fake.handlers, channel).to.have.property(channel);
      }
    });

    it('should quit at once when another instance is already running', async function() {
      const { app, windows } = await loadMain({ gotLock: false });

      expect(app.quitCalls).to.equal(1);
      expect(windows).to.have.lengthOf(0);
    });
  });

  describe('Requests from the page', function() {
    beforeEach(() => loadMain());

    it('should report the current status', async function() {
      const status = await invoke('get-status');

      expect(status).to.include({ downloaded: false, installed: false, running: false, devMode: true });
      expect(status.tools).to.have.keys(['php', 'database', 'mediawiki']);
      expect(status.versions).to.have.keys(['php', 'mariadb', 'mediawiki']);
    });

    it('should return a status the page can receive (plain data only)', async function() {
      const status = await invoke('get-status');
      expect(JSON.parse(JSON.stringify(status))).to.deep.equal(status);
    });

    it('should run the three steps and report success for each', async function() {
      expect(await invoke('download-servers')).to.deep.equal({ success: true });
      expect((await invoke('get-status')).downloaded).to.be.true;

      expect(await invoke('install-mediawiki', VALID_CONFIG)).to.deep.equal({ success: true });
      expect((await invoke('get-status')).installed).to.be.true;

      const started = await invoke('start-servers');
      expect(started.success).to.be.true;
      expect(started.phpPort).to.be.a('number');
      expect(started.mysqlPort).to.be.a('number');
      expect(await invoke('get-status')).to.include({ running: true, phpPort: started.phpPort });

      expect(await invoke('stop-servers')).to.deep.equal({ success: true });
      expect((await invoke('get-status')).running).to.be.false;
    });

    it('should return errors as data instead of throwing', async function() {
      const tooEarly = await invoke('start-servers');
      expect(tooEarly.success).to.be.false;
      expect(tooEarly.error).to.be.a('string').and.not.empty;

      await invoke('download-servers');
      const invalid = await invoke('install-mediawiki', { ...VALID_CONFIG, adminPassword: 'short' });
      expect(invalid.success).to.be.false;
      expect(invalid.error).to.include('10');

      const missing = await invoke('install-mediawiki', undefined);
      expect(missing.success).to.be.false;
    });

    it('should keep working when the window was closed during an operation', async function() {
      fake.windows[0].close();

      expect(await invoke('download-servers')).to.deep.equal({ success: true });
      expect(await invoke('stop-servers')).to.deep.equal({ success: true });
    });
  });

  describe('Windows and quitting', function() {
    beforeEach(() => loadMain());

    it('should focus the existing window when the app is started again', function() {
      const [window] = fake.windows;
      window.minimized = true;

      fake.app.emit('second-instance');

      expect(window.minimized).to.be.false;
      expect(window.focused).to.equal(1);
      expect(fake.windows).to.have.lengthOf(1);
    });

    it('should open a new window when started again after its window was closed', function() {
      fake.windows[0].close();

      fake.app.emit('second-instance');

      expect(fake.windows).to.have.lengthOf(2);
      expect(fake.windows[1].loadedFile).to.include('index.html');
    });

    it('should open a window when activated with none open', function() {
      fake.app.emit('activate');
      expect(fake.windows).to.have.lengthOf(1);

      fake.windows[0].close();
      fake.app.emit('activate');
      expect(fake.windows).to.have.lengthOf(2);
    });

    it('should quit when the last window closes, except on macOS', function() {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      try {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        fake.app.emit('window-all-closed');
        expect(fake.app.quitCalls).to.equal(0);

        Object.defineProperty(process, 'platform', { value: 'win32' });
        fake.app.emit('window-all-closed');
        expect(fake.app.quitCalls).to.equal(1);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });

    it('should stop the servers before it lets the app quit', async function() {
      await invoke('download-servers');
      await invoke('install-mediawiki', VALID_CONFIG);
      const { phpPort } = await invoke('start-servers');
      expect((await fetch(`http://127.0.0.1:${phpPort}/`)).status).to.equal(200);

      let prevented = 0;
      fake.app.emit('before-quit', { preventDefault: () => { prevented += 1; } });

      // The first attempt is held back while the servers are still running...
      expect(prevented).to.equal(1);
      expect(fake.app.quitCalls).to.equal(0);

      // ...and the app quits by itself once they have stopped
      for (let i = 0; i < 100 && fake.app.quitCalls === 0; i++) {
        await delay(20);
      }
      expect(fake.app.quitCalls).to.equal(1);
      expect(serverManager.getStatus().running).to.be.false;
      const stillServing = await fetch(`http://127.0.0.1:${phpPort}/`).then(() => true, () => false);
      expect(stillServing).to.be.false;
    });

    it('should let the second quit attempt through', async function() {
      fake.app.emit('before-quit', { preventDefault: () => {} });
      for (let i = 0; i < 100 && fake.app.quitCalls === 0; i++) {
        await delay(20);
      }

      let prevented = 0;
      fake.app.emit('before-quit', { preventDefault: () => { prevented += 1; } });

      expect(prevented).to.equal(0);
      expect(fake.app.quitCalls).to.equal(1);
    });
  });
});
