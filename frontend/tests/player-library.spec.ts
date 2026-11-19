import { expect, test, type Page } from '@playwright/test';

const tracks = [
  { id: 1, file_path: 'C:\\Music\\One.flac', title: 'One', artist: 'Artist', album: 'Album', duration: 180, file_size: 1 },
  { id: 2, file_path: 'C:\\Music\\Two.flac', title: 'Two', artist: 'Artist', album: 'Album', duration: 200, file_size: 1 },
];

function wavTone(seconds = 4) {
  const rate = 8000;
  const frames = rate * seconds;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + frames * 2, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) bytes.writeInt16LE(Math.sin(frame * 440 * 2 * Math.PI / rate) * 1200, 44 + frame * 2);
  return bytes;
}

async function openLibrary(page: Page) {
  page.on('pageerror', (error) => console.error('Player test page error:', error.message));
  const playlists: { id: number; name: string; tracks: { entry_id: number; file_path: string; track: typeof tracks[number] }[] }[] = [];
  const favorites = new Set<string>();
  const smartPlaylists: { id: number; name: string; artist_contains: string; album_contains: string; favorites_only: boolean; tracks: typeof tracks }[] = [];
  await page.route('http://localhost:8000/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.startsWith('/library/art/') || path.startsWith('/library/stream/')) {
      await route.fulfill({ status: 404 });
      return;
    }
    let data: unknown = {};
    if (path === '/setup/status') data = { complete: true };
    if (path === '/library') data = tracks;
    if (path === '/library/albums') data = [];
    if (path === '/library/favorites' && method === 'GET') data = [...favorites];
    const favoriteMatch = path.match(/^\/library\/favorites\/(\d+)$/);
    if (favoriteMatch) {
      const track = tracks.find((item) => item.id === Number(favoriteMatch[1]))!;
      if (method === 'PUT') favorites.add(track.file_path);
      if (method === 'DELETE') favorites.delete(track.file_path);
    }
    if (path === '/library/smart-playlists' && method === 'GET') data = smartPlaylists.map((item) => ({ ...item, tracks: tracks.filter((track) => (!item.artist_contains || track.artist.toLowerCase().includes(item.artist_contains.toLowerCase())) && (!item.album_contains || track.album.toLowerCase().includes(item.album_contains.toLowerCase())) && (!item.favorites_only || favorites.has(track.file_path))) }));
    if (path === '/library/smart-playlists' && method === 'POST') {
      const body = route.request().postDataJSON();
      smartPlaylists.push({ id: smartPlaylists.length + 1, ...body, tracks: [] });
      data = smartPlaylists;
    }
    if (path.match(/^\/library\/smart-playlists\/\d+$/) && method === 'PATCH') {
      Object.assign(smartPlaylists[0], route.request().postDataJSON());
      data = smartPlaylists;
    }
    if (path.match(/^\/library\/smart-playlists\/\d+$/) && method === 'DELETE') smartPlaylists.splice(0, 1);
    if (path.startsWith('/library/lyrics/')) data = { text: '[00:01.00] Hello', synced: true };
    if (path === '/playlists' && method === 'GET') data = playlists;
    if (path === '/playlists' && method === 'POST') {
      const body = route.request().postDataJSON();
      const playlist = { id: playlists.length + 1, name: body.name, tracks: [] };
      playlists.push(playlist);
      data = playlist;
    }
    const addMatch = path.match(/^\/playlists\/(\d+)\/tracks$/);
    if (addMatch && method === 'POST') {
      const playlist = playlists.find((item) => item.id === Number(addMatch[1]))!;
      const body = route.request().postDataJSON();
      const track = tracks.find((item) => item.file_path === body.file_path)!;
      playlist.tracks.push({ entry_id: playlist.tracks.length + 1, file_path: track.file_path, track });
      data = playlist;
    }
    await route.fulfill({ json: { success: true, data } });
  });
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
}

