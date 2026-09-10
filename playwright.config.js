import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './frontend/tests',
  testMatch: '**/*.spec.js',
  workers: 1,
  use: { baseURL: 'http://localhost:8253', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'node frontend/tests/server.mjs', url: 'http://localhost:8253', timeout: 60000 },
});
