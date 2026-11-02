const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { setDataPath, downloadServers, installMediaWiki, startServers, stopServers } = require('./server-manager');

let mainWindow;
let isQuitting = false;

// Servers, MediaWiki and the database must live in a writable location.
// The install directory (process.resourcesPath) is usually read-only.
setDataPath(process.env.HAMICHLOL_DATA_DIR || path.join(app.getPath('userData'), 'data'));

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

  // Uncomment for development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
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

// IPC handlers for communication with renderer process
ipcMain.handle('download-servers', async () => {
  try {
    mainWindow.webContents.send('status-update', 'מוריד שרתים...');
    await downloadServers();
    return { success: true };
  } catch (error) {
    console.error('Failed to download servers:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('install-mediawiki', async (event, config) => {
  try {
    mainWindow.webContents.send('status-update', 'מתקין MediaWiki...');
    await installMediaWiki(config);
    return { success: true };
  } catch (error) {
    console.error('Failed to install MediaWiki:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('start-servers', async () => {
  try {
    mainWindow.webContents.send('status-update', 'מפעיל שרתים...');
    const ports = await startServers();
    mainWindow.webContents.send('status-update', 'השרתים פועלים');
    return { success: true, ...ports };
  } catch (error) {
    console.error('Failed to start servers:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-servers', async () => {
  try {
    mainWindow.webContents.send('status-update', 'מכבה שרתים...');
    await stopServers();
    mainWindow.webContents.send('status-update', 'השרתים כבויים');
    return { success: true };
  } catch (error) {
    console.error('Failed to stop servers:', error);
    return { success: false, error: error.message };
  }
});
