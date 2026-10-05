import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Keep browser tests out of Vitest's *.test / *.spec discovery.
  testMatch: '**/*.pw.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Match CI locally and avoid CPU contention between simultaneous SVG renders.
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: 'test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/results.xml' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4333',
    ...devices['Desktop Chrome'],
    viewport: { width: 1365, height: 768 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Build first with browser:check, or use the existing CI production build.
    command: 'node e2e/preview.mjs',
    url: 'http://127.0.0.1:4333',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
