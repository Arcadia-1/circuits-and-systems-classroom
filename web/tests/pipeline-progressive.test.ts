import { describe, expect, it } from 'vitest';
import { TOPOLOGIES } from '../src/illustrations/pipeline-intro/configurable';
import { analyzeLinearity, convertWithErrors, DEFAULT_ERRORS, type ErrorSettings } from '../src/illustrations/pipeline-intro/errors';
import { progressiveWindows } from '../src/illustrations/pipeline-intro/progressive';

function crossing(bits: readonly number[], settings: ErrorSettings, stage: number, prefix: number): number {
  if (prefix === 0) return 0;
  // Independently search the actual stage prefix, not final-code thresholds.
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (low + high) / 2;
    if (convertWithErrors(middle, bits, settings).stages[stage].prefixCode < prefix) low = middle;
    else high = middle;
  }
  return high;
}

describe('progressive original-input windows', () => {
  it.each(TOPOLOGIES)('$id expands the chosen ideal prefix and keeps every stage on original Vin', ({ bits }) => {
    const analysis = analyzeLinearity(bits, DEFAULT_ERRORS);
    for (const input of [0, 0.125, 0.68, 0.999, 1]) {
      const conversion = convertWithErrors(input, bits, DEFAULT_ERRORS), windows = progressiveWindows(conversion, analysis);
      let beforeBits = 0;
      windows.forEach((window, index) => {
        expect(window.domain[1] - window.domain[0]).toBe(2 ** -beforeBits);
        expect(input).toBeGreaterThanOrEqual(window.domain[0]);
        expect(input).toBeLessThanOrEqual(window.domain[1]);
        expect(window.boundaryOnly).toBe(false);
        beforeBits += bits[index];
        if (index < bits.length - 1) {
          expect(window.selected![1] - window.selected![0]).toBe(2 ** -beforeBits);
          expect(window.selected).toEqual(windows[index + 1].domain);
          expect(window.zoom).toBe(2 ** bits[index]);
        } else {
          expect(window.selected).toBe(null);
          expect(window.zoom).toBe(null);
        }
      });
      expect(windows[0].domain).toEqual([0, 1]);
    }
  });

  it.each(TOPOLOGIES)('$id uses actual prefix crossings with gain error, nonlinearity, and missing codes', ({ bits }) => {
    for (const settings of [{ stage: 0, gainError: 0.5, nonlinearity: 2 }, { stage: 0, gainError: -0.5, nonlinearity: -2 }]) {
      const analysis = analyzeLinearity(bits, settings);
      for (const input of [0, 0.25, 0.68, 1]) {
        const conversion = convertWithErrors(input, bits, settings), windows = progressiveWindows(conversion, analysis);
        windows.forEach((window, index) => {
          expect(input + 1e-12).toBeGreaterThanOrEqual(window.domain[0]);
          expect(input - 1e-12).toBeLessThanOrEqual(window.domain[1]);
          expect(window.domain[1]).toBeGreaterThan(window.domain[0]);
          if (index < bits.length - 1) {
            const prefix = conversion.stages[index].prefixCode;
            expect(window.selected![0]).toBeCloseTo(crossing(bits, settings, index, prefix), 11);
            expect(window.selected![1]).toBeCloseTo(crossing(bits, settings, index, prefix + 1), 11);
            expect(window.selected![0] + 1e-12).toBeGreaterThanOrEqual(window.domain[0]);
            expect(window.selected![1] - 1e-12).toBeLessThanOrEqual(window.domain[1]);
            expect(window.selected).toEqual(windows[index + 1].domain);
          }
        });
      }
    }
  });

  it('reports true input-window magnification rather than nominal amplifier gain', () => {
    const bits = [1, 1, 3], settings = { stage: 0, gainError: 0.5, nonlinearity: 0 };
    const windows = progressiveWindows(convertWithErrors(0.68, bits, settings), analyzeLinearity(bits, settings));
    expect(windows[0].zoom).toBe(2);
    expect(windows[1].zoom).toBeCloseTo(2.01, 12);
    expect(windows[1].zoom).not.toBe(2 ** bits[1]);
  });

  it('retains a boundary-only full-scale prefix and falls back to its nearest nonempty ancestor', () => {
    const bits = TOPOLOGIES[0].bits, settings = { stage: 0, gainError: -0.390625, nonlinearity: 0 };
    const conversion = convertWithErrors(1, bits, settings), analysis = analyzeLinearity(bits, settings);
    expect(conversion.code).toBe(4088);
    expect(conversion.stages[8].prefixCode).toBe(511);
    expect([analysis.thresholds[4088], analysis.thresholds[4096]]).toEqual([1, 1]);
    const windows = progressiveWindows(conversion, analysis);
    expect(windows[8].selected).toEqual([1, 1]);
    expect(windows[8].boundaryOnly).toBe(true);
    expect(windows[8].zoom).toBe(null);
    expect(windows[9].domain).toEqual(windows[8].domain);
    expect(windows[9].domain).toEqual(windows[7].selected);
    expect(windows[9].domain[0]).toBeLessThan(1);
    expect(windows[9].domain[1]).toBe(1);
    expect(windows[9].boundaryOnly).toBe(true);
    expect(windows[9].selected).toBe(null);
    expect(windows[9].zoom).toBe(null);
    // The preceding zoom remains legitimate even though the next selection is a point.
    expect(windows[7].zoom).toBeGreaterThan(0);
  });

  it('handles several collapsed descendants without choosing a different sample prefix', () => {
    const bits = TOPOLOGIES[0].bits, settings = { stage: 0, gainError: -3.125, nonlinearity: 0 };
    const conversion = convertWithErrors(1, bits, settings), windows = progressiveWindows(conversion, analyzeLinearity(bits, settings));
    const firstCollapsed = windows.findIndex(window => window.selected?.[0] === window.selected?.[1]);
    expect(firstCollapsed).toBeGreaterThan(0);
    expect(firstCollapsed).toBeLessThan(8);
    for (let index = firstCollapsed; index < windows.length; index++) {
      expect(windows[index].boundaryOnly).toBe(true);
      expect(windows[index].domain).toEqual(windows[firstCollapsed].domain);
      expect(windows[index].zoom).toBe(null);
      if (windows[index].selected) expect(windows[index].selected).toEqual([1, 1]);
    }
  });

  it('does not silently mix different converter architectures', () => {
    const conversion = convertWithErrors(0.68, [2, 2, 2]);
    expect(() => progressiveWindows(conversion, analyzeLinearity([4, 4, 4]))).toThrow(RangeError);
  });
});
