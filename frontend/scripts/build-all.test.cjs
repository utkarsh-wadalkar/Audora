const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanGenerated, insideRepository, preparePackageOutput } = require('./build-all.cjs');

test('cleaning refuses paths outside the repository', () => {
  assert.equal(insideRepository(os.tmpdir()), false);
  assert.throws(() => cleanGenerated(os.tmpdir()), /outside Audora/);
});

test('cleaning removes only the requested generated directory', () => {
  const target = path.resolve(__dirname, '..', '.qa-clean-probe');
  const keep = path.resolve(__dirname, '..', 'package.json');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'generated.txt'), 'temporary');
  try {
    cleanGenerated(target);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(keep), true);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a locked Windows build stays in place while a new output directory is selected', (context) => {
  const scratch = fs.mkdtempSync(path.resolve(__dirname, '..', '.qa-output-probe-'));
  const output = path.join(scratch, 'dist-electron');
  fs.mkdirSync(output);
  const previousInstaller = path.join(output, 'previous.exe');
  fs.writeFileSync(previousInstaller, 'previous build');
  const rename = context.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('Windows file lock'), { code: 'EPERM' });
  });
  const githubActions = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try {
    const alternate = preparePackageOutput('win32', output, scratch);
    assert.notEqual(alternate, output);
    assert.equal(path.dirname(alternate), scratch);
    assert.equal(fs.statSync(alternate).isDirectory(), true);
    assert.equal(fs.readFileSync(previousInstaller, 'utf8'), 'previous build');
  } finally {
    if (githubActions !== undefined) process.env.GITHUB_ACTIONS = githubActions;
    rename.mock.restore();
    cleanGenerated(scratch);
  }
});
