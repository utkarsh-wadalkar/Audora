import { test, expect } from '@playwright/test';
import { SONGS } from '../lib/songs.generated';

const releases = 'https://github.com/utkarsh-wadalkar/Audora/releases';

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`download funnel renders without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('#download-hero')).toBeInViewport();
    await expect(page.locator('#download-hero')).toHaveAttribute('href', releases);
    await expect(page.locator('.hero-product')).toHaveJSProperty('naturalWidth', 1440);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#download').scrollIntoViewIfNeeded();
    await expect(page.locator('.requirements')).toContainText('Apple Music subscription');
    for (const id of ['download-windows', 'download-linux-deb', 'download-linux-appimage']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
      await expect(page.locator(`#${id}`)).toHaveAttribute('href', releases);
    }
    await page.locator('#faq').scrollIntoViewIfNeeded();
    expect(errors).toEqual([]);
    await page.screenshot({ path: `artifacts/site-${width}.png`, fullPage: true });
  });
}

test('keyboard controls select, play, pause and navigate synchronized songs', async ({ page }) => {
  await page.goto('/');
  await page.locator('.turntable-stage').scrollIntoViewIfNeeded();
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-scene-ready', 'true');
  const canvas = page.locator('.turntable-stage canvas');
  await expect(canvas).toHaveAttribute('data-record-cover', SONGS[0].coverSrc);
  const aerodynamic = page.getByRole('button', { name: `${SONGS[1].title} ${SONGS[1].artist}` });
  await aerodynamic.focus();
  await page.keyboard.press('Enter');
  await expect(aerodynamic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.now-playing h3')).toHaveText(SONGS[1].title);
  await expect(canvas).toHaveAttribute('data-record-cover', SONGS[1].coverSrc);
  const start = page.getByRole('button', { name: 'Start record' });
  await start.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause record' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('audio').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-spinning', 'true');
  await page.getByRole('button', { name: 'Next song' }).click();
  await expect(page.locator('.now-playing h3')).toHaveText(SONGS[2].title);
  await expect(canvas).toHaveAttribute('data-record-cover', SONGS[2].coverSrc);
  await expect(page.locator('audio')).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: 'Previous song' }).click();
  await expect(page.locator('.now-playing h3')).toHaveText(SONGS[1].title);
  await expect(page.locator('audio')).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: 'Pause record' }).focus();
  await page.keyboard.press('Space');
  await expect(start).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('audio')).toHaveJSProperty('paused', true);
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-spinning', 'false');
  const question = page.locator('summary').filter({ hasText: 'Do I need an Apple Music subscription?' });
  await question.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Yes. You need your own active Apple Music subscription', { exact: false })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(question.locator('..')).not.toHaveAttribute('open');
});

test('conversion hook reports intent without intercepting a real link', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.addEventListener('audora:cta', event => { document.documentElement.dataset.lastCta = JSON.stringify((event as CustomEvent).detail); });
    document.addEventListener('click', event => { if ((event.target as Element).closest('#download-windows')) event.preventDefault(); });
  });
  await page.locator('#download-windows').click();
  const detail = await page.locator('html').getAttribute('data-last-cta');
  expect(JSON.parse(detail!)).toEqual({ id: 'download-windows', intent: 'download', platform: 'windows', href: releases });
});

test('static content, downloads and FAQ work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your music. All the detail.' })).toBeVisible();
  await expect(page.locator('#download-hero')).toHaveAttribute('href', releases);
  await page.locator('.turntable-stage').scrollIntoViewIfNeeded();
  await expect(page.locator('.turntable-poster')).toBeVisible();
  await expect(page.locator('.turntable-poster')).toHaveJSProperty('naturalWidth', 1800);
  await expect(page.locator('.song-card')).toHaveCount(SONGS.length);
  await expect(page.locator('audio')).toHaveCount(1);
  await page.getByText('Can I play my downloads offline?', { exact: true }).click();
  await expect(page.getByText('Yes. Finished downloads are local FLAC files.', { exact: false })).toBeVisible();
  await context.close();
});

test('reduced motion, SEO and asset contracts hold', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  expect(await page.locator('.hero-copy').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).scrollBehavior)).toBe('auto');
  await page.locator('.turntable-stage').scrollIntoViewIfNeeded();
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-scene-ready', 'true');
  await page.getByRole('button', { name: 'Start record' }).click();
  await expect.poll(() => page.locator('audio').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-spinning', 'false');
  await expect(page.locator('.motion-note')).toContainText('reduced-motion');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /social-preview\.png$/);
  expect((await request.get('/social-preview.png')).status()).toBe(200);
  expect((await request.get('/sitemap.xml')).status()).toBe(200);
  expect((await request.get('/robots.txt')).status()).toBe(200);
  expect((await request.get('/this-page-does-not-exist')).status()).toBe(404);
  const targets = await page.locator('a[href^="#"]').evaluateAll(links => links.map(link => link.getAttribute('href')).filter(value => value !== '#'));
  for (const target of targets) await expect(page.locator(target!)).toHaveCount(1);
});

