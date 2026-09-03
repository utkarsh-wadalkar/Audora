const test = require('node:test');
const assert = require('node:assert/strict');

const { createBackendLaunchSpec, getWindowIcon, shouldCreateWindow } = require('./platform');

test('Linux packaged launch uses the native backend and per-user writable paths', () => {
  const spec = createBackendLaunchSpec({
    platform: 'linux',
    isDev: false,
    resourcesPath: '/opt/Audora/resources',
    getAppPath: (name) => ({
      userData: '/home/a/.config/Audora',
      music: '/home/a/Music',
    })[name],
    env: { KEEP_ME: 'yes' },
  });

  assert.equal(spec.command, '/opt/Audora/resources/backend/backend');
  assert.equal(spec.options.env.AUDORA_DATA_DIR, '/home/a/.config/Audora/backend');
  assert.equal(spec.options.env.AUDORA_DOWNLOADS_DIR, '/home/a/Music/Audora');
  assert.equal(spec.options.env.KEEP_ME, 'yes');
});

test('Windows packaged launch retains backend.exe without Linux environment overrides', () => {
  const spec = createBackendLaunchSpec({
    platform: 'win32',
    isDev: false,
    resourcesPath: 'C:\\App\\resources',
    userDataPath: 'C:\\Users\\a\\AppData\\Roaming\\Audora',
    musicPath: 'C:\\Users\\a\\Music',
    env: { KEEP_ME: 'yes' },
  });

  assert.equal(spec.command, 'C:\\App\\resources\\backend\\backend.exe');
  assert.equal(spec.options.env.AUDORA_DATA_DIR, undefined);
  assert.equal(spec.options.env.AUDORA_DOWNLOADS_DIR, undefined);
  assert.equal(spec.options.env.KEEP_ME, 'yes');
});

test('Windows packaged launch does not request a Music directory it never uses', () => {
  const spec = createBackendLaunchSpec({
    platform: 'win32',
    isDev: false,
    resourcesPath: 'C:\\App\\resources',
    getAppPath: (name) => {
      if (name === 'music') throw new Error('Music path is unavailable');
      return 'C:\\Users\\a\\AppData\\Roaming\\Audora';
    },
    env: {},
  });

  assert.equal(spec.command, 'C:\\App\\resources\\backend\\backend.exe');
});

test('Linux development launch uses the virtual-environment Python executable', () => {
  const spec = createBackendLaunchSpec({
    platform: 'linux',
    isDev: true,
    backendDir: '/src/backend',
    env: {},
    exists: () => true,
  });

  assert.equal(spec.command, '/src/backend/.venv/bin/python');
  assert.deepEqual(spec.args, ['-m', 'uvicorn', 'app:app', '--port', '8000']);
  assert.equal(spec.options.cwd, '/src/backend');
});

test('development launch uses an explicitly requested backend port', () => {
  const spec = createBackendLaunchSpec({
    platform: 'win32',
    isDev: true,
    backendDir: 'C:\\src\\backend',
    env: { AUDORA_BACKEND_PORT: '37123' },
    exists: () => true,
  });

  assert.deepEqual(spec.args, ['-m', 'uvicorn', 'app:app', '--port', '37123']);
});

test('window icon policy keeps the existing Windows icon and leaves Linux to its package icon', () => {
  assert.equal(
    getWindowIcon({ platform: 'win32', assetsDir: 'C:\\App\\assets' }),
    'C:\\App\\assets\\audoralogo.ico',
  );
  assert.equal(getWindowIcon({ platform: 'linux', assetsDir: '/opt/Audora/assets' }), undefined);
});

test('smoke mode starts the packaged backend without creating a renderer window', () => {
  assert.equal(shouldCreateWindow({ AUDORA_SMOKE_TEST: '1' }), false);
  assert.equal(shouldCreateWindow({}), true);
});
