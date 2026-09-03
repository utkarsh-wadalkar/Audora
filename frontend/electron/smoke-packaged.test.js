const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForBackendReady } = require('./smoke-packaged');

test('waitForBackendReady resolves after the packaged backend health endpoint answers', async () => {
  const result = await waitForBackendReady({
    request: async () => ({ ok: true }),
    timeoutMs: 20,
    intervalMs: 1,
  });

  assert.equal(result, true);
});

test('waitForBackendReady rejects after its deadline when no backend answers', async () => {
  await assert.rejects(
    waitForBackendReady({
      request: async () => ({ ok: false }),
      timeoutMs: 5,
      intervalMs: 1,
    }),
    /did not become ready/,
  );
});

test('waitForBackendReady rejects a health response from another backend instance', async () => {
  await assert.rejects(
    waitForBackendReady({
      request: async () => ({ ok: true, token: 'another-instance' }),
      expectedToken: 'this-package',
      timeoutMs: 5,
      intervalMs: 1,
    }),
    /did not become ready/,
  );
});
