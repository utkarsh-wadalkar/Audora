import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:3000/#experience');
  await page.locator('.turntable-stage').scrollIntoViewIfNeeded();
  await page.waitForSelector('.turntable-stage[data-scene-ready="true"]', { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const capture = await page.locator('.turntable-stage canvas').screenshot();
  if (!process.argv.includes('--screenshots-only')) {
    await sharp(capture).resize({ width: 1800, height: 1040, fit: 'contain', background: '#171815' }).webp({ quality: 95 }).toFile(resolve(root, 'public/images/turntable-poster.webp'));
  }
  await page.locator('#experience').screenshot({ path: resolve(root, 'artifacts/turntable-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#experience').screenshot({ path: resolve(root, 'artifacts/turntable-mobile.png') });
  console.log(JSON.stringify({ errors, poster: '1800 × 1040 WebP', canvas: await page.locator('canvas').getAttribute('data-model') }));
} finally { await browser.close(); }
