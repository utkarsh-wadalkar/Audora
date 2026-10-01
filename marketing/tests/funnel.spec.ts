import { test, expect } from '@playwright/test';

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

test('live evidence, moderated reviews and feedback states work', async ({ page }) => {
  await page.route('**/api/visits', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
  await page.route('**/api/evidence', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ evidence: {
      thisMonth: 19,
      lastMonth: 12,
      visitorsTotal: 31,
      publishedReviews: 1,
      dailyVisitors: [
        { date: '2026-08-26', count: 1 }, { date: '2026-08-27', count: 2 },
        { date: '2026-08-28', count: 0 }, { date: '2026-08-29', count: 3 },
      ],
    }, reviews: [{
      id: 1, name: 'Test Listener', role: 'Audio enthusiast', rating: 5,
      message: 'Audora keeps the download flow clear and makes my local lossless library easy to enjoy.', published_at: '2026-09-08T00:00:00Z',
    }] }),
  }));
  await page.route('https://api.github.com/repos/utkarsh-wadalkar/Audora/releases?per_page=100', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify([{ draft: false, assets: [{ download_count: 42 }] }]),
  }));

  let savedFeedback: Record<string, unknown> | undefined;
  await page.route('**/api/feedback', async route => {
    savedFeedback = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('/');
  await page.locator('#community').scrollIntoViewIfNeeded();
  await expect(page.getByText('19', { exact: true })).toBeVisible();
  await expect(page.getByText('This month', { exact: true })).toBeVisible();
  await expect(page.getByText('Last month', { exact: true })).toBeVisible();
  await expect(page.getByText('Total', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Daily first-time visitor activity' })).toBeVisible();
  await expect(page.getByText('42 verified release downloads on GitHub', { exact: true })).toBeVisible();
  await expect(page.getByText('Test Listener')).toBeVisible();
  await expect(page.getByLabel('5 out of 5 stars')).toBeVisible();

  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Audora Tester');
  await page.getByRole('textbox', { name: 'Email optional', exact: true }).fill('listener@example.com');
  await page.getByRole('textbox', { name: 'Role or company optional', exact: true }).fill('Independent listener');
  await page.getByRole('button', { name: '5 stars' }).click();
  await page.getByLabel('Your feedback').fill('The Windows and Linux download choices are clear, and the player feels focused.');
  await page.getByLabel('You may publish my name, role, rating, and review on this website.').check();
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.getByText('Thank you. Your feedback has been saved.')).toBeVisible();
  expect(savedFeedback).toMatchObject({ name: 'Audora Tester', rating: 5, consentToPublish: true });
});

test('feedback API rejects non-string messages before database access', async ({ request }) => {
  const response = await request.post('/api/feedback', {
    data: {
      submissionToken: '0ff8e896-c8d8-4e66-b22c-450288f75c70',
      name: 'Audora Tester', email: '', role: '', rating: 5,
      message: { text: "'); DROP TABLE feedback_submissions; --" },
      consentToPublish: false, company: '',
    },
  });
  expect(response.status()).toBe(400);
});

test('static content, downloads and FAQ work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Music worth keeping.' })).toBeVisible();
  await expect(page.locator('#download-hero')).toHaveAttribute('href', releases);
  await expect(page.getByRole('heading', { name: 'The listening room is being refreshed.' })).toBeVisible();
  await page.getByText('Can I play my downloads offline?', { exact: true }).click();
  await expect(page.getByText('Yes. Finished downloads are local FLAC files.', { exact: false })).toBeVisible();
  await context.close();
});

test('reduced motion, SEO and asset contracts hold', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  expect(await page.locator('.hero-copy').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).scrollBehavior)).toBe('auto');
  await expect(page.getByRole('heading', { name: 'The listening room is being refreshed.' })).toBeVisible();
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /social-preview\.png$/);
  expect((await request.get('/social-preview.png')).status()).toBe(200);
  expect((await request.get('/sitemap.xml')).status()).toBe(200);
  expect((await request.get('/robots.txt')).status()).toBe(200);
  expect((await request.get('/this-page-does-not-exist')).status()).toBe(404);
  const targets = await page.locator('a[href^="#"]').evaluateAll(links => links.map(link => link.getAttribute('href')).filter(value => value !== '#'));
  for (const target of targets) await expect(page.locator(target!)).toHaveCount(1);
});

test('retired public music URLs are unavailable', async ({ page, request }) => {
  await page.goto('/#experience');
  await expect(page.locator('audio, .song-card')).toHaveCount(0);
  for (const url of [
    '/music/aerodynamic-daft-punk/audio.flac',
    '/music/a-dark-knight-james-newton-howard-hans-zimmer/audio.mp3',
    '/music/aerodynamic-daft-punk/cover.webp',
    '/images/turntable-poster.webp',
  ]) {
    expect((await request.get(url)).status(), url).toBe(404);
  }
});
