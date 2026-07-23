const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let backendProcess;

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, '../assets/audoralogo.ico'),
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

function startBackend() {
  if (isDev) {
    // In dev, run the FastAPI app via the project venv if present, else python.
    const backendDir = path.join(__dirname, '../../backend');
    const venvPython = path.join(backendDir, '.venv', 'Scripts', 'python.exe');
    const fs = require('fs');
    const pythonExe = fs.existsSync(venvPython) ? venvPython : 'python';
    backendProcess = spawn(pythonExe, ['-m', 'uvicorn', 'app:app', '--port', '8000'], {
      cwd: backendDir,
      stdio: 'pipe',
    });
  } else {
    // In production, run the PyInstaller-compiled exe from resources.
    const backendExe = path.join(process.resourcesPath, 'backend.exe');
    backendProcess = spawn(backendExe, [], { stdio: 'pipe' });
  }

  backendProcess.stdout.on('data', (data) => console.log(`[backend] ${data}`));
  backendProcess.stderr.on('data', (data) => console.error(`[backend err] ${data}`));
  backendProcess.on('close', (code) => console.log(`Backend exited with code ${code}`));
  backendProcess.on('error', (err) => console.error('Failed to start backend:', err));
}

function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
    backendProcess = null;
  }
}

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopBackend);

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
