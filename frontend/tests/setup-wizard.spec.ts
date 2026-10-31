import { expect, test, type Page, type Route } from '@playwright/test';

const system = (running = false) => ({
  platform: { ok: true, label: 'Windows 10/11' },
  docker: {
    installed: true,
    running,
    install_label: 'Docker Desktop',
    download_url: 'https://www.docker.com/products/docker-desktop/',
  },
  wsl2: { applicable: true, ok: true },
  images: { downloader: false, audora_downloader: false, wrapper: false },
});

async function openWizard(page: Page, check: (route: Route) => Promise<void>, events: object[] = []) {
  await page.routeWebSocket(/ws:\/\/localhost:8000\/.*/, (socket) => {
    if (socket.url().endsWith('/ws/setup')) {
      for (const event of events) socket.send(JSON.stringify(event));
    }
  });
  await page.route('http://localhost:8000/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/setup/check') return check(route);
    await route.fulfill({
      json: {
        success: true,
        data: path === '/setup/status' ? { complete: false, ...system() } : [],
        error: null,
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started' }).click();
}

test('initial check shows progress and enables Continue only after the result', async ({ page }) => {
  let pending!: Route;
  await openWizard(page, async (route) => { pending = route; });

  await expect(page.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Checking Docker');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await pending.fulfill({ json: { success: true, data: system(true) } });

  await expect(page.getByRole('status')).toContainText('Check complete. Docker is ready');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await expect(page.getByText('Docker Desktop installed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Getting the components' })).toBeVisible();
});

test('rechecking blocks repeated clicks and explains an unchanged result', async ({ page }, testInfo) => {
  let requests = 0;
  let pending!: Route;
  await openWizard(page, async (route) => {
    requests += 1;
    if (requests === 1) await route.fulfill({ json: { success: true, data: system() } });
    else pending = route;
  });
  const retry = page.getByRole('button', { name: 'Check again', exact: true });
  await expect(page.getByText('Docker Desktop installed', { exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  await retry.evaluate((button) => {
    for (let i = 0; i < 20; i += 1) (button as HTMLButtonElement).click();
  });

  await expect(page.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  await expect.poll(() => requests).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('checking.png') });
  await pending.fulfill({ json: { success: true, data: system() } });

  await expect(page.getByRole('status')).toContainText('Check complete. Open Docker Desktop');
  await expect(retry).toBeEnabled();
  expect(requests).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('checked.png') });
});

test('a failed refresh disables stale Continue and can be retried successfully', async ({ page }) => {
  let requests = 0;
  let pending!: Route;
  await openWizard(page, async (route) => {
    requests += 1;
    if (requests === 2) pending = route;
    else await route.fulfill({ json: { success: true, data: system(true) } });
  });
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  const retry = page.getByRole('button', { name: 'Check again', exact: true });
  await expect(next).toBeEnabled();
  await retry.click();
  await expect(next).toBeDisabled();
  await expect.poll(() => requests).toBe(2);
  await pending.abort('failed');

  await expect(page.getByRole('alert')).toContainText('Could not check your system');
  await expect(next).toBeDisabled();
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(next).toBeEnabled();
});

test('an initial API error offers a retry instead of an endless loader', async ({ page }) => {
  await openWizard(page, async (route) => {
    await route.fulfill({ json: { success: false, data: null, error: 'check failed' } });
  });

  await expect(page.getByRole('alert')).toContainText('Could not check your system');
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  await expect(page.getByText('Looking at your setup…')).toHaveCount(0);
});

test('a timed out check releases the button and explains how to retry', async ({ page }) => {
  let requests = 0;
  await openWizard(page, async () => { requests += 1; });
  await expect.poll(() => requests).toBe(1);

  await expect(page.getByRole('alert')).toContainText('Could not check your system', { timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
});

test('a missing installation provides an actionable result and download link', async ({ page }) => {
  const missing = system();
  missing.docker.installed = false;
  await openWizard(page, async (route) => {
    await route.fulfill({ json: { success: true, data: missing } });
  });

  await expect(page.getByRole('status')).toContainText('Check complete. Install Docker Desktop');
  await expect(page.getByRole('link', { name: 'Get Docker Desktop' })).toHaveAttribute(
    'href', missing.docker.download_url,
  );
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
});

for (const width of [1100, 1280]) {
  test(`FLAC failure stays within the wizard at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const message = 'Could not prepare FLAC conversion (ffmpeg is missing from the downloader image). Click Retry to rebuild it.';
    const events = [
      { type: 'setup_progress', step: 'pull_downloader', status: 'done', message: 'Pulled' },
      { type: 'setup_progress', step: 'build_downloader', status: 'error', message, error: { code: 'unknown', transient: false } },
    ];
    await openWizard(page, async (route) => {
      await route.fulfill({ json: { success: true, data: system(true) } });
    }, events);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Try Again', exact: true })).toBeVisible();

    const row = page.getByText('FLAC support', { exact: true }).locator('..');
    const bounds = await row.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
    await expect(row).toContainText('Needs attention');
    await expect(row.getByText(message, { exact: true })).toHaveCount(0);
    await expect(page.getByText(message, { exact: true })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('flac-failure.png') });
  });
}
