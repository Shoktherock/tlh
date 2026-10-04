import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser',testMatch:'auth.spec.mjs',timeout:30000,workers:1,
  globalSetup:'./tests/browser/auth-setup.mjs',reporter:'list',outputDir:'../test-results/accounts-browser',
  use:{baseURL:'http://127.0.0.1:4181',headless:true,channel:process.env.TLH_BROWSER_CHANNEL || 'msedge',viewport:{width:1440,height:1100}},
});
