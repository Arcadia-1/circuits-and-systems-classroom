import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const lesson = '/adc/pipeline-adc/';
const architectures = [
  { id: 'ten', stages: 10 }, { id: 'three-bit', stages: 4 },
  { id: 'four-bit', stages: 3 }, { id: 'intro', stages: 3 },
] as const;
type Errors = { gainError: number; nonlinearity: number };

// This is the public replay format, not access to component state. Every test
// involving Random starts at the same seed and can be replayed from its report.
function seededLesson(overrides: { topologyId?: string; input?: number; errorProfiles?: Record<string, Errors[]> } = {}) {
  const state = {
    version: 1, topologyId: 'three-bit', input: 0.68, errorStage: 0,
    errorProfiles: Object.fromEntries(architectures.map(({ id, stages }) => [id,
      Array.from({ length: stages - 1 }, (_, stage) => ({ gainError: stage === 0 ? 0.1 : 0, nonlinearity: 0 })),
    ])),
    randomState: 123456789, mobileView: 'stages',
  };
  const snapshot = { ...state, ...overrides, errorProfiles: { ...state.errorProfiles, ...overrides.errorProfiles } };
  return `${lesson}#pipeline=${encodeURIComponent(JSON.stringify(snapshot))}`;
}
const test = base.extend<{ browserAudit: void }>({
  browserAudit: [async ({ page }, use, testInfo) => {
    const errors: string[] = [], events: { type: string; message: string }[] = [];
    page.on('pageerror', error => { errors.push(error.message); events.push({ type: 'pageerror', message: error.stack ?? error.message }); });
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') events.push({ type: message.type(), message: message.text() });
    });
    page.on('requestfailed', request => events.push({ type: 'requestfailed', message: `${request.url()}: ${request.failure()?.errorText}` }));
    await use();
    if (testInfo.status !== testInfo.expectedStatus) {
      // Keep the failure visible before opening notes. Diagnostics are best
      // effort and bounded, so a broken page cannot hide the original failure.
      try {
        await testInfo.attach('failure-before-diagnostics', { body: await page.screenshot({ timeout: 1500 }), contentType: 'image/png' });
        const save = page.getByRole('button', { name: 'Save diagnostic report', exact: true });
        if (!await save.isVisible()) await page.getByRole('button', { name: 'Model notes', exact: true }).click({ timeout: 750 });
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 1500 }), save.click({ timeout: 750 })]);
        const path = testInfo.outputPath('failure-diagnostic.json');
        await download.saveAs(path);
        await testInfo.attach('failure-diagnostic', { path, contentType: 'application/json' });
      } catch (error) {
        events.push({ type: 'diagnostic-unavailable', message: String(error) });
      }
    }
    await testInfo.attach('browser-events', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
    expect(errors, 'No uncaught browser exception during any user interaction').toEqual([]);
  }, { auto: true }],
});

async function ready(page: Page) {
  await expect(page.getByRole('region', { name: 'Pipeline controls', exact: true })).toBeVisible();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /Progressive magnification through all/ })).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function readErrors(page: Page): Promise<Errors[]> {
  const selector = page.getByLabel('Edit stage', { exact: true });
  const selected = await selector.inputValue(), count = await selector.locator('option').count();
  const result: Errors[] = [];
  for (let stage = 0; stage < count; stage++) {
    await selector.selectOption(String(stage));
    result.push({ gainError: Number(await page.getByRole('slider', { name: 'Gain error', exact: true }).inputValue()),
      nonlinearity: Number(await page.getByRole('slider', { name: 'Nonlinearity', exact: true }).inputValue()) });
  }
  await selector.selectOption(selected);
  return result;
}

function expectErrorRange(errors: Errors[]) {
  for (const entry of errors) for (const value of Object.values(entry)) {
    expect(value).toBeGreaterThanOrEqual(-0.25);
    expect(value).toBeLessThanOrEqual(0.25);
    expect(value / 0.005).toBeCloseTo(Math.round(value / 0.005), 9);
  }
}

