const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanGenerated, insideRepository } = require('./build-all.cjs');

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
