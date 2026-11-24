const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const frontend = path.resolve(__dirname, '..');
const root = path.resolve(frontend, '..');
const backend = path.join(root, 'backend');
const cache = path.join(root, '.cache');

function insideRepository(target) {
  const relative = path.relative(root, path.resolve(target));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function cleanGenerated(target) {
  if (!insideRepository(target)) throw new Error(`Refusing to clean outside Audora: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function preparePackageOutput(platform, output, scratch) {
  if (!insideRepository(output) || !insideRepository(scratch)) {
    throw new Error(`Refusing to move package output outside Audora: ${output}`);
  }
  if (platform !== 'win32' || !fs.existsSync(output)) {
    cleanGenerated(output);
    return output;
  }

  // Move the prior build as a unit so a running app cannot cause a partial cleanup.
  const previous = path.join(scratch, `previous-dist-${randomUUID()}`);
  try {
    fs.renameSync(output, previous);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || process.env.GITHUB_ACTIONS === 'true') throw error;
    const alternate = fs.mkdtempSync(path.join(scratch, 'dist-electron-'));
    process.stderr.write(`Windows is holding ${output} open. Building into ${alternate}\n`);
    return alternate;
  }
  try {
    cleanGenerated(previous);
  } catch (error) {
    process.stderr.write(`Previous build remains at ${previous}: ${error.message}\n`);
  }
  return output;
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

function buildBackend(platform, python, pythonPrefix) {
  const scratch = fs.mkdtempSync(path.join(cache, 'backend-build-'));
  const venv = path.join(scratch, 'venv');
  const venvPython = platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
  try {
    run('Create Python environment', python, [...pythonPrefix, '-m', 'venv', venv]);
    run('Install backend dependencies', venvPython, [
      '-m', 'pip', 'install', '-r', 'backend/requirements.txt',
      '-r', 'backend/requirements-build.txt', '-r', 'backend/requirements-test.txt',
    ]);
    run('Test backend', venvPython, [
      '-m', 'pytest', 'backend/tests', '-q', '--basetemp', path.join(scratch, 'pytest'),
    ]);
    run('Freeze backend', venvPython, [
      '-m', 'PyInstaller', '--noconfirm', '--clean', 'backend.spec',
    ], backend);
  } finally {
    try {
      cleanGenerated(scratch);
    } catch (error) {
      process.stderr.write(`Temporary Python build files remain at ${scratch}: ${error.message}\n`);
    }
  }
}

function build(platform = process.platform) {
  if (!['win32', 'linux'].includes(platform)) {
    throw new Error(`Unsupported build platform: ${platform}`);
  }
  const { version, build: buildConfig } = require('../package.json');
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`Release tag must match app version v${version}`);
  }
  const configuredPython = process.env.AUDORA_BUILD_PYTHON;
  const python = configuredPython || (platform === 'win32' ? 'py' : 'python3.13');
  const pythonPrefix = !configuredPython && platform === 'win32' ? ['-3.13'] : [];
  run('Check Python 3.13', python, [...pythonPrefix, '--version']);

  // npm ci replaces node_modules itself. Fail here before clearing build output
  // if Windows still has a dependency file open.
  npm('Install frontend dependencies', ['ci']);
  for (const target of [
    path.join(backend, 'build'), path.join(backend, 'dist'),
    path.join(frontend, 'dist'),
  ]) cleanGenerated(target);
  fs.mkdirSync(cache, { recursive: true });
  buildBackend(platform, python, pythonPrefix);

  npm('Test Electron', ['run', 'test:electron']);
  npm('Build frontend', ['run', 'build']);
  const defaultOutput = path.resolve(frontend, buildConfig.directories.output);
  const outputRoot = path.dirname(defaultOutput);
  if (!insideRepository(outputRoot)) throw new Error(`Package output is outside Audora: ${defaultOutput}`);
  fs.mkdirSync(outputRoot, { recursive: true });
  const packageOutput = preparePackageOutput(platform, defaultOutput, outputRoot);
  const targetArgs = platform === 'win32'
    ? ['--win', 'nsis', '--x64']
    : ['--linux', 'AppImage', 'deb', '--x64'];
  npm(`Package ${platform === 'win32' ? 'Windows' : 'Linux'} x64`, [
    'exec', '--', 'electron-builder', ...targetArgs, '--publish', 'never',
    ...(packageOutput !== defaultOutput ? [`--config.directories.output=${packageOutput}`] : []),
  ]);
  const manifest = platform === 'win32' ? 'latest.yml' : 'latest-linux.yml';
  if (!fs.existsSync(path.join(packageOutput, manifest))) {
    throw new Error(`Package did not produce the update manifest ${manifest}`);
  }

  const unpacked = path.join(packageOutput,
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
  process.stdout.write(`\nInstaller artifacts: ${packageOutput}\n`);
}

if (require.main === module) {
  try { build(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { build, cleanGenerated, insideRepository, preparePackageOutput };
