import { expect, test, type Page } from '@playwright/test';

const tracks = [
  { id: 1, file_path: 'C:\\Music\\One.flac', title: 'One', artist: 'Artist', album: 'Album', duration: 180, file_size: 1 },
  { id: 2, file_path: 'C:\\Music\\Two.flac', title: 'Two', artist: 'Artist', album: 'Album', duration: 200, file_size: 1 },
];

test('albums from one folder open independently and a failed rescan keeps the library', async ({ page }) => {
  await openLibrary(page);
  await page.route('http://localhost:8000/library/albums', (route) => route.fulfill({
    json: { success: true, data: tracks.map((track, index) => ({
      id: String(track.id), folder_path: 'C:\\Music', album: `Release ${index + 1}`, tracks: [track],
    })) },
  }));
  await page.getByRole('button', { name: 'Rescan', exact: true }).click();
  await page.getByRole('button', { name: /^albums$/i }).click();
  await page.getByRole('button', { name: 'Open Release 2', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Release 2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play Two', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^albums$/i }).click();
  await page.route('http://localhost:8000/library/scan', (route) => route.fulfill({
    status: 409, json: { detail: 'Reconnect the drive or choose another music folder in Settings, then rescan.' },
  }));
  await page.getByRole('button', { name: 'Rescan', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Reconnect the drive');
  await expect(page.getByRole('button', { name: 'Open Release 1', exact: true })).toBeVisible();
});

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

test('rescan requests the new artwork when a track ID is reassigned', async ({ page }) => {
  await openLibrary(page);
  let current = { ...tracks[0], artwork_revision: 'original-cover' };
  await page.route('http://localhost:8000/library', (route) =>
    route.fulfill({ json: { success: true, data: [current] } }),
  );
  await page.route('http://localhost:8000/library/scan', async (route) => {
    current = { ...tracks[1], id: tracks[0].id, artwork_revision: 'different-cover' };
    await route.fulfill({ json: { success: true, data: { track_count: 1 } } });
  });
  await page.route((url) => url.origin === 'http://localhost:8000' && url.pathname === '/library/art/1', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    }),
  );

  await page.reload();
  const original = page.getByRole('button', { name: 'Play One', exact: true }).locator('img');
  await expect(original).toHaveAttribute('src', /\/1\?v=original-cover$/);
  await page.getByRole('button', { name: 'Rescan', exact: true }).click();
  const replacement = page.getByRole('button', { name: 'Play Two', exact: true }).locator('img');
  await expect(replacement).toHaveAttribute('src', /\/1\?v=different-cover$/);
  await expect(original).toHaveCount(0);
});

test('fallback covers vary by file and survive a rescan or missing embedded artwork', async ({ page }) => {
  await openLibrary(page);
  const thirdTrack = { ...tracks[1], file_path: 'C:\\Music\\Three.flac', title: 'Three' };
  let library: (typeof tracks[number] & { artwork_revision?: string })[] = [tracks[0], thirdTrack];
  await page.route('http://localhost:8000/library', (route) =>
    route.fulfill({ json: { success: true, data: library } }),
  );
  await page.route('http://localhost:8000/library/scan', (route) => {
    library = [{ ...tracks[0], id: 3, artwork_revision: 'missing-art' }, thirdTrack];
    return route.fulfill({ json: { success: true, data: { track_count: library.length } } });
  });

  await page.reload();
  const firstCover = page.getByRole('button', { name: 'Play One', exact: true }).locator('img');
  const thirdCover = page.getByRole('button', { name: 'Play Three', exact: true }).locator('img');
  await expect.poll(() => firstCover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => thirdCover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const firstSrc = await firstCover.getAttribute('src');
  expect(firstSrc).not.toBe(await thirdCover.getAttribute('src'));

  const failedCoverRequest = page.waitForResponse((response) =>
    response.url().includes('/library/art/3?v=missing-art') && response.status() === 404,
  );
  await page.getByRole('button', { name: 'Rescan', exact: true }).click();
  await failedCoverRequest;
  await expect(firstCover).toHaveAttribute('src', firstSrc!);
});

test('an untagged or unreadable library entry shows its name and fallback artwork', async ({ page }) => {
  await openLibrary(page);
  const untagged = {
    id: 3,
    file_path: 'E:\\Music\\01. Untagged recording.flac',
    title: '01. Untagged recording',
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    duration: 0,
    file_size: 100,
  };
  await page.route('http://localhost:8000/library', (route) =>
    route.fulfill({ json: { success: true, data: [untagged] } }),
  );
  await page.reload();
  await page.getByPlaceholder('Search this library').fill('Untagged recording.flac');
  const entry = page.getByRole('button', { name: 'Play 01. Untagged recording', exact: true });
  await expect(entry.getByText('Unknown Artist')).toBeVisible();
  await expect(entry.locator('img')).toHaveAttribute('src', /track-artwork\/.*\.png/);
  await expect(page.getByTitle('Duration unavailable')).toHaveText('—');
  await entry.click();
  await expect(page.getByRole('alert')).toContainText('The audio may be damaged or use an unsupported format');
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
  const audioEffectsLink = page.getByRole('navigation').getByRole('link', { name: 'Audio effects' });
  await audioEffectsLink.click();
  await expect(page.getByRole('heading', { name: 'Audio effects' })).toBeVisible();
  await expect(audioEffectsLink).toHaveAttribute('aria-current', 'page');
  const graph = page.getByRole('group', { name: 'Equalizer response graph' });
  await graph.dblclick({ position: { x: 300, y: 105 } });
  const point = graph.getByRole('button', { name: /Band 1,/ });
  const originalPosition = await point.boundingBox();
  if (!originalPosition) throw new Error('The new EQ point is missing');
  const { x, y, width, height } = originalPosition;
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width / 2 + 100, y + height / 2 - 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await point.boundingBox())?.x).toBeGreaterThan(x + 80);
  await page.getByRole('button', { name: 'Undo EQ change' }).click();
  await expect.poll(async () => (await point.boundingBox())?.x).toBeCloseTo(x, 0);
  await page.getByRole('button', { name: 'Redo EQ change' }).click();
  await expect.poll(async () => (await point.boundingBox())?.x).toBeGreaterThan(x + 80);
  const frequency = page.getByRole('spinbutton', { name: 'Frequency (Hz)' });
  await frequency.fill('1234.5');
  await frequency.press('Enter');
  await expect(point).toHaveAccessibleName(/1234.5 Hz/);
  await expect(page.getByRole('tab', { name: 'Playback', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.getByLabel('Stereo width').fill('150');
  await page.getByLabel('Crossfade duration').fill('3');
  await page.reload();
  await expect(page.getByLabel('Enable equalizer')).toBeChecked();
  await expect(point).toHaveAccessibleName(/1234.5 Hz/);
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByLabel('Stereo width')).toHaveValue('150');
  await expect(page.getByLabel('Crossfade duration')).toHaveValue('3');
  const output = page.getByLabel('Audio output');
  if (await output.isDisabled()) await expect(page.getByText('cannot select an output device')).toBeVisible();
  else {
    await expect(output.locator('option[value=""]')).toHaveText('System default');
    await output.selectOption('');
    await expect(page.getByRole('status')).toContainText('Audio output changed');
  }
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByLabel('Enable equalizer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open audio effects' }).click();
  await expect(page.getByLabel('Enable equalizer')).toBeChecked();
  await point.focus();
  await point.press('Delete');
  await expect(point).toHaveCount(0);
});

test('a custom EQ can be restored after applying Flat and reloading', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('audora.audio.v1')) {
      localStorage.setItem('audora.audio.v1', JSON.stringify({
        eqEnabled: false,
        equalizer: {
          preamp: -4.2,
          twoPass: true,
          bands: [{ id: 'custom', frequency: 1712.5, gain: -1.7, q: 1.3, type: 'peaking' }],
        },
      }));
    }
  });
  await openLibrary(page);
  await page.getByRole('link', { name: 'Audio effects' }).click();
  const undo = page.getByRole('button', { name: 'Undo EQ change' });
  const redo = page.getByRole('button', { name: 'Redo EQ change' });
  const preset = page.getByRole('combobox', { name: 'Preset' });
  const point = page.getByRole('button', { name: /Band 1, 1712.5 Hz, -1.7 dB/ });
  const preamp = page.getByRole('spinbutton', { name: 'Preamp (dB)' });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  await expect(preset.locator('option')).toHaveText(['Choose a preset', 'Flat']);
  await preset.selectOption('Flat');
  await expect(point).toHaveCount(0);
  await expect(preamp).toHaveValue('0');
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    const button = document.createElement('button');
    button.textContent = 'Close test modal';
    button.onclick = () => dialog.remove();
    dialog.append(button);
    document.body.append(dialog);
    dialog.showModal();
  });
  await page.getByRole('button', { name: 'Close test modal' }).press('Control+z');
  await expect(point).toHaveCount(0);
  await page.getByRole('button', { name: 'Close test modal' }).click();
  await preset.press('Control+z');
  await expect(point).toBeVisible();
  await expect(preamp).toHaveValue('-4.2');
  await expect(page.getByLabel('Enable equalizer')).not.toBeChecked();
  await preset.press('Control+Shift+z');
  await expect(point).toHaveCount(0);
  await page.reload();
  await undo.click();
  await expect(point).toBeVisible();
  await expect(page.getByLabel('2 Pass')).toBeChecked();
  await page.getByRole('button', { name: 'Select band 1' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Q (bandwidth)' })).toHaveValue('1.3');
  await preamp.fill('-5');
  await preamp.press('Enter');
  await expect(redo).toBeDisabled();
});

