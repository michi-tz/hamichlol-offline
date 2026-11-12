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
const { findItem } = require('../src/menu');
const { WIKI_BAR_HEIGHT } = require('../src/wiki-view');

const MAIN = require.resolve('../src/main');
const SERVER_MANAGER = require.resolve('../src/server-manager');
// Modules that take what they need from "electron" when they are loaded
const ELECTRON_USERS = [MAIN, require.resolve('../src/wiki-view'), require.resolve('../src/menu')];

// A stand-in for a page's webContents: records what is sent to it and the
// handlers registered on it
class FakeWebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.sent = [];
    this.url = '';
    this.title = '';
    this.history = [];
    this.historyIndex = -1;
    this.zoomLevel = 0;
    this.devToolsToggled = 0;
    this.closed = false;
    this.focused = 0;
    this.permissionHandler = null;
    this.session = {
      setPermissionRequestHandler: handler => {
        this.permissionHandler = handler;
      }
    };
  }

  send(channel, message) {
    if (this.owner.destroyed) {
      throw new Error('Object has been destroyed');
    }
    this.sent.push([channel, message]);
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  loadURL(url) {
    this.history = this.history.slice(0, this.historyIndex + 1).concat(url);
    this.historyIndex = this.history.length - 1;
    this.url = url;
    this.emit('did-navigate');
    return Promise.resolve();
  }

  getURL() { return this.url; }
  getTitle() { return this.title; }
  canGoBack() { return this.historyIndex > 0; }
  canGoForward() { return this.historyIndex < this.history.length - 1; }
  goBack() { this.historyIndex -= 1; this.url = this.history[this.historyIndex]; }
  goForward() { this.historyIndex += 1; this.url = this.history[this.historyIndex]; }
  reload() { this.reloaded = (this.reloaded || 0) + 1; }
  focus() { this.focused += 1; }
  getZoomLevel() { return this.zoomLevel; }
  setZoomLevel(level) { this.zoomLevel = level; }
  toggleDevTools() { this.devToolsToggled += 1; }
  isDestroyed() { return this.closed; }
  close() { this.closed = true; }
}

