const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { createBackendProcessController } = require('./backend-process-controller');
const { createBackendLaunchSpec, getWindowIcon, shouldCreateWindow } = require('./platform');

let mainWindow;
let backendShutdownComplete = false;
let backendShutdownPromise = null;
let restartInProgress = null;

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const isSmokeTest = !shouldCreateWindow(process.env);
const backendController = createBackendProcessController();

// This runs before Electron's ready event. Package smoke tests exercise the
// actual main process and frozen backend without requiring a display/GPU.
if (isSmokeTest) app.disableHardwareAcceleration();

function getBackendSpec() {
  return createBackendLaunchSpec({
    platform: process.platform,
    isDev,
    resourcesPath: process.resourcesPath,
    getAppPath: app.getPath.bind(app),
    backendDir: path.join(__dirname, '../../backend'),
    env: process.env,
    exists: fs.existsSync,
  });
}

function startBackend() {
  return backendController.start(getBackendSpec());
}

function restartBackend() {
  if (!restartInProgress) {
    restartInProgress = backendController
      .restart(getBackendSpec())
      .finally(() => {
        restartInProgress = null;
      });
  }
  return restartInProgress;
}

function stopBackend() {
  return backendController.stop();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: getWindowIcon({
      platform: process.platform,
      assetsDir: path.join(__dirname, '../assets'),
    }),
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  let initialLoadComplete = false;
  let controllerInitiatedReload = false;

  const restartThenReload = async () => {
    try {
      await restartBackend();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      controllerInitiatedReload = true;
      mainWindow.webContents.reloadIgnoringCache();
    } catch (error) {
      console.error('Backend restart failed:', error);
    }
  };

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    const reloadShortcut =
      input.type === 'keyDown' &&
      (key === 'f5' || ((input.control || input.meta) && key === 'r'));
    if (!reloadShortcut) return;
    event.preventDefault();
    void restartThenReload();
  });

  mainWindow.webContents.on(
    'did-start-navigation',
    (_event, _url, isInPlace, isMainFrame) => {
      if (!initialLoadComplete || !isMainFrame || isInPlace) return;
      if (controllerInitiatedReload) {
        controllerInitiatedReload = false;
        return;
      }
      // Covers menu/programmatic reloads that bypass the keyboard handler.
      void restartBackend().catch((error) =>
        console.error('Backend restart failed during navigation:', error),
      );
    },
  );

  mainWindow.webContents.once('did-finish-load', () => {
    initialLoadComplete = true;
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startBackend();
  if (isSmokeTest) return;
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (backendShutdownComplete) return;
  event.preventDefault();
  if (backendShutdownPromise) return;
  backendShutdownPromise = stopBackend()
    .then(() => {
      backendShutdownComplete = true;
      app.quit();
    })
    .catch((error) => {
      backendShutdownPromise = null;
      console.error('Could not terminate the backend process tree:', error);
    });
});

// --- IPC handlers ---
ipcMain.handle('open-folder', async (_e, folderPath) => {
  if (folderPath) shell.openPath(folderPath);
});

ipcMain.handle('show-notification', (_e, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});
