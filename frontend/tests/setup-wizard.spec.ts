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
  await page.getByRole('button', { name: 'Set up Apple Music downloads' }).click();
}

test('existing music opens and stays available without download setup', async ({ page }) => {
  const folder = 'E:\\My Music';
  let configured = false;
  let rejectConnection = true;
  let systemChecks = 0;
  const downloadRequests: string[] = [];
  await page.addInitScript((selection) => {
    Object.assign(window, { electronAPI: { selectFolder: async () => selection } });
  }, folder);
  const track = { id: 1, title: 'Local song', file_path: folder + '\\Local song.flac', duration: 60, file_size: 120 };
  await page.routeWebSocket(/ws:\/\/localhost:8000\/.*/, (socket) => {
    downloadRequests.push(new URL(socket.url()).pathname);
  });
  await page.route('http://localhost:8000/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/setup/local-library') {
      if (route.request().postDataJSON().folder !== folder) {
        return route.fulfill({ status: 400, json: { detail: 'Choose an existing music folder Audora can read.' } });
      }
      if (rejectConnection) {
        rejectConnection = false;
        return route.fulfill({ status: 403, json: { detail: 'Unauthorized desktop request' } });
      }
      configured = true;
      return route.fulfill({ json: { success: true, data: { track_count: 1 } } });
    }
    if (url.pathname === '/setup/check') systemChecks++;
    if (url.pathname.startsWith('/docker/') || url.pathname.startsWith('/auth/') ||
        (url.pathname === '/setup/status' && url.searchParams.get('include_system') !== 'false')) {
      downloadRequests.push(url.pathname);
    }
    const data = url.pathname === '/setup/status' ? { complete: false, library_only: configured, ...system(true) } :
      url.pathname === '/setup/check' ? system(true) :
      url.pathname === '/settings' ? { library_path: folder, downloads_path: 'C:\\Downloads' } :
      url.pathname === '/library' && configured ? [track] : [];
    await route.fulfill({ json: { success: true, data } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with local music' }).click();
  const open = page.getByRole('button', { name: 'Open library' });
  await expect(page.getByRole('heading', { name: 'Already have music downloaded?' })).toBeVisible();
  await expect(open).toBeDisabled();
  await page.getByLabel('Music folder', { exact: true }).fill('E:\\Missing');
  await open.click();
  await expect(page.getByRole('alert')).toContainText('reconnect the drive');
  const input = page.getByLabel('Music folder', { exact: true });
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await open.click();
  await expect(page.getByRole('alert')).toContainText('local service rejected the connection');
  await expect(input).toHaveValue(folder);
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  await open.click();
  await expect(page.getByRole('button', { name: 'Play Local song', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Play Local song', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByLabel('Music library folder', { exact: true })).toHaveValue(folder);
  expect(downloadRequests).toEqual([]);
  expect(systemChecks).toBe(0);

  await page.getByRole('link', { name: 'Download', exact: true }).click();
  await page.getByRole('button', { name: 'Set up downloads' }).click();
  await expect(page.getByRole('heading', { name: 'Checking your system' })).toBeVisible();
  await expect.poll(() => systemChecks).toBe(1);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.getByRole('button', { name: 'Play Local song', exact: true })).toBeVisible();
});

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

  await expect(page.getByRole('alert')).toContainText('couldn’t reach its local service');
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

test('a rejected desktop connection points to recovery without blaming Docker', async ({ page }) => {
  await openWizard(page, async (route) => {
    await route.fulfill({ status: 403, json: { detail: 'Unauthorized desktop request' } });
  });
  await expect(page.getByRole('alert')).toContainText('local service rejected the connection');
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Back to setup options' })).toBeEnabled();
});

test('a timed out check releases the button and explains how to retry', async ({ page }) => {
  let requests = 0;
  await openWizard(page, async () => { requests += 1; });
  await expect.poll(() => requests).toBe(1);

  await expect(page.getByRole('alert')).toContainText('took too long to respond', { timeout: 20000 });
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