function createFakeElectron(tempDir, { gotLock = true } = {}) {
  const windows = [];
  const views = [];

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.minimized = false;
      this.focused = 0;
      this.shown = false;
      this.title = options.title;
      this.contentSize = [options.width, options.height - 25];
      this.browserView = null;
      this.webContents = new FakeWebContents(this);
      windows.push(this);
    }

    // Sent messages, in the order they were sent
    get sent() {
      return this.webContents.sent;
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

    show() {
      this.shown = true;
    }

    setTitle(title) {
      this.title = title;
    }

    getTitle() {
      return this.title;
    }

    getContentSize() {
      return this.contentSize;
    }

    setBrowserView(view) {
      this.browserView = view;
    }

    getBrowserView() {
      return this.browserView;
    }

    removeBrowserView(view) {
      if (this.browserView === view) {
        this.browserView = null;
      }
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

  class BrowserView {
    constructor(options) {
      this.options = options;
      this.bounds = null;
      this.webContents = new FakeWebContents(this);
      views.push(this);
    }

    setBounds(bounds) {
      this.bounds = bounds;
    }

    getBounds() {
      return this.bounds;
    }

    setBackgroundColor(color) {
      this.backgroundColor = color;
    }
  }

  const app = new EventEmitter();
  app.quitCalls = 0;
  app.quit = () => {
    app.quitCalls += 1;
  };
  app.requestSingleInstanceLock = () => gotLock;
  app.getPath = name => path.join(tempDir, name);
  app.getVersion = () => '1.2.3';
  app.isReady = () => true;
  app.whenReady = () => Promise.resolve();
  app.switches = {};
  app.commandLine = {
    appendSwitch: (name, value) => {
      app.switches[name] = value;
    }
  };

  const handlers = {};
  const ipcMain = {
    handle: (channel, handler) => {
      handlers[channel] = handler;
    }
  };

  // The menu as the app last set it: the template it was built from
  const menu = { current: null, builds: 0 };
  const Menu = {
    buildFromTemplate: template => {
      menu.builds += 1;
      return { template };
    },
    setApplicationMenu: built => {
      menu.current = built.template;
    }
  };

  const shell = {
    opened: [],
    openedPaths: [],
    openExternal: url => {
      shell.opened.push(url);
      return Promise.resolve();
    },
    openPath: dir => {
      shell.openedPaths.push(dir);
      return Promise.resolve('');
    }
  };

  const dialog = {
    shown: [],
    showMessageBox: (...args) => {
      dialog.shown.push(args[args.length - 1]);
      return Promise.resolve({ response: 0 });
    }
  };

  return {
    electron: { app, BrowserWindow, BrowserView, Menu, ipcMain, shell, dialog },
    app,
    windows,
    views,
    handlers,
    menu,
    shell,
    dialog
  };
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
    for (const module of [...ELECTRON_USERS, SERVER_MANAGER]) {
      delete require.cache[module];
    }
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
  const statusMessages = window => window.sent.filter(([channel]) => channel === 'status-update').map(([, message]) => message);
  const stateUpdates = window => window.sent.filter(([channel]) => channel === 'state-changed').map(([, state]) => state);

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
    for (const module of ELECTRON_USERS) {
      delete require.cache[module];
    }
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
      await loadMain();

      expect(serverManager.getPaths().dataPath).to.equal(path.join(tempDir, 'userData', 'data'));
    });

    it('should use HAMICHLOL_DATA_DIR when it is set', async function() {
      process.env.HAMICHLOL_DATA_DIR = path.join(tempDir, 'custom');
      await loadMain();

      expect(serverManager.getPaths().dataPath).to.equal(path.join(tempDir, 'custom'));
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

    it('should tell the page what it is doing', async function() {
      await invoke('download-servers');
      await invoke('install-mediawiki', VALID_CONFIG);
      await invoke('start-servers');
      await invoke('stop-servers');

      const messages = statusMessages(fake.windows[0]);
      expect(messages).to.have.lengthOf(6);
      expect(messages[2]).to.include('מפעיל');
      expect(messages[3]).to.include('פועלים');
      expect(messages[5]).to.include('כבויים');
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

    it('should not report "running" after a failed start', async function() {
      await invoke('start-servers');

      const messages = statusMessages(fake.windows[0]);
      expect(messages.some(message => message.includes('פועלים'))).to.be.false;
    });

    it('should keep working when the window was closed during an operation', async function() {
      fake.windows[0].close();

      expect(await invoke('download-servers')).to.deep.equal({ success: true });
      expect(await invoke('stop-servers')).to.deep.equal({ success: true });
    });
  });

  describe('The window', function() {
    beforeEach(() => loadMain());

    it('should only appear once its page is ready, with a fitting size, title and background', function() {
      const [window] = fake.windows;

      expect(window.options).to.include({ show: false, title: 'המכלול אופליין' });
      expect(window.options.minWidth).to.be.within(600, window.options.width);
      expect(window.options.minHeight).to.be.within(400, window.options.height);
      expect(window.options.backgroundColor).to.match(/^#[0-9a-f]{6}$/i);
      expect(window.shown).to.be.false;

      window.emit('ready-to-show');
      expect(window.shown).to.be.true;
    });

    it('should ask Chromium for a Hebrew (right-to-left) interface', function() {
      expect(fake.app.switches).to.include({ lang: 'he' });
    });

    it('should keep the app page apart from the wiki: no title changes from the page', function() {
      let prevented = false;
      fake.windows[0].emit('page-title-updated', { preventDefault: () => { prevented = true; } });
      expect(prevented).to.be.true;
    });
  });

  describe('Application menu', function() {
    beforeEach(() => loadMain());

    const item = id => findItem(fake.menu.current, id);
    const labels = () => fake.menu.current.map(entry => entry.label);

    it('should replace the default menu with a Hebrew one', function() {
      expect(fake.menu.current).to.be.an('array');
      expect(labels()).to.include.members(['שרתים', 'ויקי', 'סנכרון', 'תצוגה', 'עריכה', 'עזרה']);
    });

    it('should enable only what can be done in each state', async function() {
      expect(item('start').enabled, 'start before install').to.be.false;
      expect(item('stop').enabled).to.be.false;
      expect(item('wikiHome').enabled).to.be.false;

      await invoke('download-servers');
      await invoke('install-mediawiki', VALID_CONFIG);
      expect(item('start').enabled).to.be.true;
      expect(item('stop').enabled).to.be.false;
      expect(item('restart').enabled).to.be.false;

      await invoke('start-servers');
      expect(item('start').enabled).to.be.false;
      expect(item('stop').enabled).to.be.true;
      expect(item('restart').enabled).to.be.true;
      for (const id of ['wikiHome', 'wikiBack', 'wikiForward', 'wikiReload', 'wikiOpenExternal']) {
        expect(item(id).enabled, id).to.be.true;
      }

      await invoke('stop-servers');
      expect(item('start').enabled).to.be.true;
      expect(item('wikiHome').enabled).to.be.false;
    });

    it('should disable the server commands while an operation runs', async function() {
      await invoke('download-servers');
      await invoke('install-mediawiki', VALID_CONFIG);

      const starting = invoke('start-servers');
      expect(item('start').enabled).to.be.false;
      expect(item('stop').enabled).to.be.false;
      // A second operation at the same time is refused, not run
      const second = await invoke('stop-servers');
      expect(second.success).to.be.false;

      expect((await starting).success).to.be.true;
      expect(item('stop').enabled).to.be.true;
    });

    it('should start and stop the servers from the menu, like the buttons do', async function() {
      await invoke('download-servers');
      await invoke('install-mediawiki', VALID_CONFIG);

      await item('start').click();
      expect(serverManager.getStatus().running).to.be.true;
      expect(statusMessages(fake.windows[0])).to.include('השרתים פועלים');
      const lastState = stateUpdates(fake.windows[0]).pop();
      expect(lastState).to.include({ running: true, busy: null, wikiShown: true });

      await item('restart').click();
      expect(serverManager.getStatus().running).to.be.true;

      await item('stop').click();
      expect(serverManager.getStatus().running).to.be.false;
      expect(stateUpdates(fake.windows[0]).pop()).to.include({ running: false, wikiShown: false });
    });

    it('should only offer site synchronisation as a disabled placeholder', function() {
      const sync = fake.menu.current.find(entry => entry.label === 'סנכרון');
      expect(sync.submenu).to.not.be.empty;
      for (const entry of sync.submenu) {
        expect(entry.enabled, entry.label).to.be.false;
        expect(entry.click).to.be.undefined;
      }
    });

    it('should show an about box with the version', async function() {
      await item('about').click();
      expect(fake.dialog.shown).to.have.lengthOf(1);
      expect(fake.dialog.shown[0].message).to.equal('המכלול אופליין');
      expect(fake.dialog.shown[0].detail).to.include('1.2.3');
    });

    it('should open the data folder', async function() {
      await item('openDataFolder').click();
      expect(fake.shell.openedPaths).to.deep.equal([serverManager.getPaths().dataPath]);
      expect(fs.existsSync(serverManager.getPaths().dataPath)).to.be.true;
    });

    it('should zoom the setup page, or the wiki while it is shown', async function() {
      const [window] = fake.windows;
      await item('zoomIn').click();
      expect(window.webContents.zoomLevel).to.be.above(0);
      await item('zoomReset').click();
      expect(window.webContents.zoomLevel).to.equal(0);

      await invoke('download-servers');
      await invoke('install-mediawiki', VALID_CONFIG);
      await invoke('start-servers');
      const view = window.getBrowserView();
      await item('zoomOut').click();
      expect(view.webContents.zoomLevel).to.be.below(0);
      expect(window.webContents.zoomLevel).to.equal(0);
      await item('devTools').click();
      expect(view.webContents.devToolsToggled).to.equal(1);
    });
  });

  describe('The wiki', function() {
    let window;
    let phpPort;

    beforeEach(async function() {
      await loadMain();
      [window] = fake.windows;
      await invoke('download-servers');
      await invoke('install-mediawiki', VALID_CONFIG);
      ({ phpPort } = await invoke('start-servers'));
    });

    const view = () => window.getBrowserView();

    it('should fill the window below the bar in its own locked-down view', function() {
      expect(view()).to.exist;
      expect(view().options.webPreferences).to.include({ nodeIntegration: false, contextIsolation: true, sandbox: true });
      expect(view().webContents.getURL()).to.equal(`http://127.0.0.1:${phpPort}/`);

      const [width, height] = window.getContentSize();
      expect(view().getBounds()).to.deep.equal({ x: 0, y: WIKI_BAR_HEIGHT, width, height: height - WIKI_BAR_HEIGHT });
    });

    it('should follow the size of the window', function() {
      window.contentSize = [900, 600];
      window.emit('resize');
      expect(view().getBounds()).to.deep.equal({ x: 0, y: WIKI_BAR_HEIGHT, width: 900, height: 600 - WIKI_BAR_HEIGHT });
    });

    it('should open addresses outside the wiki in the system browser', function() {
      const contents = view().webContents;
      const navigate = url => {
        let prevented = false;
        contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url);
        return prevented;
      };

      expect(navigate(`http://127.0.0.1:${phpPort}/index.php?title=Test`)).to.be.false;
      expect(navigate(`http://localhost:${phpPort}/index.php`)).to.be.false;
      expect(navigate('https://www.hamichlol.org.il/')).to.be.true;
      expect(navigate(`http://127.0.0.1:${phpPort + 1}/`)).to.be.true;
      expect(navigate('file:///etc/passwd')).to.be.true;
      expect(navigate('javascript:alert(1)')).to.be.true;

      // Only web addresses are handed to the system
      expect(fake.shell.opened).to.deep.equal(['https://www.hamichlol.org.il/', `http://127.0.0.1:${phpPort + 1}/`]);
    });

    it('should never open new windows', function() {
      const contents = view().webContents;
      expect(contents.windowOpenHandler({ url: 'https://example.org/' })).to.deep.equal({ action: 'deny' });
      expect(fake.shell.opened).to.deep.equal(['https://example.org/']);

      // A wiki page that asks for a new window opens in the view instead
      const internal = `http://127.0.0.1:${phpPort}/index.php?title=Other`;
      expect(contents.windowOpenHandler({ url: internal })).to.deep.equal({ action: 'deny' });
      expect(contents.getURL()).to.equal(internal);
      expect(fake.windows).to.have.lengthOf(1);
    });

    it('should refuse every permission request of the wiki', function() {
      let granted = null;
      view().webContents.permissionHandler(view().webContents, 'media', allowed => { granted = allowed; });
      expect(granted).to.be.false;
    });

    it('should show a Hebrew error page when the wiki cannot be loaded', function() {
      const contents = view().webContents;
      contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', contents.getURL(), true);

      expect(contents.getURL()).to.match(/^data:text\/html/);
      const page = decodeURIComponent(contents.getURL().split(',').slice(1).join(','));
      expect(page).to.include('לא ניתן לטעון את הוויקי');
      expect(page).to.include(`http://127.0.0.1:${phpPort}/`);
    });

    it('should navigate from the bar', async function() {
      const contents = view().webContents;
      contents.loadURL(`http://127.0.0.1:${phpPort}/index.php?title=Other`);

      const afterBack = await invoke('wiki-navigate', 'back');
      expect(contents.getURL()).to.equal(`http://127.0.0.1:${phpPort}/`);
      expect(afterBack).to.include({ shown: true, canGoBack: false, canGoForward: true });

      await invoke('wiki-navigate', 'external');
      expect(fake.shell.opened).to.deep.equal([`http://127.0.0.1:${phpPort}/`]);

      await invoke('wiki-navigate', 'nonsense');
      await invoke('wiki-navigate', 'home');
      expect(contents.getURL()).to.equal(`http://127.0.0.1:${phpPort}/`);
    });

    it('should show the title of the wiki page in the window title', function() {
      view().webContents.title = 'עמוד ראשי';
      view().webContents.emit('page-title-updated');
      expect(window.getTitle()).to.equal('עמוד ראשי – המכלול אופליין');
    });

    it('should remove the wiki once the servers are stopped', async function() {
      const { webContents } = view();
      await invoke('stop-servers');

      expect(view()).to.be.null;
      expect(webContents.closed).to.be.true;
      expect(window.getTitle()).to.equal('המכלול אופליין');
    });

    it('should notice servers that stop by themselves', async function() {
      const { webContents } = view();

      // As if the servers had died: they stop without the app asking
      await serverManager.stopServers();
      serverManager.events.emit('change');

      expect(view()).to.be.null;
      expect(webContents.closed).to.be.true;
      const state = stateUpdates(window).pop();
      expect(state).to.include({ running: false, wikiShown: false });
      expect(state.error).to.include({ action: 'crash' });
      expect(findItem(fake.menu.current, 'start').enabled).to.be.true;
      expect((await invoke('get-status')).error).to.include({ action: 'crash' });

      // Starting again clears the error
      await invoke('start-servers');
      expect((await invoke('get-status')).error).to.be.null;
    });

    it('should show the wiki again in a window that is opened again', async function() {
      window.close();
      fake.app.emit('activate');
      const [, second] = fake.windows;

      second.webContents.emit('did-finish-load');
      expect(second.getBrowserView()).to.exist;
      expect(second.getBrowserView().webContents.getURL()).to.equal(`http://127.0.0.1:${phpPort}/`);
    });
  });

  describe('Checking the administrator account', function() {
    beforeEach(() => loadMain());

    it('should report every password rule to the page', async function() {
      const result = await invoke('check-admin-credentials', { adminUser: 'admin', adminPassword: 'short' });

      expect(result.usernameError).to.be.null;
      expect(result.canonicalUsername).to.equal('Admin');
      expect(result.passwordError).to.include('10');
      const rules = Object.fromEntries(result.passwordRules.map(rule => [rule.id, rule]));
      expect(rules.minLength.ok).to.be.false;
      expect(rules.notInUsername.ok).to.be.true;
      expect(JSON.parse(JSON.stringify(result))).to.deep.equal(result);
    });

    it('should use the common password list of the downloaded MediaWiki', async function() {
      const before = await invoke('check-admin-credentials', { adminUser: 'admin', adminPassword: '1234567890' });
      expect(before.passwordRules.find(rule => rule.id === 'notCommon').skipped).to.be.true;

      await invoke('download-servers');
      const after = await invoke('check-admin-credentials', { adminUser: 'admin', adminPassword: '1234567890' });
      expect(after.passwordRules.find(rule => rule.id === 'notCommon')).to.include({ ok: false, skipped: false });
      expect(after.passwordError).to.include('נפוצות');
    });

    it('should report a bad user name', async function() {
      const result = await invoke('check-admin-credentials', { adminUser: 'ad|min', adminPassword: 'admin-password-123' });
      expect(result.usernameError).to.include('|');
      expect(result.canonicalUsername).to.be.null;
    });

    it('should cope with missing values', async function() {
      const result = await invoke('check-admin-credentials', undefined);
      expect(result.usernameError).to.be.a('string');
      expect(result.passwordError).to.be.a('string');
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
