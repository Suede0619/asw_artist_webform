import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4187';
const root = resolve('data/test');
mkdirSync(root, { recursive: true });
process.env.ASW_BROWSER_DATA ||= mkdtempSync(join(root, 'browser-'));

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  timeout: 70_000,
  use: {
    baseURL,
    ...(process.env.PLAYWRIGHT_USE_BUNDLED === '1' ? {} : { channel: 'chrome' }),
    launchOptions: { args: ['--disable-background-networking'] },
  },
  webServer: {
    command: 'node server/index.mjs',
    url: baseURL + '/api/health',
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test', PORT: '4187', HOST: '127.0.0.1', PUBLIC_URL: baseURL,
      DATA_DIR: process.env.ASW_BROWSER_DATA, SMTP_URL: '', MAIL_QUEUE_KEY: 'ad'.repeat(32),
      MAIL_FROM: 'Southwest Arts <preview@example.test>', REPLY_TO: '', TRUST_PROXY_HOPS: '0',
      REVIEWER_PASSWORD: 'fictional-review-password-for-browser-test',
    },
  },
});
