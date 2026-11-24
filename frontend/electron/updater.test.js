const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUpdater } = require('./updater');

test('an available update waits for consent and cannot restart during a download', async () => {
  const updater = new EventEmitter();
  const actions = [];
  let musicDownloadRunning = true;
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '2.0.7' });
  updater.downloadUpdate = async () => {
    actions.push('download');
    updater.emit('download-progress', { percent: 30 });
    updater.emit('update-downloaded', { version: '2.0.7' });
  };
  updater.quitAndInstall = (silent, relaunch) => actions.push(['install', silent, relaunch]);
  const phases = [];
  const controller = createUpdater({
    updater,
    publish: (state) => phases.push(state),
    prepareInstall: async () => {
      if (musicDownloadRunning) return 'Finish your current music download.';
      actions.push('stop backend');
    },
    recoverInstall: () => assert.fail('The successful install should not trigger recovery'),
  });
  await controller.check();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.deepEqual(actions, []);
  await controller.download();
  assert.ok(phases.some(({ phase, percent }) => phase === 'downloading' && percent === 30));
  await controller.install();
  assert.deepEqual(actions, ['download']);
  assert.equal(controller.getState().phase, 'ready');
  assert.match(controller.getState().message, /Finish your current/);
  musicDownloadRunning = false;
  await controller.install();
  assert.deepEqual(actions, ['download', 'stop backend', ['install', true, true]]);
});