test('a late speaker failure cannot overwrite EQ changes after leaving Audio effects', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('audora.audio.v1', JSON.stringify({ outputDeviceId: 'unavailable-speaker' }));
    const rejectSpeakerRequests: (() => void)[] = [];
    Object.assign(window, { rejectSpeakerRequests });
    Object.defineProperty(AudioContext.prototype, 'setSinkId', {
      configurable: true,
      value: (deviceId: string) => deviceId ? new Promise<void>((_resolve, reject) => {
        rejectSpeakerRequests.push(() => reject(new Error('The selected speaker no longer exists')));
      }) : Promise.resolve(),
    });
  });
  await openLibrary(page);
  const nav = page.getByRole('navigation');
  const effects = nav.getByRole('link', { name: 'Audio effects' });
  const pendingCalls = () => page.evaluate(() =>
    (window as unknown as { rejectSpeakerRequests: (() => void)[] }).rejectSpeakerRequests.length);
  await effects.click();
  await expect.poll(pendingCalls).toBeGreaterThan(0);
  const previousRequests = await pendingCalls();
  await nav.getByRole('link', { name: 'Library' }).click();
  await effects.click();
  await expect.poll(pendingCalls).toBeGreaterThan(previousRequests);
  await page.getByRole('button', { name: 'Add band' }).click();

  await page.evaluate(async (count) => {
    const requests = (window as unknown as { rejectSpeakerRequests: (() => void)[] }).rejectSpeakerRequests;
    requests.slice(0, count).forEach((rejectRequest) => rejectRequest());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, previousRequests);
  const storedBands = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('audora.audio.v1') || '{}').equalizer?.bands?.length);
  expect(storedBands).toBe(1);
});

