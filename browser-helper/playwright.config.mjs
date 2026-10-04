import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', timeout: 30000, workers: 1,
  globalSetup: './tests/browser/setup.mjs',
  reporter: 'list', outputDir: '../test-results/helper',
  use: { baseURL: 'http://127.0.0.1:4173', headless: true,
    channel: process.env.TLH_BROWSER_CHANNEL || 'msedge', viewport: { width: 1400, height: 1000 } },
});

