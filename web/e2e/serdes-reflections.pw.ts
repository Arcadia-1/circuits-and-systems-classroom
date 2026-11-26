import { test as base, expect, type Page } from '@playwright/test';

const lesson = '/serdes/reflections-and-224g-eq/';

const test = base.extend<{ browserAudit: void }>({
  browserAudit: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await use();
    expect(errors, 'No uncaught browser exception during any interaction').toEqual([]);
  }, { auto: true }],
});

async function ready(page: Page) {
  await expect(page.getByRole('region', { name: 'Guided walkthrough', exact: true })).toBeVisible();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Travelling wave and impedance discontinuity visualizer', exact: true })).toBeVisible();
}

test('first load, guided walkthrough, T-coil, 44-tap FFE and MLSE comparisons work cleanly', async ({ page }) => {
  await page.goto(lesson);
  await ready(page);

  // Step 3: Bridged T-coil OFF vs ON dramatically improves S11 and S21
  await page.getByRole('tab', { name: '3 · T-coil matching' }).click();
  await expect(page.getByText('Why TX/RX pads need a bridged T-coil')).toBeVisible();
  await expect(page.getByText('T-coil OFF: bare')).toBeVisible();
  await page.getByRole('group', { name: 'Bridged T-coil matching' }).getByRole('button', { name: 'On (50 Ω)' }).click();
  await expect(page.getByText('Bridged T-coil ON')).toBeVisible();

  // Step 4: 12-tap FFE misses far reflection; 44-tap FFE cancels it
  await page.getByRole('tab', { name: '4 · 44-tap far FFE' }).click();
  await expect(page.getByText(/Outside 12-tap FFE span/)).toBeVisible();

  // Step 6: 4-state Viterbi MLSE live trellis & scorecard visible
  await page.getByRole('tab', { name: '6 · MLSE rescue' }).click();
  await expect(page.getByText('4-state Viterbi MLSE recovers SNR without DFE bursts')).toBeVisible();
  await expect(page.getByRole('img', { name: /Live 4-state PAM4 Viterbi trellis/ })).toBeVisible();

  // Visitor counter remains visible in footer
  await expect(page.locator('footer')).toBeVisible();
});

test('client navigation from home page and responsive mobile width stay overflow-free', async ({ page }) => {
  await page.goto('/');
  await page.locator(`a[href="${lesson}"]`).click();
  await expect(page).toHaveURL(lesson);
  await ready(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