test('spatializer sliders use VLC points and preserve an existing room mix', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('audora.audio.v1')) {
      localStorage.setItem('audora.audio.v1', JSON.stringify({ spatializer: false, spatialMix: 0.28 }));
    }
  });
  await openLibrary(page);
  await page.getByRole('link', { name: 'Audio effects' }).click();
  const tab = page.getByRole('tab', { name: 'Spatializer' });
  await tab.click();
  const toggle = page.getByRole('checkbox', { name: 'Enable spatializer' });
  const controls = [
    { label: 'Size', min: 0, max: 11, migrated: 8, selected: 11 },
    { label: 'Width', min: 0, max: 10, migrated: 10, selected: 6 },
    { label: 'Wet', min: 0, max: 10, migrated: 3, selected: 9 },
    { label: 'Dry', min: 0, max: 10, migrated: 7, selected: 3 },
    { label: 'Damp', min: 0, max: 10, migrated: 0, selected: 2 },
  ];
  const slider = (label: string) => page.getByRole('slider', { name: label, exact: true });

  for (const { label, min, max, migrated } of controls) {
    await expect(slider(label)).toBeDisabled();
    await expect(slider(label)).toHaveAttribute('min', String(min));
    await expect(slider(label)).toHaveAttribute('max', String(max));
    await expect(slider(label)).toHaveAttribute('step', '1');
    await expect(slider(label)).toHaveValue(String(migrated));
  }
  await toggle.check();
  for (const { label, selected } of controls) await slider(label).fill(String(selected));
  await page.reload();
  await tab.click();
  await expect(toggle).toBeChecked();
  for (const { label, selected } of controls) await expect(slider(label)).toHaveAttribute('aria-valuetext', selected.toFixed(1));
});