test('a playlist references library songs and can play them', async ({ page }) => {
  await openLibrary(page);
  await page.getByRole('button', { name: 'playlists', exact: true }).click();
  await page.getByRole('textbox', { name: 'New playlist name' }).fill('Evening');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Evening' })).toBeVisible();
  await page.getByRole('button', { name: 'Playlists', exact: true }).click();
  await page.getByRole('button', { name: 'tracks', exact: true }).click();
  await page.getByRole('combobox', { name: 'Add One to playlist' }).selectOption('1');
  await expect(page.getByRole('status')).toContainText('Added to Evening');
  await page.getByRole('button', { name: 'playlists', exact: true }).click();
  await page.getByRole('button', { name: /Evening.*1 tracks/ }).click();
  await expect(page.getByRole('button', { name: 'Play playlist' })).toBeEnabled();
});

test('shuffle, repeat, and Up Next are available from the player', async ({ page }) => {
  await openLibrary(page);
  await page.getByRole('button', { name: 'Play One', exact: true }).click();
  await page.getByRole('button', { name: 'Turn shuffle on' }).click();
  await expect(page.getByRole('button', { name: 'Turn shuffle off' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Repeat off. Change repeat mode' }).click();
  await page.getByRole('button', { name: 'Repeat all. Change repeat mode' }).click();
  await expect(page.getByRole('button', { name: 'Repeat one. Change repeat mode' })).toBeVisible();
  await page.getByRole('button', { name: 'Show Up Next' }).click();
  await expect(page.getByText('Up Next', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Two from Up Next' })).toBeVisible();
});

test('favorites and smart playlists reference the current library', async ({ page }) => {
  await openLibrary(page);
  await page.getByRole('button', { name: 'Add One to favorites' }).click();
  await page.getByRole('button', { name: 'favorites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play One', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play Two', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'smart', exact: true }).click();
  await page.getByRole('textbox', { name: 'Smart playlist name' }).fill('Liked artist');
  await page.getByLabel('Favorites only').check();
  await page.getByRole('button', { name: 'Create smart playlist' }).click();
  await expect(page.getByRole('heading', { name: 'Liked artist' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Liked artist' }).click();
  await page.getByRole('textbox', { name: 'Smart playlist name' }).fill('Liked songs');
  await page.getByRole('button', { name: 'Save smart playlist' }).click();
  await expect(page.getByRole('heading', { name: 'Liked songs' })).toBeVisible();
});

test('audio effects persist and output selection has an honest capability state', async ({ page }) => {
  await openLibrary(page);
  await page.goto('/#/settings#audio');
  await page.getByLabel('Ten band equalizer').check();
  await page.getByLabel('60 Hz gain').fill('5');
  await page.getByLabel('Crossfade duration').fill('3');
  await page.reload();
  await expect(page.getByLabel('Ten band equalizer')).toBeChecked();
  await expect(page.getByLabel('60 Hz gain')).toHaveValue('5');
  await expect(page.getByLabel('Crossfade duration')).toHaveValue('3');
  const output = page.getByLabel('Audio output');
  if (await output.isDisabled()) await expect(page.getByText('cannot select an output device')).toBeVisible();
  else {
    await expect(output.locator('option[value=""]')).toHaveText('System default');
    await output.selectOption('');
    await expect(page.getByRole('status')).toContainText('Audio output changed');
  }
});

test('local time stamped lyrics open from the player', async ({ page }) => {
  await openLibrary(page);
  await page.getByRole('button', { name: 'Play One', exact: true }).click();
  await page.getByRole('button', { name: 'Show lyrics' }).click();
  await expect(page.getByRole('button', { name: 'Hello' })).toBeVisible();
});

test('audio engine plays local PCM and overlaps tracks during crossfade', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openLibrary(page);
  await page.getByRole('button', { name: 'Play One', exact: true }).click();
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/lib/audioEngine.ts');
    const rate = 8000;
    const frames = rate * 2;
    const bytes = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(bytes);
    const write = (at: number, value: string) => [...value].forEach((letter, index) => view.setUint8(at + index, letter.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, frames * 2, true);
    for (let frame = 0; frame < frames; frame++) view.setInt16(44 + frame * 2, Math.sin(frame * 440 * 2 * Math.PI / rate) * 1200, true);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const engine = new AudioEngine();
    const errors: string[] = [];
    engine.onError = (message) => errors.push(message);
    engine.load(url);
    const graph = engine as unknown as { context: AudioContext; volumeNode: GainNode };
    const tap = graph.context.createChannelSplitter(2);
    const left = graph.context.createAnalyser();
    const right = graph.context.createAnalyser();
    graph.volumeNode.connect(tap);
    tap.connect(left, 0); tap.connect(right, 1);
    await engine.play();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const firstPosition = engine.position;
    const rms = (node: AnalyserNode) => {
      const samples = new Float32Array(node.fftSize);
      node.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    };
    const leftLevel = rms(left);
    const rightLevel = rms(right);
    engine.load(url, 0.5);
    await engine.play();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const secondPosition = engine.position;
    engine.pause();
    const paused = !engine.playing;
    engine.seek(0.5);
    await engine.play();
    const decks = engine as unknown as { active: number; decks: { media: HTMLAudioElement; gain: GainNode }[] };
    const resumedGain = decks.decks[decks.active].gain.gain.value;
    const oldDeckPaused = decks.decks[1 - decks.active].media.paused;
    const result = { duration: engine.duration, firstPosition, secondPosition, leftLevel, rightLevel,
      playing: engine.playing, paused, resumedGain, oldDeckPaused, errors };
    engine.dispose(); URL.revokeObjectURL(url);
    return result;
  });
  expect(result.duration).toBeGreaterThan(1.9);
  expect(result.firstPosition).toBeGreaterThan(0);
  expect(result.secondPosition).toBeGreaterThan(0);
  expect(result.leftLevel).toBeGreaterThan(0.001);
  expect(result.rightLevel).toBeGreaterThan(0.001);
  expect(result.playing).toBe(true);
  expect(result.paused).toBe(true);
  expect(result.resumedGain).toBe(1);
  expect(result.oldDeckPaused).toBe(true);
  expect(result.errors).toEqual([]);
  await page.waitForTimeout(100);
  expect(pageErrors).toEqual([]);
});

test('the API stream reaches both speakers through the cross origin audio graph', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openLibrary(page);
  await page.route('http://localhost:8000/library/stream/1', (route) => route.fulfill({
    status: 200, body: wavTone(), headers: { 'access-control-allow-origin': '*', 'content-type': 'audio/wav' },
  }));
  await page.getByRole('button', { name: 'Play One', exact: true }).click();
  const levels = await page.evaluate(async () => {
    const { audioEngine } = await import('/src/lib/audioEngine.ts');
    const graph = audioEngine as unknown as { context: AudioContext; volumeNode: GainNode };
    for (let attempt = 0; !graph.context && attempt < 20; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    const tap = graph.context.createChannelSplitter(2);
    const left = graph.context.createAnalyser();
    const right = graph.context.createAnalyser();
    graph.volumeNode.connect(tap); tap.connect(left, 0); tap.connect(right, 1);
    const rms = (node: AnalyserNode) => {
      const samples = new Float32Array(node.fftSize);
      node.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    };
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (rms(left) > 0.001 && rms(right) > 0.001) break;
    }
    return { left: rms(left), right: rms(right), playing: audioEngine.playing,
      position: audioEngine.position, duration: audioEngine.duration };
  });
  expect(levels.playing).toBe(true);
  expect(levels.left).toBeGreaterThan(0.001);
  expect(levels.right).toBeGreaterThan(0.001);
  expect(pageErrors).toEqual([]);
});
