const assert = require('node:assert/strict');
const test = require('node:test');
const { TOKEN_HEADER, backendRequestHeaders, externalWebUrl, isTrustedSender, rendererDocument } = require('./desktop-access');

const document = 'file:///Audora/App%20Resources/dist/index.html';
const frame = { url: `${document}#/library` };
const contents = { id: 7, mainFrame: frame };

test('only the expected top-level renderer can use native IPC', () => {
  assert.equal(rendererDocument(frame.url), document);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: frame }, contents, document), true);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: { url: frame.url } }, contents, document), false);
  const replacement = { ...contents, mainFrame: { url: 'https://third-party.example/' } };
  assert.equal(isTrustedSender({ sender: replacement, senderFrame: replacement.mainFrame }, replacement, document), false);
});

test('the session token stays with local backend requests from the main renderer', () => {
  const request = {
    url: 'http://localhost:8000/library/stream/3',
    requestHeaders: { [TOKEN_HEADER.toLowerCase()]: 'forged', Range: 'bytes=0-512' },
    webContentsId: contents.id,
    frame,
  };
  const headers = (patch) => backendRequestHeaders({ ...request, ...patch }, contents, document, '8000', 'session');
  assert.deepEqual(headers({}), { Range: 'bytes=0-512', [TOKEN_HEADER]: 'session' });
  assert.equal(headers({ url: 'ws://127.0.0.1:8000/ws/logs' })[TOKEN_HEADER], 'session');
  assert.equal(headers({ url: 'https://third-party.example/' })[TOKEN_HEADER], undefined);
  assert.equal(headers({ url: 'http://localhost:5173/' })[TOKEN_HEADER], undefined);
  assert.equal(headers({ frame: { url: frame.url } })[TOKEN_HEADER], undefined);
});

test('only regular HTTPS links can open in the system browser', () => {
  assert.equal(externalWebUrl('https://github.com/'), 'https://github.com/');
  assert.equal(externalWebUrl('file:///C:/Apps/Audora.exe'), null);
  assert.equal(externalWebUrl('https://user:password@third-party.example/'), null);
});