test('the compressor, stereo widener and pitch tabs expose and save their controls', async ({ page }) => {
  await openLibrary(page);
  await page.getByRole('link', { name: 'Audio effects' }).click();
  const selectTab = (name: string) => page.getByRole('tab', { name, exact: true }).click();
  await selectTab('Compressor');
  await expect(page.getByRole('tabpanel').getByRole('slider')).toHaveCount(7);
  await page.getByRole('checkbox', { name: 'Enable compressor' }).check();
  const attack = page.getByRole('slider', { name: 'Attack' });
  await expect(attack).toHaveAttribute('min', '1.5');
  await expect(attack).toHaveAttribute('max', '400');
  await attack.fill('12.5');
  await selectTab('Stereo Widener');
  await expect(page.getByRole('tabpanel').getByRole('slider')).toHaveCount(4);
  await page.getByRole('checkbox', { name: 'Enable stereo widener' }).check();
  const feedback = page.getByRole('slider', { name: 'Feedback gain' });
  await feedback.fill('0.4');
  await selectTab('Advanced');
  const pitch = page.getByRole('checkbox', { name: 'Enable pitch adjustment' });
  await pitch.click();
  await expect(pitch).toBeChecked();
  const adjustPitch = page.getByRole('slider', { name: 'Adjust pitch' });
  await expect(adjustPitch).toBeEnabled();
  await expect(adjustPitch).toHaveAttribute('step', '0.25');
  await adjustPitch.fill('-2.25');
  await page.reload();
  await selectTab('Compressor');
  await expect(attack).toHaveValue('12.5');
  await selectTab('Stereo Widener');
  await expect(feedback).toHaveValue('0.4');
  await selectTab('Advanced');
  await expect(pitch).toBeChecked();
  await expect(adjustPitch).toHaveValue('-2.25');
});

test('the EQ response and audio gain follow the same filters and two-pass setting', async ({ page }) => {
  await openLibrary(page);
  const measured = await page.evaluate(async () => {
    const { createEqResponse, createParametricEq, readEqSettings } = await import('/src/lib/parametricEq.ts');
    const rate = 48000;
    const frequency = 1324;
    const settings = readEqSettings({ preamp: -2, twoPass: true, bands: [
      { id: 'one', frequency, gain: 6, q: 2, type: 'peaking' },
    ] });
    const response = createEqResponse(rate)(settings, new Float32Array([frequency]))[0];
    const migration = readEqSettings(undefined, [4, 0, -2]).bands;
    const context = new OfflineAudioContext(1, rate, rate);
    const tone = context.createOscillator();
    const level = context.createGain();
    level.gain.value = 0.1;
    tone.frequency.value = frequency;
    tone.connect(level);
    createParametricEq(context, level, context.destination)(true, settings);
    tone.start();
    const buffer = await context.startRendering();
    const samples = buffer.getChannelData(0).subarray(rate / 2);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value ** 2, 0) / samples.length);
    return { response, db: 20 * Math.log10(rms / (0.1 / Math.sqrt(2))), migration };
  });
  expect(measured.response).toBeCloseTo(10, 1);
  expect(measured.db).toBeCloseTo(measured.response, 1);
  expect(measured.migration).toMatchObject([
    { frequency: 60, gain: 4, type: 'lowshelf' },
    { frequency: 310, gain: -2, type: 'peaking' },
  ]);
});

