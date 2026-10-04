import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 30000, workers: 1,
  testIgnore: 'auth.spec.mjs',
  globalSetup: './tests/browser/setup.mjs', reporter: 'list', outputDir: '../test-results/tlh',
  use: { baseURL: 'http://127.0.0.1:4180', headless: true,
    channel: process.env.TLH_BROWSER_CHANNEL || 'msedge', viewport: { width: 1440, height: 1100 } },
});
