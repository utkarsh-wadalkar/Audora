const { spawn, execFile } = require('node:child_process');

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

function execFileAsync(execFileProcess, file, args) {
  return new Promise((resolve, reject) => {
    execFileProcess(file, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function createBackendProcessController({
  spawnProcess = spawn,
  execFileProcess = execFile,
  platform = process.platform,
  stopTimeoutMs = 10000,
  log = console,
} = {}) {
  let backendProcess = null;
  let operationQueue = Promise.resolve();

  const enqueue = (operation) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  };

  const spawnBackend = (spec) => {
    const child = spawnProcess(spec.command, spec.args, spec.options);
    backendProcess = child;
    child.stdout?.on('data', (data) => log.log(`[backend] ${data}`));
    child.stderr?.on('data', (data) => log.error(`[backend err] ${data}`));
    child.on('error', (error) => log.error('Failed to start backend:', error));
    child.on('close', (code) => {
      log.log(`Backend exited with code ${code}`);
      if (backendProcess === child) backendProcess = null;
    });
    return child;
  };

  const stopCurrent = async () => {
    const child = backendProcess;
    if (!child || !child.pid) {
      backendProcess = null;
      return;
    }

    const exited = waitForExit(child, stopTimeoutMs);
    if (platform === 'win32') {
      try {
        await execFileAsync(execFileProcess, 'taskkill.exe', [
          '/pid',
          String(child.pid),
          '/T',
          '/F',
        ]);
      } catch (error) {
        if (child.exitCode === null || child.exitCode === undefined) {
          throw error;
        }
      }
    } else {
      child.kill('SIGTERM');
    }

    if (!(await exited)) {
      if (platform !== 'win32') child.kill('SIGKILL');
      throw new Error(`Backend process tree ${child.pid} did not exit`);
    }
    if (backendProcess === child) backendProcess = null;
  };

  const start = (spec) =>
    enqueue(async () => {
      await stopCurrent();
      return spawnBackend(spec);
    });

  const stop = () => enqueue(stopCurrent);

  const restart = (spec) =>
    enqueue(async () => {
      await stopCurrent();
      return spawnBackend(spec);
    });

  return {
    start,
    stop,
    restart,
    getProcess: () => backendProcess,
  };
}

module.exports = { createBackendProcessController };
