import { expect, test, type Page } from '@playwright/test';

const tracks = [
  { id: 1, file_path: 'C:\\Music\\One.flac', title: 'One', artist: 'Artist', album: 'Album', duration: 180, file_size: 1 },
  { id: 2, file_path: 'C:\\Music\\Two.flac', title: 'Two', artist: 'Artist', album: 'Album', duration: 200, file_size: 1 },
];

async function openLibrary(page: Page) {
  const playlists: { id: number; name: string; tracks: { entry_id: number; file_path: string; track: typeof tracks[number] }[] }[] = [];
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
