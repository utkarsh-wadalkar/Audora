import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3000', channel: 'chrome', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/next/dist/bin/next start --port 3000', url: 'http://127.0.0.1:3000', reuseExistingServer: !process.env.CI },
});
