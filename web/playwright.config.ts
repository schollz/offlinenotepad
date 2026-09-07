import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:18252',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'firefox', testMatch: /publishing\.spec\.ts/u, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testMatch: /publishing\.spec\.ts/u, use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run build && node scripts/test-server.mjs',
    url: 'http://127.0.0.1:18252/healthz',
    reuseExistingServer: process.env.ONP_REUSE_TEST_SERVER === '1',
    timeout: 120_000,
  },
})
