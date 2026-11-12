const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const { setDataPath, setFetch, isDevMode, getStatus, cleanupStaleProcesses, downloadServers, installMediaWiki, startServers, stopServers } = require('./server-manager');

let mainWindow;
let isQuitting = false;

// Servers, MediaWiki and the database must live in a writable location.
// The install directory (process.resourcesPath) is usually read-only.
// Dev mode keeps its stand-in files in a folder of its own: in the real data
// folder they would look like downloaded servers, and starting those fails.
setDataPath(process.env.HAMICHLOL_DATA_DIR || path.join(app.getPath('userData'), isDevMode() ? 'data-dev' : 'data'));

// Download through Chromium's network stack rather than Node's: it uses the
// proxy and the certificates configured on the computer, which matters behind
// content filters and corporate proxies.
setFetch((url, options) => net.fetch(url, options));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Uncomment for development
  // mainWindow.webContents.openDevTools();
}

function setupApp() {
  app.whenReady().then(() => {
    // Stop servers left running by a previous run that crashed or was killed
    cleanupStaleProcesses().catch(error => console.error('Failed to clean up leftover servers:', error));
    createWindow();

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
}

// Two instances would fight over the same database files and ports, so a
// second instance only focuses the existing window and exits.
if (app.requestSingleInstanceLock()) {
  setupApp();
} else {
  app.quit();
}

// IPC handlers for communication with renderer process
ipcMain.handle('get-status', () => getStatus());

ipcMain.handle('download-servers', async () => {
  try {
    await downloadServers();
    return { success: true };
  } catch (error) {
    console.error('Failed to download servers:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('install-mediawiki', async (event, config) => {
  try {
    await installMediaWiki(config);
    return { success: true };
  } catch (error) {
    console.error('Failed to install MediaWiki:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-servers', async () => {
  try {
    const ports = await startServers();
    return { success: true, ...ports };
  } catch (error) {
    console.error('Failed to start servers:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-servers', async () => {
  try {
    await stopServers();
    return { success: true };
  } catch (error) {
    console.error('Failed to stop servers:', error);
    return { success: false, error: error.message };
  }
});
