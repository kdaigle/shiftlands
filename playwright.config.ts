import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { headless: true, viewport: { width: 1100, height: 850 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
