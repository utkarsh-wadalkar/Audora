import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/lib/playbackOrder.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false,
});
const { restoreUpcoming, shuffleUpcoming } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
);

test('shuffle leaves played songs and the current song in place', () => {
  const songs = ['a', 'b', 'c', 'd', 'e'];
  const shuffled = shuffleUpcoming(songs, 1, () => 0);
  assert.deepEqual(shuffled.slice(0, 2), ['a', 'b']);
  assert.deepEqual([...shuffled.slice(2)].sort(), ['c', 'd', 'e']);
  assert.notDeepEqual(shuffled, songs);
  assert.deepEqual(songs, ['a', 'b', 'c', 'd', 'e']);
});

test('turning shuffle off restores only upcoming songs', () => {
  assert.deepEqual(
    restoreUpcoming(['a', 'd', 'e', 'c', 'b'], ['a', 'b', 'c', 'd', 'e'], 1),
    ['a', 'd', 'b', 'c', 'e'],
  );
});

test('restoring order matches rescanned songs by their stable path', () => {
  const first = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
  const newC = { path: 'c' };
  assert.deepEqual(
    restoreUpcoming([first[0], newC, first[1]], first, 0, (a, b) => a.path === b.path),
    [first[0], first[1], newC],
  );
});

test('restoring order keeps a queued replay at the end', () => {
  assert.deepEqual(
    restoreUpcoming(['a', 'c', 'b', 'a'], ['a', 'b', 'c', 'a'], 0),
    ['a', 'b', 'c', 'a'],
  );
});
