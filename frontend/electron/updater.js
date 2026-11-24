function createUpdater({ updater, publish, prepareInstall, recoverInstall }) {
  let state = { phase: 'idle' };
  let checking = false;
  let installStarted = false;

  function setState(next) {
    state = next;
    publish(state);
  }

  function fail(error) {
    console.error('Audora update:', error.message);
    if (state.phase === 'installing') {
      if (installStarted) recoverInstall();
      installStarted = false;
      setState({ ...state, phase: 'ready', message: 'Could not install the update. Try again.' });
    } else if (state.phase === 'downloading') {
      setState({ version: state.version, phase: 'available', message: 'Download failed. Try again.' });
    }
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on('error', fail);
  updater.on('update-available', ({ version }) => setState({ phase: 'available', version }));
  updater.on('download-progress', ({ percent }) => {
    if (state.phase === 'downloading') setState({ ...state, percent: Math.round(percent) });
  });
  updater.on('update-downloaded', ({ version }) => setState({ phase: 'ready', version }));

  async function check() {
    if (checking || state.phase !== 'idle') return;
    checking = true;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      // Release or network failures never block normal startup.
      console.warn('Could not check for an Audora update:', error.message);
    } finally {
      checking = false;
    }
  }

  async function download() {
    if (state.phase !== 'available') return;
    setState({ phase: 'downloading', version: state.version, percent: 0 });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      if (state.phase === 'downloading') fail(error);
    }
  }

  async function install() {
    if (state.phase !== 'ready') return;
    setState({ phase: 'installing', version: state.version });
    try {
      const blocked = await prepareInstall();
      if (blocked) {
        setState({ ...state, phase: 'ready', message: blocked });
        return;
      }
      installStarted = true;
      updater.quitAndInstall(true, true);
    } catch (error) {
      fail(error);
    }
  }

  return { getState: () => state, check, download, install };
}

module.exports = { createUpdater };
