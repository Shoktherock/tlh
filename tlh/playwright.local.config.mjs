import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/local',timeout:60000,workers:1,
  globalSetup:'./tests/browser/setup.mjs',reporter:'list',outputDir:'../test-results/accounts-local',
  use:{baseURL:'http://127.0.0.1:4180',headless:true,channel:process.env.TLH_BROWSER_CHANNEL || 'msedge',viewport:{width:1440,height:1100}},
});
