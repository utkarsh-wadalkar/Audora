const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBackendReady({
  request,
  timeoutMs = 45_000,
  intervalMs = 250,
  sleep = delay,
  expectedToken,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await request();
      if (response?.ok && (!expectedToken || response.token === expectedToken)) return true;
    } catch {
      // The backend has not bound its HTTP port yet; retry until deadline.
    }
    await sleep(intervalMs);
  }
  throw new Error(`Packaged backend did not become ready within ${timeoutMs}ms`);
}

async function requestHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.json();
  return { ok: response.ok, token: body?.data?.smoke_token };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function resolvePackagedExecutable(unpackedDir, platform) {
  if (platform === 'win32') return path.join(unpackedDir, 'Audora.exe');
  if (platform === 'linux') return path.join(unpackedDir, 'audora');
  throw new Error(`Audora packaged smoke tests support Windows and Linux only, not ${platform}`);
}

function terminate(child, platform) {
  if (!child?.pid) return Promise.resolve();
  if (platform !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
  });
}

async function smokePackagedApplication({
  unpackedDir,
  platform = process.platform,
  request,
}) {
  const executable = resolvePackagedExecutable(unpackedDir, platform);
  const port = await reservePort();
  const smokeToken = randomUUID();
  const child = spawn(executable, ['--disable-gpu', '--disable-software-rasterizer'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AUDORA_BACKEND_PORT: String(port),
      AUDORA_SMOKE_TOKEN: smokeToken,
      AUDORA_SMOKE_TEST: '1',
    },
  });
  try {
    await waitForBackendReady({
      request: request || (() => requestHealth(port)),
      expectedToken: smokeToken,
    });
  } finally {
    await terminate(child, platform);
  }
}

if (require.main === module) {
  const unpackedDir = process.argv[2];
  if (!unpackedDir) {
    console.error('Usage: node electron/smoke-packaged.js <unpacked-app-directory>');
    process.exitCode = 2;
  } else {
    smokePackagedApplication({ unpackedDir })
      .then(() => console.log('Packaged backend responded to /health.'))
      .catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
      });
  }
}

module.exports = {
  resolvePackagedExecutable,
  reservePort,
  smokePackagedApplication,
  waitForBackendReady,
};