test('spatializer sliders change the rendered audio and disabling it bypasses the effect', async ({ page }) => {
  await openLibrary(page);
  const levels = await page.evaluate(async () => {
    const { createSpatializer, DEFAULT_SPATIALIZER } = await import('/src/lib/spatializer.ts');
    const rate = 48000;
    async function render(patch: Partial<typeof DEFAULT_SPATIALIZER>, enabled = true) {
      const context = new OfflineAudioContext(2, rate, rate);
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, rate);
      source.buffer.getChannelData(0)[0] = 1;
      createSpatializer(context, source, context.destination)(enabled, { size: 11, width: 10, wet: 10, dry: 0, damp: 0, ...patch });
      source.start();
      const buffer = await context.startRendering();
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      return {
        firstSample: left[0],
        energy: left.reduce((sum, value) => sum + value ** 2, 0),
        tail: left.subarray(rate / 5).reduce((sum, value) => sum + value ** 2, 0),
        stereo: left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0),
      };
    }
    const [room, small, narrow, damped, silent, dry, bypass] = await Promise.all([
      render({}), render({ size: 0 }), render({ width: 0 }), render({ damp: 10 }),
      render({ wet: 0 }), render({ wet: 0, dry: 3 }), render({}, false),
    ]);
    return { room, small, narrow, damped, silent, dry, bypass };
  });
  expect(levels.room.tail).toBeGreaterThan(0.00001);
  expect(levels.small.tail).toBeLessThan(levels.room.tail / 100);
  expect(levels.room.stereo).toBeGreaterThan(0.001);
  expect(levels.narrow.stereo).toBeLessThan(0.000001);
  expect(levels.damped.energy).toBeLessThan(levels.room.energy);
  expect(levels.silent.energy).toBe(0);
  expect(levels.dry.firstSample).toBeCloseTo(0.3);
  expect(levels.bypass.firstSample).toBe(1);
  expect(levels.bypass.tail).toBe(0);
});

test('local time stamped lyrics open from the player', async ({ page }) => {
  await openLibrary(page);
  await page.getByRole('button', { name: 'Play One', exact: true }).click();
  await page.getByRole('button', { name: 'Show lyrics' }).click();
  await expect(page.getByRole('button', { name: 'Hello' })).toBeVisible();
});

test('the status bar guides the user through downloading and installing an update', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { phase: 'available', version: '2.0.6' };
    let notify = (_state: object) => {};
    Object.assign(window, {
      electronAPI: {
        getUpdateState: async () => state,
        onUpdateState: (callback: typeof notify) => {
          notify = callback;
          return () => { notify = () => {}; };
        },
        downloadUpdate: async () => notify({ ...state, phase: 'downloading', percent: 42 }),
        installUpdate: async () => notify({ ...state, phase: 'installing' }),
      },
      finishUpdateDownload: () => notify({ ...state, phase: 'ready' }),
    });
  });
  await openLibrary(page);
  await page.getByRole('button', { name: 'Update available' }).click();
  const dialog = page.getByRole('dialog', { name: 'Audora 2.0.6' });
  await dialog.getByRole('button', { name: 'Download update' }).click();
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '42');
  await page.evaluate(() => (window as unknown as { finishUpdateDownload: () => void }).finishUpdateDownload());
  await dialog.getByRole('button', { name: 'Restart and install' }).click();
  await expect(dialog.getByText('Installing the update and restarting Audora…')).toBeVisible();
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
    // AudioParam.value reflects the last rendered quantum after automation.
    const nextQuantum = graph.context.currentTime + 256 / graph.context.sampleRate;
    for (let attempt = 0; attempt < 10 && graph.context.currentTime < nextQuantum; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
