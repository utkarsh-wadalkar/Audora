import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distIndex = join(__dirname, 'dist', 'index.html');
const html = readFileSync(distIndex, 'utf-8');

const browser = await chromium.launch();
const page = await browser.newPage();

await page.setContent(html, { waitUntil: 'networkidle' });

const sizes = [
  { width: 1400, height: 900, label: 'default' },
  { width: 1200, height: 800, label: 'min' },
];

for (const { width, height, label } of sizes) {
  await page.setViewportSize({ width, height });
  await page.screenshot({
    path: `visual-qa-${label}-${width}x${height}.png`,
    fullPage: false,
  });
  console.log(`✓ ${label} ${width}×${height}`);
}

await browser.close();
