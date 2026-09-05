import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8251',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
  webServer: {
    command: "npm run build && cd .. && DATABASE_URL='' SQLITE_PATH=/tmp/offlinenotepad-e2e.sqlite3 go run ./cmd/offlinenotepad serve",
    url: 'http://127.0.0.1:8251/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
