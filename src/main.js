const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const serverManager = require('./server-manager');
const { APP_NAME, buildMenuTemplate } = require('./menu');
const { WikiView } = require('./wiki-view');

const { setDataPath, getPaths, getStatus, cleanupStaleProcesses, downloadServers, installMediaWiki, startServers, stopServers } = serverManager;

// Matches the page's background, so the window never flashes white
const WINDOW_BACKGROUND = '#f4f6fa';
const ZOOM_STEP = 0.5;
const MAX_ZOOM_LEVEL = 5;

let mainWindow;
let isQuitting = false;

// What the app is doing now, shared by the page, the menu and the wiki view.
// `busy` is the operation in progress (only one at a time); `error` is the
// failure of the last one: { action, message }.
const appState = { busy: null, error: null };
// Whether the servers were running at the last update, to notice a crash
let serversWereRunning = false;

const wikiView = new WikiView({
  onChange: () => {
    updateWindowTitle();
    sendToPage('wiki-changed', wikiView.describe());
  }
});

// Hebrew user interface for what Chromium draws itself: the menu bar (right to
// left), context menus, dialogs and form validation messages
if (app.commandLine) {
  app.commandLine.appendSwitch('lang', 'he');
}

// Servers, MediaWiki and the database must live in a writable location.
// The install directory (process.resourcesPath) is usually read-only.
setDataPath(process.env.HAMICHLOL_DATA_DIR || path.join(app.getPath('userData'), 'data'));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: WINDOW_BACKGROUND,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const window = mainWindow;
  window.once('ready-to-show', () => window.show());
  // The title follows the wiki page; the app page's own <title> must not reset it
  window.on('page-title-updated', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.webContents.on('did-finish-load', () => syncState());
  window.on('closed', () => {
    if (wikiView.window === window) {
      wikiView.hide();
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
}

function setupApp() {
  app.whenReady().then(() => {
    // Stop servers left running by a previous run that crashed or was killed
    cleanupStaleProcesses().catch(error => console.error('Failed to clean up leftover servers:', error));
    createWindow();
    syncState();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('second-instance', () => {
    if (!mainWindow) {
      // On macOS the app keeps running after its last window was closed
      if (app.isReady()) {
        createWindow();
      }
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Wait for the servers to shut down before the app exits, so MySQL is not left
  // running in the background or killed mid-write.
  app.on('before-quit', async (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    isQuitting = true;
    try {
      await stopServers();
    } catch (error) {
      console.error('Failed to stop servers on quit:', error);
    }
    app.quit();
  });

  // A server that stops on its own (crash, killed from outside)
  serverManager.events.on('change', () => syncState());
}

function sendToPage(channel, message) {
  // The window may be closed while a long operation is still running
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, message);
  }
}

function sendStatus(message) {
  sendToPage('status-update', message);
}

// Everything the page needs to draw itself
function currentState() {
  return { ...getStatus(), busy: appState.busy, error: appState.error, wikiShown: wikiView.isShown() };
}

// Bring the wiki view, the menu and the page in line with the servers' state.
// Called after every operation and whenever a server exits.
function syncState() {
  const status = getStatus();

  if (serversWereRunning && !status.running && !appState.busy) {
    appState.error = { action: 'crash', message: 'השרתים נעצרו באופן בלתי צפוי. אפשר להפעיל אותם שוב.' };
    sendStatus('השרתים נעצרו');
  }
  serversWereRunning = status.running;

  if (status.running && mainWindow && !mainWindow.isDestroyed()) {
    wikiView.show(mainWindow, status.phpPort);
  } else {
    wikiView.hide();
  }
  updateWindowTitle();
  updateMenu(status);
  sendToPage('state-changed', currentState());
}

function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const { title } = wikiView.describe();
  mainWindow.setTitle(title ? `${title} – ${APP_NAME}` : APP_NAME);
}

// The web page the view commands act on: the wiki while it is shown
function targetContents() {
  if (wikiView.isShown()) {
    return wikiView.webContents;
  }
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
}

function changeZoom(change) {
  const contents = targetContents();
  if (!contents) {
    return;
  }
  const level = change === null ? 0 : contents.getZoomLevel() + change;
  contents.setZoomLevel(Math.max(-MAX_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, level)));
}

// ---------------------------------------------------------------------------
// Operations. The page's buttons (through IPC) and the menu run the same code.
// ---------------------------------------------------------------------------

async function runOperation(action, message, task, errorLabel) {
  if (appState.busy) {
    return { success: false, error: 'פעולה אחרת עדיין מתבצעת. יש להמתין לסיומה' };
  }
  appState.busy = action;
  appState.error = null;
  sendStatus(message);
  syncState();
  try {
    const result = await task();
    return { success: true, ...result };
  } catch (error) {
    // The message never holds passwords (see server-manager's runInstaller)
    console.error(`${errorLabel}:`, error.message);
    appState.error = { action, message: error.message };
    return { success: false, error: error.message };
  } finally {
    appState.busy = null;
    // Servers started or stopped by the operation itself are no surprise
    serversWereRunning = getStatus().running;
    syncState();
  }
}

const operations = {
  download: () => runOperation('download', 'מכין שרתים...', async () => {
    await downloadServers();
  }, 'Failed to download servers'),

  install: config => runOperation('install', 'מתקין MediaWiki...', async () => {
    await installMediaWiki(config);
  }, 'Failed to install MediaWiki'),

  start: () => runOperation('start', 'מפעיל שרתים...', async () => {
    const ports = await startServers();
    sendStatus('השרתים פועלים');
    return ports;
  }, 'Failed to start servers'),

  stop: () => runOperation('stop', 'מכבה שרתים...', async () => {
    await stopServers();
    sendStatus('השרתים כבויים');
  }, 'Failed to stop servers'),

  restart: () => runOperation('restart', 'מפעיל מחדש את השרתים...', async () => {
    await stopServers();
    const ports = await startServers();
    sendStatus('השרתים פועלים');
    return ports;
  }, 'Failed to restart servers')
};

const menuActions = {
  start: () => operations.start(),
  stop: () => operations.stop(),
  restart: () => operations.restart(),
  quit: () => app.quit(),
  wikiHome: () => wikiView.goHome(),
  wikiBack: () => wikiView.goBack(),
  wikiForward: () => wikiView.goForward(),
  wikiReload: () => wikiView.reload(),
  wikiOpenExternal: () => wikiView.openInBrowser(),
  zoomIn: () => changeZoom(ZOOM_STEP),
  zoomOut: () => changeZoom(-ZOOM_STEP),
  zoomReset: () => changeZoom(null),
  toggleDevTools: () => {
    const contents = targetContents();
    if (contents) {
      contents.toggleDevTools();
    }
  },
  about: () => {
    const options = {
      type: 'info',
      title: 'אודות',
      message: APP_NAME,
      detail: `גרסה ${app.getVersion()}\nאתר המכלול במחשב שלך, גם בלי חיבור לאינטרנט.`,
      buttons: ['סגור']
    };
    const shown = mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options);
    return Promise.resolve(shown).catch(error => console.error('Failed to show the about box:', error));
  },
  openDataFolder: async () => {
    const { dataPath } = getPaths();
    fs.mkdirSync(dataPath, { recursive: true });
    const problem = await shell.openPath(dataPath);
    if (problem) {
      console.error(`Failed to open ${dataPath}: ${problem}`);
    }
  }
};

function updateMenu(status = getStatus()) {
  const template = buildMenuTemplate(
    { installed: status.installed, running: status.running, busy: appState.busy, wikiShown: wikiView.isShown() },
    menuActions
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Two instances would fight over the same database files and ports, so a
// second instance only focuses the existing window and exits.
if (app.requestSingleInstanceLock()) {
  setupApp();
} else {
  app.quit();
}

// IPC handlers for communication with renderer process
ipcMain.handle('get-status', () => currentState());

ipcMain.handle('download-servers', () => operations.download());

ipcMain.handle('install-mediawiki', (event, config) => operations.install(config));

ipcMain.handle('start-servers', () => operations.start());

ipcMain.handle('stop-servers', () => operations.stop());

ipcMain.handle('restart-servers', () => operations.restart());

// Live feedback on the administrator's name and password, by the same rules
// the installation applies
ipcMain.handle('check-admin-credentials', (event, credentials) => serverManager.checkAdminCredentials(credentials));

// The bar above the wiki
ipcMain.handle('wiki-navigate', (event, where) => {
  const commands = {
    home: menuActions.wikiHome,
    back: menuActions.wikiBack,
    forward: menuActions.wikiForward,
    reload: menuActions.wikiReload,
    external: menuActions.wikiOpenExternal
  };
  if (Object.prototype.hasOwnProperty.call(commands, where)) {
    commands[where]();
  }
  wikiView.focus();
  return wikiView.describe();
});
