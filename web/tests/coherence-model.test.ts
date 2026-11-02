import { describe, expect, it } from 'vitest';
import { baseCycles, capture, idealCode, LENGTHS, read, sweep } from '../src/illustrations/coherence/model';
import { SIDE_BINS, type Window } from '../src/lib/spectrum';

const WINDOWS: Window[] = ['rectangular', 'hann', 'blackmanharris', 'flattop'];

describe('coherent sampling, windows and record length', () => {
  // from python/adc_coherent_sampling.py: 12 bits, 4096 points, tone at 613 cycles, no added noise
  // [offset, then ENOB and SFDR for rectangular, hann, blackmanharris, flattop]
  const table: [number, ...number[]][] = [
    [0.0, 11.837, 93.34, 11.841, 92.11, 11.85, 89.85, 11.849, 87.98],
    [0.1, 2.156, 19.08, 5.323, 34.0, 11.824, 84.23, 11.824, 83.46],
    [0.25, 0.756, 9.54, 3.858, 23.75, 11.344, 69.8, 11.494, 69.93],
    [0.5, -0.568, 0.0, 2.511, 13.98, 9.292, 53.99, 9.74, 54.92],
  ];
  it.each(table)('matches ADCToolbox at an offset of %f bin', (offset, ...cells) => {
    const n = 12, len = 4096, base = baseCycles(len);
    WINDOWS.forEach((kind, i) => {
      const { spectrum } = read(n, len, base + offset, kind, SIDE_BINS[kind], 0, 3);
      expect(spectrum.enob).toBeCloseTo(cells[2 * i], 2);
      expect(spectrum.sfdr).toBeCloseTo(cells[2 * i + 1], 1);
    });
  });

  // the record has to join onto itself: a whole number of cycles, and the tone falls in one bin
  it('puts the tone in exactly one bin when the capture is coherent', () => {
    for (const len of LENGTHS) {
      const base = baseCycles(len);
      expect(base % 2).toBe(1);
      const { spectrum, bin } = read(12, len, base, 'rectangular', 0, 0, 3);
      expect(spectrum.signal).toBe(bin);
      // the next bin over is down in the quantisation floor, not part of a skirt
      expect(spectrum.dbfs[bin + 1]).toBeLessThan(spectrum.dbfs[bin] - 60);
      expect(spectrum.enob).toBeGreaterThan(11.7);
    }
  });

  // a tenth of a bin is enough to lose ten bits, and that is the whole reason windows exist
  it('loses a perfect converter to a tenth of a bin, unless a window catches it', () => {
    const n = 12, len = 4096, base = baseCycles(len);
    const at = (kind: Window, offset: number) => read(n, len, base + offset, kind, SIDE_BINS[kind], 0, 3).spectrum.enob;
    expect(at('rectangular', 0) - at('rectangular', 0.1)).toBeGreaterThan(9);
    expect(at('blackmanharris', 0) - at('blackmanharris', 0.1)).toBeLessThan(0.05);
    // and the window costs nothing worth having when the capture was coherent all along
    expect(at('blackmanharris', 0)).toBeGreaterThan(at('rectangular', 0) - 0.05);
  });

  // spreading the same noise over more bins leaves ENOB alone and buys spur-free range
  it('buys resolution of spurs, not signal-to-noise, with a longer record', () => {
    const enob = LENGTHS.map((len) => read(12, len, baseCycles(len), 'rectangular', 0, 0, 3).spectrum.enob);
    const sfdr = LENGTHS.map((len) => read(12, len, baseCycles(len), 'rectangular', 0, 0, 3).spectrum.sfdr);
    for (const v of enob) expect(v).toBeCloseTo(11.84, 1);
    for (let i = 1; i < sfdr.length; i++) expect(sfdr[i]).toBeGreaterThan(sfdr[i - 1]);
  });

  it('sweeps the offset from one side of the bin to the other', () => {
    const curve = sweep(12, 1024, 'rectangular', 0, 0, 3, 21);
    expect(curve).toHaveLength(21);
    // best in the middle, where the offset is zero, and worst at both edges
    expect(curve.indexOf(Math.max(...curve))).toBe(10);
    expect(curve[0]).toBeLessThan(curve[10] - 9);
    expect(curve[20]).toBeLessThan(curve[10] - 9);
  });

  it('quantises to whole codes inside the range', () => {
    const y = capture(12, 1024, baseCycles(1024), 0, 3);
    for (const v of y) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(4096);
    }
  });

  it('shows a boundary step only when the record is not coherent', () => {
    const len = 4096, base = baseCycles(len), coherent = capture(12, len, base, 0, 3);
    expect(Math.abs(coherent[0] - idealCode(12, len, base, len))).toBeLessThan(1e-9);
    const leaking = capture(12, len, base + 0.1, 0, 3);
    expect(Math.abs(leaking[0] - idealCode(12, len, base + 0.1, len))).toBeGreaterThan(900);
  });
});
