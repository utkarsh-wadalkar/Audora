const path = require('node:path');
const fs = require('node:fs');

const SUPPORTED_PLATFORMS = new Set(['win32', 'linux']);

function pathModuleFor(platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Audora desktop packages support Windows and Linux only, not ${platform}`);
  }
  return platform === 'win32' ? path.win32 : path.posix;
}

function createBackendLaunchSpec({
  platform,
  isDev,
  resourcesPath,
  userDataPath,
  musicPath,
  getAppPath,
  backendDir,
  env = process.env,
  exists = fs.existsSync,
}) {
  const platformPath = pathModuleFor(platform);

  if (isDev) {
    const pythonPath = platform === 'win32'
      ? platformPath.join(backendDir, '.venv', 'Scripts', 'python.exe')
      : platformPath.join(backendDir, '.venv', 'bin', 'python');
    return {
      command: exists(pythonPath) ? pythonPath : 'python',
      args: ['-m', 'uvicorn', 'app:app', '--port', env.AUDORA_BACKEND_PORT || '8000'],
      options: { cwd: backendDir, stdio: 'pipe', env },
    };
  }

  const backendName = platform === 'win32' ? 'backend.exe' : 'backend';
  const backendEnv = { ...env };
  const resolvedUserDataPath = userDataPath || getAppPath?.('userData');
  if (!resolvedUserDataPath) throw new Error('Packaged backend launch requires Electron userData');
  backendEnv.AUDORA_DATA_DIR = platformPath.join(resolvedUserDataPath, 'backend');
  if (!backendEnv.AUDORA_DOWNLOADS_DIR) {
    let resolvedMusicPath = musicPath;
    if (!resolvedMusicPath) {
      try {
        resolvedMusicPath = getAppPath?.('music');
      } catch {
        // The backend can use the home directory if Electron lacks a Music location.
      }
    }
    if (resolvedMusicPath) {
      backendEnv.AUDORA_DOWNLOADS_DIR = platformPath.join(resolvedMusicPath, 'Audora');
    }
  }

  return {
    command: platformPath.join(resourcesPath, 'backend', backendName),
    args: [],
    options: { stdio: 'pipe', env: backendEnv },
  };
}

function getWindowIcon({ platform, assetsDir }) {
  const platformPath = pathModuleFor(platform);
  return platform === 'win32'
    ? platformPath.join(assetsDir, 'audoralogo.ico')
    : undefined;
}

function shouldCreateWindow(env) {
  return env.AUDORA_SMOKE_TEST !== '1';
}

module.exports = { createBackendLaunchSpec, getWindowIcon, shouldCreateWindow };
