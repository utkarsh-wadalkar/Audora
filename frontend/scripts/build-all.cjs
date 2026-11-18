const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const frontend = path.resolve(__dirname, '..');
const root = path.resolve(frontend, '..');
const backend = path.join(root, 'backend');
const cache = path.join(root, '.cache');
const venv = path.join(cache, 'qa-build-venv');
const venvPython = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');

function insideRepository(target) {
  const relative = path.relative(root, path.resolve(target));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function cleanGenerated(target) {
  if (!insideRepository(target)) throw new Error(`Refusing to clean outside Audora: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function run(label, command, args, cwd = root, env = process.env) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? 'unknown'})`);
}

function npm(label, args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this build with npm run dist');
  const env = { ...process.env };
  delete env.npm_config_allow_scripts;
  run(label, process.execPath, [npmCli, ...args], frontend, env);
}

function build(platform = process.platform) {
  if (!['win32', 'linux'].includes(platform)) {
    throw new Error(`Unsupported build platform: ${platform}`);
  }
  const python = platform === 'win32' ? 'py' : 'python3.13';
  const pythonPrefix = platform === 'win32' ? ['-3.13'] : [];
  run('Check Python 3.13', python, [...pythonPrefix, '--version']);

  for (const target of [
    path.join(backend, 'build'), path.join(backend, 'dist'),
    path.join(frontend, 'dist'), path.join(frontend, 'dist-electron'),
    path.join(frontend, 'node_modules'), venv, path.join(cache, 'qa-pytest'),
  ]) cleanGenerated(target);
  fs.mkdirSync(cache, { recursive: true });

  run('Create Python environment', python, [...pythonPrefix, '-m', 'venv', venv]);
  run('Install backend dependencies', venvPython, [
    '-m', 'pip', 'install', '-r', 'backend/requirements.txt',
    '-r', 'backend/requirements-build.txt', '-r', 'backend/requirements-test.txt',
  ]);
  run('Test backend', venvPython, [
    '-m', 'pytest', 'backend/tests', '-q', '--basetemp', path.join(cache, 'qa-pytest'),
  ]);
  run('Freeze backend', venvPython, [
    '-m', 'PyInstaller', '--noconfirm', '--clean', 'backend.spec',
  ], backend);

  npm('Install frontend dependencies', ['ci']);
  npm('Test Electron', ['run', 'test:electron']);
  npm('Build frontend', ['run', 'build']);
  const targetArgs = platform === 'win32'
    ? ['--win', 'nsis', '--x64']
    : ['--linux', 'AppImage', 'deb', '--x64'];
  npm(`Package ${platform === 'win32' ? 'Windows' : 'Linux'} x64`, [
    'exec', '--', 'electron-builder', ...targetArgs, '--publish', 'never',
  ]);

  const unpacked = path.join(frontend, 'dist-electron',
    platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  if (platform === 'linux') {
    const helper = path.join(unpacked, 'chrome-sandbox');
    run('Set packaged Chromium sandbox owner', 'sudo', ['chown', 'root:root', helper]);
    run('Set packaged Chromium sandbox permissions', 'sudo', ['chmod', '4755', helper]);
    run('Smoke test Linux package', 'xvfb-run', [
      '--auto-servernum', '--server-args=-screen 0 1600x1000x24',
      process.execPath, 'electron/smoke-packaged.js', unpacked,
    ], frontend);
  } else {
    run('Smoke test Windows package', process.execPath,
      ['electron/smoke-packaged.js', unpacked], frontend);
  }
  process.stdout.write(`\nInstaller artifacts: ${path.join(frontend, 'dist-electron')}\n`);
}

if (require.main === module) {
  try { build(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { build, cleanGenerated, insideRepository };
