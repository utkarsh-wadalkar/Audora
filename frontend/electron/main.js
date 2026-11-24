const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createBackendProcessController } = require('./backend-process-controller');
const {
  TOKEN_HEADER, backendRequestHeaders, externalWebUrl, isTrustedRenderer, isTrustedSender, rendererDocument,
} = require('./desktop-access');
const { createBackendLaunchSpec, getWindowIcon, shouldCreateWindow } = require('./platform');
const { createUpdater } = require('./updater');

let mainWindow;
let backendShutdownComplete = false;
let backendShutdownPromise = null;
let restartInProgress = null;
let desktopUpdater;
let updateRestarting = false;
const rendererPath = path.join(__dirname, '../dist/index.html');

const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
const isSmokeTest = !shouldCreateWindow(process.env);
const rendererUrl = rendererDocument(isDev ? process.env.VITE_DEV_SERVER_URL : pathToFileURL(rendererPath).href);
const requestedPort = Number(process.env.AUDORA_BACKEND_PORT);
const backendPort = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
  ? String(requestedPort)
  : '8000';
const desktopToken = (isSmokeTest && process.env.AUDORA_SMOKE_TOKEN) || randomBytes(32).toString('hex');
const backendController = createBackendProcessController();

// This runs before Electron's ready event. Package smoke tests exercise the
// actual main process and frozen backend without requiring a display/GPU.
if (isSmokeTest) app.disableHardwareAcceleration();
if (isSmokeTest && process.env.AUDORA_SMOKE_PROFILE) {
  app.setPath('userData', process.env.AUDORA_SMOKE_PROFILE);
}
const ownsProfile = isDev || isSmokeTest || app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function getBackendSpec() {
  return createBackendLaunchSpec({
    platform: process.platform,
    isDev,
    resourcesPath: process.resourcesPath,
    getAppPath: app.getPath.bind(app),
    backendDir: path.join(__dirname, '../../backend'),
    env: { ...process.env, AUDORA_BACKEND_PORT: backendPort, AUDORA_DESKTOP_TOKEN: desktopToken },
    exists: fs.existsSync,
  });
}

function startBackend() {
  return backendController.start(getBackendSpec());
}

function restartBackend() {
  if (updateRestarting) return Promise.resolve();
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
      sandbox: true,
      additionalArguments: [`--audora-backend-port=${backendPort}`],
    },
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  const contents = mainWindow.webContents;
  contents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: backendRequestHeaders(details, contents, rendererUrl, backendPort, desktopToken) });
  });
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isTrustedRenderer(event.url, rendererUrl)) event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !isTrustedRenderer(event.url, rendererUrl)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const target = externalWebUrl(url);
    if (target) void shell.openExternal(target).catch((error) => console.error('Could not open external link:', error));
    return { action: 'deny' };
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
    mainWindow.loadFile(rendererPath);
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  if (!ownsProfile) return;
  await startBackend();
  if (isSmokeTest) return;
  createWindow();
  if (!isDev && app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    desktopUpdater = createUpdater({
      updater: require('electron-updater').autoUpdater,
      publish: (state) => mainWindow?.webContents.send('update:state', state),
      prepareInstall: async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${backendPort}/health`, {
            headers: { [TOKEN_HEADER]: desktopToken },
            signal: AbortSignal.timeout(2500),
          });
          const { data } = await response.json();
          if (!response.ok || typeof data?.download_running !== 'boolean') throw new Error('Backend not ready');
          if (data.download_running) return 'Finish your current music download before restarting Audora.';
        } catch {
          return 'Audora is still connecting to the library. Try again in a moment.';
        }
        updateRestarting = true;
        try {
          await stopBackend();
          backendShutdownComplete = true;
        } catch (error) {
          updateRestarting = false;
          throw error;
        }
      },
      recoverInstall: () => {
        backendShutdownComplete = false;
        updateRestarting = false;
        void startBackend().catch((error) => console.error('Backend restart failed:', error));
      },
    });
    void desktopUpdater.check();
    setInterval(() => void desktopUpdater.check(), 4 * 60 * 60 * 1000).unref();
  }

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
for (const [channel, action] of Object.entries({
  'update:get-state': 'getState',
  'update:download': 'download',
  'update:install': 'install',
})) {
  ipcMain.handle(channel, (event) => {
    if (!desktopUpdater || !isTrustedSender(event, mainWindow?.webContents, rendererUrl)) return null;
    return desktopUpdater[action]();
  });
}

ipcMain.handle('open-folder', async (event, folderPath) => {
  if (!isTrustedSender(event, mainWindow?.webContents, rendererUrl) ||
      typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) return;
  const directory = await fs.promises.stat(folderPath).catch(() => null);
  if (directory?.isDirectory()) await shell.openPath(folderPath);
});

ipcMain.handle('show-notification', (event, options) => {
  if (!isTrustedSender(event, mainWindow?.webContents, rendererUrl)) return;
  if (Notification.isSupported() && typeof options?.title === 'string' && typeof options?.body === 'string') {
    new Notification({ title: options.title.slice(0, 128), body: options.body.slice(0, 512) }).show();
  }
});

ipcMain.handle('select-folder', async (event) => {
  if (!isTrustedSender(event, mainWindow?.webContents, rendererUrl)) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('adjust-zoom', (event, steps) => {
  if (!mainWindow || mainWindow.isDestroyed() || !isTrustedSender(event, mainWindow.webContents, rendererUrl) ||
      !Number.isInteger(steps)) return;
  const change = Math.max(-3, Math.min(3, steps));
  const contents = mainWindow.webContents;
  const factor = Math.max(0.5, Math.min(3, contents.getZoomFactor() * 1.1 ** change));
  contents.setZoomFactor(factor);
});