async function diagnostic(page: Page, testInfo: TestInfo, name: string) {
  await page.getByRole('button', { name: 'Model notes', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save diagnostic report', exact: true }).click();
  const download = await downloaded, file = testInfo.outputPath(`${name}.json`);
  await download.saveAs(file);
  await testInfo.attach(name, { path: file, contentType: 'application/json' });
  const report = JSON.parse(await readFile(file, 'utf8'));
  await page.getByRole('button', { name: 'Close model notes', exact: true }).click();
  return report;
}

test('first load and client navigation render a white, interactive lesson', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(lesson);
  await ready(page);
  await expect(page.getByRole('main')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.getByLabel('Architecture', { exact: true })).toHaveValue('three-bit');
  await screenshot(page, testInfo, 'first-load');

  const documentStarted = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('link', { name: 'Circuits and Systems Classroom home', exact: true }).click();
  await expect(page).toHaveURL('/');
  await page.locator(`a[href="${lesson}"]`).click();
  await expect(page).toHaveURL(lesson);
  await ready(page);
  expect(await page.evaluate(() => performance.timeOrigin), 'Navigation should exercise Astro client routing').toBe(documentStarted);
  await expect(page.getByRole('main')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.getByRole('button', { name: 'Reset errors', exact: true }).click();
  await expect(page.getByText('All stages ideal', { exact: false })).toBeVisible();
  await screenshot(page, testInfo, 'client-navigation');
});

test('all architectures stay interactive and retain separate errors in every edited stage', async ({ page }) => {
  await page.goto(seededLesson());
  await ready(page);
  const profiles: Record<string, Errors[]> = {};
  for (const { id, stages } of architectures) {
    await page.getByLabel('Architecture', { exact: true }).selectOption(id);
    await expect(page.getByRole('group', { name: /^Stage \d+,/ })).toHaveCount(stages);
    await expect(page.getByLabel('Edit stage', { exact: true })).toHaveValue('0');
    await page.getByRole('slider', { name: 'Gain error', exact: true }).press('End');
    await page.getByRole('slider', { name: 'Nonlinearity', exact: true }).press('Home');
    await page.getByLabel('Edit stage', { exact: true }).selectOption(String(stages - 2));
    await page.getByRole('slider', { name: 'Gain error', exact: true }).press('Home');
    await page.getByRole('slider', { name: 'Nonlinearity', exact: true }).press('End');
    profiles[id] = await readErrors(page);
    expect(profiles[id][0]).toEqual({ gainError: 0.25, nonlinearity: -0.25 });
    expect(profiles[id].at(-1)).toEqual({ gainError: -0.25, nonlinearity: 0.25 });
  }
  // Shrinking and expanding the stage list exercises the reactive transition
  // that model-only tests cannot cover; each architecture keeps its own profile.
  for (const { id } of [...architectures].reverse()) {
    await page.getByLabel('Architecture', { exact: true }).selectOption(id);
    expect(await readErrors(page)).toEqual(profiles[id]);
  }
});

test('voltage axes and ideal references stay fixed while architecture, input, and errors change', async ({ page }, testInfo) => {
  await page.goto(seededLesson());
  await ready(page);
  await screenshot(page, testInfo, 'default-three-bit-fixed-voltage-axes');
  await page.getByRole('slider', { name: 'Gain error', exact: true }).press('End');
  await screenshot(page, testInfo, 'three-bit-controlled-gain-fixed-voltage-axes');
  const flashMaximum: Record<string, number> = { ten: 7, 'three-bit': 7, 'four-bit': 15, intro: 3 };

  async function renderedAxes() {
    return page.getByRole('main').evaluate(main => {
      function reference(container: Element) {
        const ideal = container.querySelector<SVGPathElement>('path.ideal, path.ghost-curve')!;
        const actual = container.querySelector<SVGPathElement>('path.actual, path.actual-curve')!;
        const idealStyle = getComputedStyle(ideal), actualStyle = getComputedStyle(actual);
        const referenced = (value: string | null) => {
          const id = value?.match(/url\(["']?#([^"')]+)["']?\)/)?.[1];
          return id ? document.getElementById(id) : null;
        };
        const mask = referenced(ideal.getAttribute('mask'));
        const pattern = referenced(mask?.querySelector('rect')?.getAttribute('fill') ?? null);
        const stripe = pattern?.querySelector('rect');
        const period = Number(pattern?.getAttribute('width')), stripeWidth = Number(stripe?.getAttribute('width'));
        const stripedMask = pattern?.getAttribute('patternUnits') === 'userSpaceOnUse'
          && stripe !== undefined && stripe !== null && getComputedStyle(stripe).fill === 'rgb(255, 255, 255)'
          && stripeWidth > 0 && stripeWidth < period;
        return {
          idealPath: ideal.getAttribute('d'), actualPath: actual.getAttribute('d'),
          idealLength: ideal.getTotalLength(), actualLength: actual.getTotalLength(),
          idealStroke: idealStyle.stroke, actualStroke: actualStyle.stroke,
          idealDash: idealStyle.strokeDasharray, actualDash: actualStyle.strokeDasharray,
          stripedMask, actualMasked: actual.hasAttribute('mask'),
          idealOpacity: Number(idealStyle.opacity) * Number(idealStyle.strokeOpacity),
          idealWidth: Number.parseFloat(idealStyle.strokeWidth), actualWidth: Number.parseFloat(actualStyle.strokeWidth),
          idealDrawnFirst: Boolean(ideal.compareDocumentPosition(actual) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      }
      const ticks = (container: Element, selector: string) => Array.from(container.querySelectorAll(selector)).map(tick => ({
        value: Number(tick.textContent?.replace('−', '-')), y: Number(tick.getAttribute('y')),
      }));
      const rows = Array.from(main.querySelectorAll('g[role="group"][aria-label^="Stage "]')).map(row => ({
        description: row.getAttribute('aria-label'), ticks: ticks(row, 'text.y-tick'),
        zeroY: Number(row.querySelector('line.baseline')?.getAttribute('y1')), ...reference(row),
      }));
      const transfer = main.querySelector('section[aria-label="ADC transfer"]')!;
      return { rows, transfer: {
        description: transfer.querySelector('desc')?.textContent,
        ticks: ticks(transfer, 'text.tick[dy]'), zeroY: Number(transfer.querySelector('line.zero')?.getAttribute('y1')), ...reference(transfer),
      } };
    });
  }

  function expectReference(curve: Awaited<ReturnType<typeof renderedAxes>>['transfer']) {
    expect(curve.idealLength).toBeGreaterThan(0);
    expect(curve.actualLength).toBeGreaterThan(0);
    // Thousands of disjoint subpixel transfer steps need a screen-space dash
    // mask; restarting stroke-dasharray on each tiny segment appears solid.
    expect(curve.idealDash !== 'none' || curve.stripedMask, 'The ideal reference has visible dashes or a striped SVG mask').toBe(true);
    expect(curve.actualDash).toBe('none');
    expect(curve.actualMasked).toBe(false);
    expect(curve.idealOpacity).toBeGreaterThan(0.25);
    expect(curve.idealWidth).toBeGreaterThan(curve.actualWidth);
    expect(curve.idealDrawnFirst, 'Draw the gray reference underneath the actual curve').toBe(true);
    const idealChannels = curve.idealStroke.match(/[\d.]+/g)!.map(Number).slice(0, 3);
    const actualChannels = curve.actualStroke.match(/[\d.]+/g)!.map(Number).slice(0, 3);
    expect(Math.max(...idealChannels) - Math.min(...idealChannels), 'The ideal curve is gray or neutral gray-blue').toBeLessThanOrEqual(32);
    expect(Math.max(...actualChannels) - Math.min(...actualChannels), 'The actual curve remains colored').toBeGreaterThan(40);
  }

  function expectVoltageZero(curve: { ticks: { value: number; y: number }[]; zeroY: number }) {
    const top = curve.ticks.find(tick => tick.value === 1.1)!.y;
    const bottom = curve.ticks.find(tick => tick.value === -0.1)!.y;
    // On the requested -0.1…1.1 V display, 0 V sits one twelfth above
    // the lower edge; it is no longer the midpoint of the voltage plot.
    expect(curve.zeroY).toBeCloseTo(bottom - (bottom - top) / 12, 8);
  }

  for (const { id, stages } of architectures) {
    await page.getByLabel('Architecture', { exact: true }).selectOption(id);
    await page.getByRole('button', { name: 'Reset errors', exact: true }).click();
    // A topology switch remounts the strip. Wait for its measured SVG viewport,
    // not an arbitrary animation delay or the component's initial fallback size.
    await expect.poll(() => page.getByRole('main').evaluate(main => Math.max(...Array.from(main.querySelectorAll<SVGSVGElement>('svg[role="img"]'))
      .map(svg => Math.abs(svg.viewBox.baseVal.height - svg.clientHeight))))).toBeLessThanOrEqual(1);
    const before = await renderedAxes();
    expect(before.rows).toHaveLength(stages);
    for (const row of before.rows.slice(0, -1)) {
      expect(row.description).toContain('Residue axis -0.1 to 1.1 volts.');
      expect(row.ticks.map(tick => tick.value)).toEqual(expect.arrayContaining([-0.1, 1.1]));
      expectVoltageZero(row);
      expectReference({ ...row, description: row.description ?? undefined });
    }
    expect(before.rows.at(-1)!.ticks.map(tick => tick.value)).toEqual(expect.arrayContaining([0, flashMaximum[id]]));
    expect(before.rows.at(-1)!.description).not.toContain('Residue axis');
    expect(before.transfer.description).toContain('Output · V: -0.1 to 1.1.');
    expect(before.transfer.ticks.map(tick => tick.value)).toEqual([-0.1, 0.5, 1.1]);
    expectVoltageZero(before.transfer);
    expectReference(before.transfer);

    for (const [name, key, value] of [
      ['Input voltage', 'Home', '0'], ['Input voltage', 'End', '1'],
      ['Gain error', 'Home', '-0.25'], ['Gain error', 'End', '0.25'],
      ['Nonlinearity', 'Home', '-0.25'], ['Nonlinearity', 'End', '0.25'],
    ]) {
      const slider = page.getByRole('slider', { name, exact: true });
      await slider.press(key);
      await expect(slider).toHaveValue(value);
      const after = await renderedAxes();
      expect(after.rows.map(row => row.ticks), `${id}: residue ticks stay fixed after ${name} ${key}`).toEqual(before.rows.map(row => row.ticks));
      expect(after.transfer.ticks, `${id}: transfer ticks stay fixed after ${name} ${key}`).toEqual(before.transfer.ticks);
      expect(after.transfer.description).toContain('Output · V: -0.1 to 1.1.');
      expectVoltageZero(after.transfer);
      expect(after.rows[0].idealPath).toBe(before.rows[0].idealPath);
      expect(after.transfer.idealPath).toBe(before.transfer.idealPath);
      if (name === 'Input voltage') {
        expect(after.rows[0].actualPath, 'Moving the sample must not rescale the first-stage characteristic').toBe(before.rows[0].actualPath);
        expect(after.transfer.actualPath, 'Moving the sample must not rescale the complete ADC transfer').toBe(before.transfer.actualPath);
      }
      for (const row of after.rows.slice(0, -1)) {
        expect(row.description).toContain('Residue axis -0.1 to 1.1 volts.');
        expectVoltageZero(row);
        expectReference({ ...row, description: row.description ?? undefined });
      }
      expectReference(after.transfer);
    }
    await screenshot(page, testInfo, `${id}-fixed-voltage-axes`);
  }
});

test('an overrange residue stays physically above 1.1 V and has an honest plot-edge marker', async ({ page }, testInfo) => {
  await page.goto(seededLesson({ topologyId: 'ten', input: 1,
    errorProfiles: { ten: Array.from({ length: 9 }, () => ({ gainError: 0.25, nonlinearity: 0 })) },
  }));
  await ready(page);
  const row = page.getByRole('group', { name: /^Stage 9,/ });
  await expect(row).toHaveAttribute('aria-label', /Residue axis -0\.1 to 1\.1 volts\./);
  const overflow = row.locator('path.overflow-marker');
  await expect(overflow).toBeVisible();
  const description = await overflow.locator('title').textContent();
  expect(description?.replaceAll('−', '-').replace(/\+(\d)/g, '$1')).toContain('outside the fixed -0.1 to 1.1 V plot range');
  expect(Number(description?.match(/Actual residue ([\d.eE+-]+) V/)?.[1])).toBeGreaterThan(1.1);
  await expect(row.locator('circle.dot')).toHaveCount(0);
  expect((await row.locator('text.y-tick').allTextContents()).map(value => Number(value.replace('−', '-')))).toEqual(expect.arrayContaining([1.1, -0.1]));
  await screenshot(page, testInfo, 'ten-stage-overrange-fixed-voltage-axes');
});

test('Reset and Random respect input, selected-stage, and all-stage scopes', async ({ page }) => {
  await page.goto(seededLesson());
  await ready(page);
  await page.getByRole('button', { name: 'Reset errors', exact: true }).click();
  const input = page.getByRole('slider', { name: 'Input voltage', exact: true });
  await input.press('Home');
  await expect(input).toHaveValue('0');
  await input.press('End');
  await expect(input).toHaveValue('1');
  await page.getByRole('slider', { name: 'Gain error', exact: true }).press('End');
  await page.getByLabel('Edit stage', { exact: true }).selectOption('1');
  await page.getByRole('slider', { name: 'Nonlinearity', exact: true }).press('Home');
  const original = await readErrors(page);

  await page.getByRole('button', { name: 'Random input', exact: true }).click();
  const randomizedInput = await input.inputValue();
  expect(Number(randomizedInput)).toBeGreaterThanOrEqual(0);
  expect(Number(randomizedInput)).toBeLessThanOrEqual(1);
  expect(await readErrors(page)).toEqual(original);

  await page.getByRole('button', { name: 'Random errors', exact: true }).click();
  await expect(input).toHaveValue(randomizedInput);
  const selectedOnly = await readErrors(page);
  expect(selectedOnly[0]).toEqual(original[0]);
  expect(selectedOnly[2]).toEqual(original[2]);
  expect(selectedOnly[1]).not.toEqual(original[1]);
  expectErrorRange(selectedOnly);

  await page.getByRole('button', { name: 'Random all', exact: true }).click();
  const all = await readErrors(page);
  expectErrorRange(all);
  expect(all.filter((entry, stage) => JSON.stringify(entry) !== JSON.stringify(selectedOnly[stage])).length).toBeGreaterThan(1);
  expect(Number(await input.inputValue())).toBeGreaterThanOrEqual(0);
  expect(Number(await input.inputValue())).toBeLessThanOrEqual(1);

  const keptInput = await input.inputValue();
  await page.getByRole('button', { name: 'Reset errors', exact: true }).click();
  await expect(input).toHaveValue(keptInput);
  expect(await readErrors(page)).toEqual(Array.from({ length: 3 }, () => ({ gainError: 0, nonlinearity: 0 })));

  // Verify pause as state, never by sleeping and comparing animated voltages.
  for (const action of ['Random input', 'Random errors', 'Random all', 'Reset errors']) {
    await page.getByRole('button', { name: 'Sweep input', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause input sweep', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sweep input', exact: true })).toHaveAttribute('aria-pressed', 'false');
  }
});

test('a diagnostic replay restores every architecture and the next random sequence', async ({ page }, testInfo) => {
  await page.goto(seededLesson());
  await ready(page);
  for (const { id, stages } of architectures) {
    await page.getByLabel('Architecture', { exact: true }).selectOption(id);
    await page.getByLabel('Edit stage', { exact: true }).selectOption(String(stages - 2));
    await page.getByRole('slider', { name: 'Nonlinearity', exact: true }).press('Home');
  }
  const savedSliderValue = await page.getByRole('slider', { name: 'Input voltage', exact: true }).inputValue();
  const saved = await diagnostic(page, testInfo, 'saved-replay');
  expect(saved.errors).toEqual([]);
  expect(saved.build.revision).toEqual(expect.any(String));
  expect(saved.build.builtAt).toEqual(expect.any(String));
  expect(saved.viewport).toMatchObject({ width: 1365, height: 768 });
  expect(saved.state.topologyId).toBe('intro');

  await page.getByRole('button', { name: 'Random all', exact: true }).click();
  const nextInput = await page.getByRole('slider', { name: 'Input voltage', exact: true }).inputValue();
  const nextErrors = await readErrors(page);
  // A fresh document restores solely from the public report's link. Keeping the
  // same Page also keeps browser-error auditing active across both documents.
  await page.goto('about:blank');
  await page.goto(saved.replayUrl);
  await ready(page);
  await expect(page.getByLabel('Architecture', { exact: true })).toHaveValue(saved.state.topologyId);
  await expect(page.getByLabel('Edit stage', { exact: true })).toHaveValue(String(saved.state.errorStage));
  for (const { id } of architectures) {
    await page.getByLabel('Architecture', { exact: true }).selectOption(id);
    expect(await readErrors(page)).toEqual(saved.state.errorProfiles[id]);
  }
  // Range inputs round their DOM value to the nearest 1/65536 step; the model
  // and displayed voltage correctly retain the original saved 0.68 V input.
  await expect(page.getByRole('slider', { name: 'Input voltage', exact: true })).toHaveValue(savedSliderValue);
  await expect(page.getByRole('slider', { name: 'Input voltage', exact: true })).toHaveAttribute('aria-valuetext', '0.680000 V');
  await page.getByRole('button', { name: 'Random all', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Input voltage', exact: true })).toHaveValue(nextInput);
  expect(await readErrors(page)).toEqual(nextErrors);
  const replayed = await diagnostic(page, testInfo, 'replayed-next-random');
  expect(replayed.errors).toEqual([]);
});

for (const viewport of [
  { width: 1365, height: 768 }, { width: 390, height: 844 },
  { width: 320, height: 640 }, { width: 1365, height: 500 },
]) {
  test(`ten-stage controls and SVG stay usable at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto(seededLesson());
    await ready(page);
    await page.getByLabel('Architecture', { exact: true }).selectOption('ten');
    await page.getByRole('button', { name: 'Reset errors', exact: true }).click();
    await expect(page.getByRole('group', { name: /^Stage \d+,/ })).toHaveCount(10);

    const layout = await page.getByRole('region', { name: 'Pipeline controls', exact: true }).evaluate(panel => {
      const box = panel.getBoundingClientRect();
      const controls = Array.from(panel.querySelectorAll('input, select, button, output, .output, label')).map(control => ({
        name: control.getAttribute('aria-label') || control.id || control.textContent?.trim() || control.tagName,
        box: control.getBoundingClientRect(),
      })).filter(control => control.box.width > 0 && control.box.height > 0);
      const overlaps: string[] = [];
      for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (width > 1 && height > 1) overlaps.push(`${a.name} overlaps ${b.name}`);
      }
      const outside = Array.from(panel.querySelectorAll('input, select, button, output, .output')).flatMap(control => {
        const r = control.getBoundingClientRect();
        return r.width <= 0 || r.height <= 0 || r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1
          ? [control.getAttribute('aria-label') ?? control.textContent ?? control.id] : [];
      });
      return { outside, overlaps, panelBottom: box.bottom, viewportHeight: innerHeight,
        pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight,
        viewportWidth: innerWidth };
    });
    expect(layout.outside, 'All controls fit the same visible control panel').toEqual([]);
    expect(layout.overlaps, 'Control, label, and output boxes never overlap').toEqual([]);
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.pageHeight).toBeLessThanOrEqual(layout.viewportHeight);

    const geometry = await page.getByRole('img', { name: /Progressive magnification through all/ }).evaluate(svg => {
      const box = svg.getBoundingClientRect(), viewBox = (svg as SVGSVGElement).viewBox.baseVal;
      const rows = Array.from(svg.querySelectorAll('g[role="group"]')).map(group => {
        const verticals = Array.from(group.querySelectorAll('line')).filter(line => line.getAttribute('x1') === line.getAttribute('x2'));
        return verticals.map(line => ({ top: Number(line.getAttribute('y1')), bottom: Number(line.getAttribute('y2')) }));
      });
      return { width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        svgHeight: viewBox.height, rows, invalidPaths: Array.from(svg.querySelectorAll('path')).filter(path => /NaN|Infinity/.test(path.getAttribute('d') ?? '')).length };
    });
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.height).toBeGreaterThan(0);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(viewport.width);
    expect(geometry.top).toBeGreaterThanOrEqual(layout.panelBottom);
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.invalidPaths).toBe(0);
    expect(geometry.rows).toHaveLength(10);
    for (const row of geometry.rows) {
      expect(row.length).toBeGreaterThan(0);
      for (const line of row) {
        expect(line.bottom).toBeGreaterThan(line.top);
        expect(line.top).toBeGreaterThanOrEqual(0);
        expect(line.bottom).toBeLessThanOrEqual(geometry.svgHeight);
      }
    }
    await screenshot(page, testInfo, 'ten-stage-ideal');
    await page.getByRole('slider', { name: 'Gain error', exact: true }).press('End');
    await screenshot(page, testInfo, 'ten-stage-gain-error');
    if (viewport.width <= 850) {
      await page.getByRole('button', { name: 'DNL / INL', exact: true }).click();
      for (const title of ['DNL', 'INL · endpoint fit', 'ADC transfer']) {
        await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
      }
      await screenshot(page, testInfo, 'mobile-overall');
    }
  });
}
