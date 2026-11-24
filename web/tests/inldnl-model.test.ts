import { describe, expect, it } from 'vitest';
import {
  chipTrim,
  counts,
  measureRamp,
  measureSine,
  shares,
  spectrum,
  staticError,
  transitions,
  type Shape,
} from '../src/illustrations/inldnl/model';

const shape = (o: Partial<Shape> & { sigma?: number; chip?: number } = {}): Shape =>
  ({ trim: chipTrim(10, o.sigma ?? 0, o.chip ?? 1), bow: 0, sCurve: 0, ...o });
const range = (a: Float64Array) => [Math.min(...a), Math.max(...a)];

describe('INL and DNL, ported from ADCToolbox', () => {
  it('puts an ideal converter on the ideal grid', () => {
    for (const n of [8, 10]) {
      const t = transitions(n, { ...shape(), trim: chipTrim(n, 0, 1) });
      expect(Array.from(t, (v, k) => v - k - 0.5).every((e) => Math.abs(e) < 1e-9)).toBe(true);
      const s = staticError(t, 'endpoint');
      expect(range(s.dnl).map((v) => Math.abs(v) < 1e-9)).toEqual([true, true]);
      expect(s.missing).toBe(0);
    }
  });

  // [name, true DNL min/max, true INL min/max, ramp INL min/max, sine INL min/max, missing, ENOB, SFDR]
  // from python/adc_inl_dnl.py, 10 bits, 64 samples per code, seed 11
  const cases: [string, Shape, number[], number[], number[], number[], number, number, number][] = [
    ['ideal', shape(), [0, 0], [0, 0], [-2.518, 1.012], [-4.059, 0.9], 0, 9.92, 81.928],
    ['bow', shape({ bow: 2 }), [-0.008, 0.008], [0, 1.992], [-1.472, 2.804], [-2.822, 2.04], 0, 8.653, 54.684],
    ['S-curve', shape({ sCurve: 2 }), [-0.02, 0.01], [-1.988, 1.988], [-4.349, 2.97], [-6.046, 2.701], 0, 8.395, 52.858],
    ['1 % mismatch', shape({ sigma: 0.01, chip: 3 }), [-0.338, 0.141], [-0.274, 0.275], [-2.249, 0.978], [-3.983, 0.741], 0, 9.824, 74.253],
    ['3 % mismatch', shape({ sigma: 0.03, chip: 3 }), [-1, 0.423], [-0.819, 0.821], [-2.313, 1.007], [-4.02, 0.765], 1, 9.345, 65.225],
  ];
  it.each(cases)('matches ADCToolbox for %s', (_name, sh, dnl, inl, ramp, sine, missing, enob, sfdr) => {
    const n = 10, total = 2 ** n * 64;
    const t = transitions(n, sh);
    const truth = staticError(t, 'endpoint');
    expect(range(truth.dnl)).toEqual(dnl.map((v) => expect.closeTo(v, 3)));
    expect(range(truth.inl)).toEqual(inl.map((v) => expect.closeTo(v, 3)));
    expect(truth.missing).toBe(missing);
    expect(range(measureRamp(counts(shares(n, t, 'ramp'), total, 11), 'endpoint').inl)).toEqual(ramp.map((v) => expect.closeTo(v, 2)));
    expect(range(measureSine(counts(shares(n, t, 'sine'), total, 11), 'endpoint').inl)).toEqual(sine.map((v) => expect.closeTo(v, 2)));
    const sp = spectrum(n, t);
    expect(sp.enob).toBeCloseTo(enob, 3);
    expect(sp.sfdr).toBeCloseTo(sfdr, 2);
  });

  // a bow is even in the input, an S-curve is odd, so they show up in different harmonics
  it('sends the bow to the second harmonic and the S-curve to the third', () => {
    const n = 10;
    for (const [sh, order] of [[shape({ bow: 2 }), 2], [shape({ sCurve: 2 }), 3]] as const) {
      const sp = spectrum(n, transitions(n, sh));
      expect(sp.harmonics.indexOf(sp.spur) + 2).toBe(order);
    }
  });

  // the histogram is a counting experiment, so the DNL noise falls as 1/sqrt(samples per code)
  it('settles as the square root of the samples per code', () => {
    const n = 10, t = transitions(n, shape());
    const rms = [16, 64, 256, 1024].map((per) => {
      const d = measureRamp(counts(shares(n, t, 'ramp'), 2 ** n * per, 11), 'endpoint').dnl;
      return Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length);
    });
    for (const [i, per] of [16, 64, 256, 1024].entries()) expect(rms[i] * Math.sqrt(per)).toBeCloseTo(1, 1);
  });
});
