import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// Bundle the TypeScript store without starting Electron or the backend.
const result = await build({
  entryPoints: ['src/store/useAppStore.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'backend-stub',
    setup(builder) {
      builder.onResolve({ filter: /\.\.\/api\/client$/ }, () => ({ path: 'api', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const api = {};', loader: 'js' }));
    },
  }],
});
const { useAppStore } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
const songs = [1, 2, 3].map((id) => ({ id, file_path: `${id}.flac`, title: `${id}`, duration: 10, file_size: 1 }));

function reset() {
  useAppStore.setState({
    currentTrack: null, isPlaying: false, playbackQueue: [], basePlaybackQueue: [],
    playbackIndex: -1, playbackRequestId: 0, shuffleEnabled: false, repeatMode: 'off',
  });
}

test('repeat one replays on completion but manual next still advances', () => {
  reset();
  useAppStore.getState().playTracks(songs);
  useAppStore.setState({ repeatMode: 'one' });
  assert.equal(useAppStore.getState().finishTrack(), true);
  assert.equal(useAppStore.getState().playbackIndex, 0);
  assert.equal(useAppStore.getState().playNext(), true);
  assert.equal(useAppStore.getState().currentTrack.id, 2);
});

test('repeat all wraps after the final track and off stops', () => {
  reset();
  useAppStore.getState().playTracks(songs, songs[2]);
  assert.equal(useAppStore.getState().finishTrack(), false);
  assert.equal(useAppStore.getState().isPlaying, false);
  useAppStore.setState({ repeatMode: 'all' });
  assert.equal(useAppStore.getState().finishTrack(), true);
  assert.equal(useAppStore.getState().currentTrack.id, 1);
});

test('shuffle keeps current song and history; Up Next moves a song into position', () => {
  reset();
  useAppStore.getState().playTracks(songs);
  useAppStore.getState().playNext();
  useAppStore.getState().toggleShuffle();
  assert.equal(useAppStore.getState().playbackQueue[1].id, 2);
  useAppStore.getState().addPlayNext(songs[0]);
  assert.equal(useAppStore.getState().playbackQueue[2].id, 1);
  useAppStore.getState().removeUpcoming(2);
  assert.equal(useAppStore.getState().playbackQueue.length, 3);
  useAppStore.getState().toggleShuffle();
  assert.equal(useAppStore.getState().shuffleEnabled, false);
});

test('add to queue appends without interrupting the current song', () => {
  reset();
  useAppStore.getState().playTracks(songs.slice(0, 2));
  useAppStore.getState().addToPlaybackEnd(songs[2]);
  assert.equal(useAppStore.getState().currentTrack.id, 1);
  assert.deepEqual(useAppStore.getState().playbackQueue.map((song) => song.id), [1, 2, 3]);
  useAppStore.getState().moveUpcoming(2, 1);
  assert.deepEqual(useAppStore.getState().playbackQueue.map((song) => song.id), [1, 3, 2]);
  useAppStore.getState().toggleShuffle();
  useAppStore.getState().toggleShuffle();
  assert.deepEqual(useAppStore.getState().playbackQueue.map((song) => song.id), [1, 3, 2]);
  useAppStore.getState().clearUpcoming();
  assert.deepEqual(useAppStore.getState().playbackQueue.map((song) => song.id), [1]);
});

test('clicking the same library song again requests a fresh start', () => {
  reset();
  useAppStore.getState().playTracks(songs);
  const firstRequest = useAppStore.getState().playbackRequestId;
  useAppStore.getState().playTracks(songs);
  assert.equal(useAppStore.getState().playbackRequestId, firstRequest + 1);
});

test('manually queued songs keep their place when shuffle is turned off', () => {
  reset();
  useAppStore.getState().playTracks(songs);
  useAppStore.getState().addPlayNext(songs[2]);
  assert.deepEqual(useAppStore.getState().basePlaybackQueue.map((song) => song.id), [1, 3, 2]);
  useAppStore.getState().toggleShuffle();
  useAppStore.getState().toggleShuffle();
  assert.deepEqual(useAppStore.getState().playbackQueue.map((song) => song.id), [1, 3, 2]);
  useAppStore.getState().addToPlaybackEnd(songs[0]);
  useAppStore.getState().toggleShuffle();
  useAppStore.getState().toggleShuffle();
  assert.deepEqual(useAppStore.getState().playbackQueue.map((song) => song.id), [1, 3, 2, 1]);
});
