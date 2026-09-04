// Capture the real, unmodified desktop renderer with a public demonstration
// catalog. No personal app database, session, credentials, or music is read.
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, 'artifacts/capture');
const output = resolve(root, 'public/images');
await mkdir(artifacts, { recursive: true });
await mkdir(output, { recursive: true });

const queries = [
  'Random Access Memories',
  'Currents',
  'In Rainbows',
  'Bon Iver',
  'Khruangbin',
  'Frank Ocean',
];
const artists = ['Daft Punk', 'Tame Impala', 'Radiohead', 'Bon Iver', 'Khruangbin', 'Frank Ocean'];
const albums = [];
const tracks = [];
const artworks = new Map();
async function fetchPublic(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch(url, { signal: AbortSignal.timeout(15000) }); }
    catch (error) { if (attempt === 2) throw error; }
  }
}
for (const query of queries) {
  console.log(`Preparing demonstration album: ${query}`);
  const cache = resolve(artifacts, `${albums.length}.json`);
  let record;
  try { record = JSON.parse(await readFile(cache, 'utf8')); }
  catch {
    const search = await fetchPublic(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=25&country=us`);
    if (!search.ok) throw new Error(`Album lookup failed: ${search.status}`);
    const album = (await search.json()).results.find(item => item.artistName === artists[albums.length]);
    if (!album) throw new Error(`No public album metadata for ${query}`);
    const lookup = await fetchPublic(`https://itunes.apple.com/lookup?id=${album.collectionId}&entity=song&country=us`);
    if (!lookup.ok) throw new Error(`Track lookup failed: ${lookup.status}`);
    record = { album, songs: (await lookup.json()).results.filter(item => item.kind === 'song') };
    await writeFile(cache, JSON.stringify(record));
  }
  const { album, songs } = record;
  const artPath = resolve(artifacts, `${albums.length}.jpg`);
  let artwork;
  try { artwork = await readFile(artPath); }
  catch {
    const image = await fetchPublic(album.artworkUrl100.replace('100x100bb', '600x600bb'));
    if (!image.ok) throw new Error(`Artwork failed: ${image.status}`);
    artwork = Buffer.from(await image.arrayBuffer());
    await writeFile(artPath, artwork);
  }
  const albumTracks = songs.map(song => ({
    id: tracks.length + songs.indexOf(song) + 1,
    title: song.trackName,
    artist: album.artistName,
    album: album.collectionName,
    duration: Math.round(song.trackTimeMillis / 1000),
    file_size: 0,
    file_path: `/Demonstration/${album.artistName}/${album.collectionName}/${song.trackNumber}.flac`,
    format: 'FLAC',
  }));
  for (const track of albumTracks) artworks.set(track.id, artwork);
  tracks.push(...albumTracks);
  albums.push({ folder_path: `/Demonstration/${album.collectionName}`, artist: album.artistName, album: album.collectionName, tracks: albumTracks });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await page.route('http://localhost:8000/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/library/art/')) {
      return route.fulfill({ contentType: 'image/jpeg', body: artworks.get(Number(path.split('/').pop())) });
    }
    if (path.startsWith('/library/stream/')) return route.abort();
    const data = {
      '/library': tracks,
      '/library/albums': albums,
      '/history': [],
      '/queue': [],
      '/setup/status': { complete: true },
      '/docker/status': { running: true },
      '/wrapper/status': { running: true },
      '/auth/status': { logged_in: true },
      '/settings': { download_dir: '/Music', format: 'FLAC' },
    }[path] ?? {};
    await route.fulfill({ json: { success: true, data }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto(process.env.AUDORA_RENDERER_URL || 'http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await page.getByText('Your albums', { exact: true }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
  });
  await page.screenshot({ path: resolve(artifacts, 'listen.png') });
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'albums', exact: true }).click();
  await page.screenshot({ path: resolve(artifacts, 'library.png') });
  await page.getByRole('link', { name: 'Download', exact: true }).click();
  await page.screenshot({ path: resolve(artifacts, 'download.png') });
  for (const name of ['listen', 'library', 'download']) {
    await sharp(resolve(artifacts, `${name}.png`)).webp({ quality: 88 }).toFile(resolve(output, `audora-${name}.webp`));
  }
  await writeFile(resolve(artifacts, 'sources.json'), JSON.stringify(albums.map((album, i) => ({
    artist: album.artist, album: album.album, query: queries[i], source: 'Apple iTunes public metadata API',
  })), null, 2));
  console.log('Captured Listen, Library, Download from the actual Audora renderer.');
} finally { await browser.close(); }
