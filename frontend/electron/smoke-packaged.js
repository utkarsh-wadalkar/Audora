const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { once } = require('node:events');
const { TOKEN_HEADER } = require('./desktop-access');

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

async function requestHealth(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { [TOKEN_HEADER]: token },
  });
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
    if (child.exitCode !== null || child.signalCode) return Promise.resolve();
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    return closed.finally(() => clearTimeout(killTimer));
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
  const tempRoot = await fs.realpath(os.tmpdir());
  const profile = await fs.mkdtemp(path.join(tempRoot, 'audora-smoke-'));
  const legacy = path.join(profile, 'legacy-install-backup');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'settings.json'), JSON.stringify({
    setup_complete: true,
    auto_start_wrapper: false,
  }));
  const child = spawn(executable, ['--disable-gpu', '--disable-software-rasterizer'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AUDORA_BACKEND_PORT: String(port),
      AUDORA_SMOKE_TOKEN: smokeToken,
      AUDORA_SMOKE_TEST: '1',
      AUDORA_SMOKE_PROFILE: profile,
    },
  });
  try {
    await waitForBackendReady({
      request: request || (() => requestHealth(port, smokeToken)),
      expectedToken: smokeToken,
    });
    if (!request) {
      const endpoint = `http://127.0.0.1:${port}/settings`;
      const unauthenticated = await fetch(endpoint, {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
        signal: AbortSignal.timeout(5000),
      });
      if (unauthenticated.status !== 403) throw new Error('Packaged backend accepted an unauthenticated renderer request');
      const setup = await fetch(`http://127.0.0.1:${port}/setup/status?include_system=false`, {
        headers: { 'Sec-Fetch-Site': 'cross-site', [TOKEN_HEADER]: smokeToken },
        signal: AbortSignal.timeout(5000),
      });
      if (!setup.ok) throw new Error('Packaged backend rejected authenticated requests without an Origin');
      const response = await fetch(endpoint, {
        headers: { Origin: 'null', [TOKEN_HEADER]: smokeToken },
        signal: AbortSignal.timeout(5000),
      });
      const { data } = await response.json();
      if (!response.ok || response.headers.get('access-control-allow-origin') !== 'null' ||
          data?.setup_complete !== true || data?.auto_start_wrapper !== false) {
        throw new Error('Packaged backend did not load the migrated settings on first launch');
      }
    }
  } finally {
    await terminate(child, platform);
    const resolvedProfile = await fs.realpath(profile);
    if (path.dirname(resolvedProfile) === tempRoot && path.basename(resolvedProfile).startsWith('audora-smoke-')) {
      await fs.rm(resolvedProfile, { recursive: true, force: true, maxRetries: 4 });
    }
  }
}

if (require.main === module) {
  const unpackedDir = process.argv[2];
  if (!unpackedDir) {
    console.error('Usage: node electron/smoke-packaged.js <unpacked-app-directory>');
    process.exitCode = 2;
  } else {
    smokePackagedApplication({ unpackedDir })
      .then(() => console.log('Packaged backend responded to /health and loaded migrated settings.'))
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
