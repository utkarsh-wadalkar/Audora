const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createBackendProcessController } = require('./backend-process-controller');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', 0);
    return true;
  };
  return child;
}

test('stop terminates the entire Windows backend process tree', async () => {
  const child = fakeChild(4100);
  const taskkillCalls = [];
  const controller = createBackendProcessController({
    platform: 'win32',
    spawnProcess: () => child,
    execFileProcess: (file, args, callback) => {
      taskkillCalls.push([file, args]);
      child.emit('close', 0);
      callback(null, '', '');
    },
  });

  await controller.start({ command: 'backend.exe', args: [], options: {} });
  await controller.stop();

  assert.deepEqual(taskkillCalls, [
    ['taskkill.exe', ['/pid', '4100', '/T', '/F']],
  ]);
  assert.equal(controller.getProcess(), null);
});

test('restart waits for the old process tree to stop before spawning a new backend', async () => {
  const first = fakeChild(5100);
  const second = fakeChild(5200);
  const order = [];
  let spawnCount = 0;
  const controller = createBackendProcessController({
    platform: 'win32',
    spawnProcess: () => {
      spawnCount += 1;
      order.push(`spawn:${spawnCount}`);
      return spawnCount === 1 ? first : second;
    },
    execFileProcess: (_file, _args, callback) => {
      order.push('taskkill:start');
      first.emit('close', 0);
      order.push('taskkill:done');
      callback(null, '', '');
    },
  });
  const spec = { command: 'backend.exe', args: [], options: {} };

  await controller.start(spec);
  await controller.restart(spec);

  assert.deepEqual(order, [
    'spawn:1',
    'taskkill:start',
    'taskkill:done',
    'spawn:2',
  ]);
  assert.equal(controller.getProcess(), second);
});

test('overlapping restarts are serialized and never leave duplicate trees', async () => {
  const children = [fakeChild(6100), fakeChild(6200), fakeChild(6300)];
  let spawnCount = 0;
  let liveTrees = 0;
  let maximumLiveTrees = 0;
  const controller = createBackendProcessController({
    platform: 'win32',
    spawnProcess: () => {
      const child = children[spawnCount++];
      liveTrees += 1;
      maximumLiveTrees = Math.max(maximumLiveTrees, liveTrees);
      return child;
    },
    execFileProcess: (_file, args, callback) => {
      const pid = Number(args[1]);
      const child = children.find((candidate) => candidate.pid === pid);
      liveTrees -= 1;
      child.emit('close', 0);
      callback(null, '', '');
    },
  });
  const spec = { command: 'backend.exe', args: [], options: {} };

  await controller.start(spec);
  await Promise.all([controller.restart(spec), controller.restart(spec)]);

  assert.equal(maximumLiveTrees, 1);
  assert.equal(controller.getProcess(), children[2]);
});
