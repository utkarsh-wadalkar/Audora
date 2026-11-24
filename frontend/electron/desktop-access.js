const { URL } = require('node:url');

const TOKEN_HEADER = 'X-Audora-Token';

function rendererDocument(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function isTrustedRenderer(url, expectedUrl) {
  return Boolean(expectedUrl && rendererDocument(url) === expectedUrl);
}

function isTrustedSender(event, contents, rendererUrl) {
  return Boolean(contents && event.sender === contents && event.senderFrame &&
    event.senderFrame === contents.mainFrame && isTrustedRenderer(event.senderFrame.url, rendererUrl));
}

function backendRequestHeaders(details, contents, rendererUrl, port, token) {
  const headers = { ...details.requestHeaders };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === TOKEN_HEADER.toLowerCase()) delete headers[name];
  }
  const url = new URL(details.url);
  const localBackend = (url.protocol === 'http:' || url.protocol === 'ws:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === port;
  if (localBackend && details.webContentsId === contents.id &&
      (!details.frame || details.frame === contents.mainFrame) &&
      isTrustedRenderer(contents.mainFrame.url, rendererUrl)) {
    headers[TOKEN_HEADER] = token;
  }
  return headers;
}

function externalWebUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.href;
  } catch {
    // Malformed links have no external destination.
  }
  return null;
}

module.exports = { TOKEN_HEADER, backendRequestHeaders, externalWebUrl, isTrustedRenderer, isTrustedSender, rendererDocument };