test('WebGL context loss restores the sharp static fallback', async ({ page }) => {
  await page.goto('/#experience');
  await page.locator('.turntable-stage').scrollIntoViewIfNeeded();
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-scene-ready', 'true');
  await page.locator('.turntable-stage canvas').evaluate(element => {
    const gl = (element as HTMLCanvasElement).getContext('webgl2');
    gl!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-scene-ready', 'false');
  await expect(page.locator('.turntable-stage canvas')).toHaveCount(0);
  await expect(page.locator('.turntable-poster')).toBeVisible();
  await expect(page.locator('.turntable-poster')).toHaveJSProperty('naturalWidth', 1800);
  await expect(page.getByRole('button', { name: 'Reset turntable view' })).toBeDisabled();
  await page.getByRole('button', { name: 'Start record' }).click();
  await expect.poll(() => page.locator('audio').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
});

test('3D loads near the viewport and draws only during interaction or visible animation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const audioRequests: string[] = [];
  page.on('request', request => { if (/\/audio\.(flac|mp3)(?:$|\?)/.test(request.url())) audioRequests.push(request.url()); });
  await page.addInitScript(() => {
    const prototype = WebGL2RenderingContext.prototype;
    const draw = prototype.drawElements;
    prototype.drawElements = function (...args) {
      document.documentElement.dataset.drawCalls = String(Number(document.documentElement.dataset.drawCalls || 0) + 1);
      return draw.apply(this, args);
    };
  });
  const count = () => page.locator('html').getAttribute('data-draw-calls');
  await page.goto('/');
  await expect(page.locator('.turntable-stage canvas')).toHaveCount(0);
  await page.locator('.turntable-stage').scrollIntoViewIfNeeded();
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-scene-ready', 'true');
  await page.waitForTimeout(250);
  const still = await count();
  await page.waitForTimeout(200);
  expect(await count()).toBe(still);
  expect(audioRequests).toEqual([]);
  await page.getByRole('button', { name: 'Start record' }).click();
  await expect.poll(count).not.toBe(still);
  await page.locator('footer').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const hidden = await count();
  await page.waitForTimeout(200);
  expect(await count()).toBe(hidden);
});

test('every bundled song URL is valid, range-streamable and independent of local paths', async ({ page, request }) => {
  await page.goto('/#experience');
  await expect(page.locator('.song-card')).toHaveCount(SONGS.length);
  expect(await page.locator('html').evaluate(() => document.documentElement.outerHTML.includes('D:\\ALL Programming'))).toBe(false);
  for (const song of SONGS) {
    expect(song.audioSrc).toMatch(/^\/music\/[a-z0-9-]+\/audio\.(flac|mp3)$/);
    expect(song.coverSrc).toMatch(/^\/music\/[a-z0-9-]+\/cover\.webp$/);
    const audioResponse = await request.get(song.audioSrc, { headers: { Range: 'bytes=0-127' } });
    expect(audioResponse.status(), song.title).toBe(206);
    expect(audioResponse.headers()['content-range'], song.title).toMatch(/^bytes 0-127\/\d+$/);
    expect((await request.get(song.coverSrc)).status(), song.title).toBe(200);
  }
});

test('one audio element replaces the active stream during direct and rapid song changes', async ({ page }) => {
  await page.goto('/#experience');
  await page.locator('.turntable-stage').scrollIntoViewIfNeeded();
  await expect(page.locator('.turntable-stage')).toHaveAttribute('data-scene-ready', 'true', { timeout: 15000 });
  await page.getByRole('button', { name: 'Start record' }).click();
  await expect.poll(() => page.locator('audio').evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
  for (const index of [4, 8, 11, 3]) {
    const song = SONGS[index];
    await page.getByRole('button', { name: `${song.title} ${song.artist}` }).click();
    await expect(page.locator('.listening-room')).toHaveAttribute('data-active-song', song.id);
    await expect(page.locator('.now-playing h3')).toHaveText(song.title);
    await expect(page.locator('.turntable-stage canvas')).toHaveAttribute('data-record-cover', song.coverSrc);
    await expect(page.locator('audio')).toHaveAttribute('data-song-id', song.id);
    await expect(page.locator('audio')).toHaveJSProperty('paused', false);
  }
  await expect(page.locator('audio')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pause record' }).click();
});
