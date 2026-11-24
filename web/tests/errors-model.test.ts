import { describe, expect, it } from 'vitest';
import { byPhase, byValue, capture, fitSine, outputSpectrum, QUIET, TEST_BIN, type Impairments } from '../src/illustrations/errors/model';

const imp = (o: Partial<Impairments> = {}): Impairments => ({ ...QUIET, ...o });
const finite = (a: Float64Array) => Array.from(a).filter((v) => Number.isFinite(v));
const range = (a: Float64Array) => [Math.min(...finite(a)), Math.max(...finite(a))];

// Every row from python/adc_error_views.py: 12 bits, bin 613, seed 5.
// [name, impairments, fit amplitude, dc, rmse, error-by-value min/max, am, pm, base, ENOB, SFDR]
const cases: [string, Impairments, number, number, number, number[], number, number, number, number, number][] = [
  ['quantisation only', imp(), 1825.3, 2048.0, 0.288, [-0.195, 0.195], 0, 0.07, 0.282, 11.837, 93.34],
  ['thermal noise', imp({ noise: 2 }), 1825.21, 2048.02, 2.019, [-0.911, 0.786], 0.238, 0, 1.993, 9.029, 78.81],
  ['static k2', imp({ k2: 0.01 }), 1825.3, 2057.13, 6.465, [-9.151, 9.009], 0, 0.055, 0.371, 7.35, 46.01],
  ['static k3', imp({ k3: 0.01 }), 1838.98, 2048.0, 3.244, [-4.648, 4.648], 0.076, 0, 0.335, 8.355, 52.09],
  ['jitter', imp({ jitter: 2e-12 }), 1825.3, 2048.0, 0.382, [-0.163, 0.192], 0, 0.347, 0.287, 11.432, 94.75],
  ['memory', imp({ memory: 0.002 }), 1827.37, 2051.5, 0.429, [-0.463, 0.463], 0, 0.133, 0.317, 11.264, 78.57],
  ['AM tone', imp({ amDepth: 0.01 }), 1825.27, 2047.99, 9.121, [-12.656, 12.864], 12.888, 0, 0.326, 6.853, 46.02],
];

describe('reading the error, ported from ADCToolbox', () => {
  it.each(cases)('matches ADCToolbox for %s', (_name, i, amplitude, dc, rmse, value, am, pm, base, enob, sfdr) => {
    const n = 12;
    const y = capture(n, TEST_BIN, i, 5);
    const fit = fitSine(y, TEST_BIN);
    expect(fit.amplitude).toBeCloseTo(amplitude, 1);
    expect(fit.dc).toBeCloseTo(dc, 1);
    expect(fit.rmse).toBeCloseTo(rmse, 3);
    expect(range(byValue(y, fit.error).mean)).toEqual(value.map((v) => expect.closeTo(v, 2)));
    const p = byPhase(fit.error, TEST_BIN, fit.phase);
    expect(p.am).toBeCloseTo(am, 2);
    expect(p.pm).toBeCloseTo(pm, 2);
    expect(p.base).toBeCloseTo(base, 2);
    const sp = outputSpectrum(y, n);
    expect(sp.enob).toBeCloseTo(enob, 2);
    expect(sp.sfdr).toBeCloseTo(sfdr, 1);
  });

  // the whole point of the page: each impairment signs its name somewhere different
  it('gives every impairment its own signature', () => {
    const n = 12;
    const read = (i: Impairments) => {
      const y = capture(n, TEST_BIN, i, 5);
      const fit = fitSine(y, TEST_BIN);
      return { ...byPhase(fit.error, TEST_BIN, fit.phase), value: range(byValue(y, fit.error).mean) };
    };
    const quiet = read(imp());
    // thermal noise is none of the two and all of the third
    const noise = read(imp({ noise: 2 }));
    expect(noise.base).toBeGreaterThan(6 * quiet.base);
    expect(noise.am + noise.pm).toBeLessThan(noise.base / 5);
    // jitter rides on the slope of the signal: pure PM, and invisible against the signal value
    const jitter = read(imp({ jitter: 2e-12 }));
    expect(jitter.pm).toBeGreaterThan(4 * quiet.pm);
    expect(jitter.am).toBe(0);
    expect(jitter.value[1] - jitter.value[0]).toBeLessThan(2 * (quiet.value[1] - quiet.value[0]));
    // an interfering tone multiplies the signal: pure AM
    const am = read(imp({ amDepth: 0.01 }));
    expect(am.am).toBeGreaterThan(30 * am.base);
    expect(am.pm).toBe(0);
    // a static curve is a function of the signal value and nothing else, so it is loudest in that view
    const k2 = read(imp({ k2: 0.01 }));
    expect(k2.value[1] - k2.value[0]).toBeGreaterThan(40 * (quiet.value[1] - quiet.value[0]));
  });

  // quantisation alone leaves a flat distribution one LSB wide, so its rms is the textbook 1/sqrt(12)
  it('finds the quantisation floor where theory puts it', () => {
    const y = capture(12, TEST_BIN, QUIET, 5);
    expect(fitSine(y, TEST_BIN).rmse).toBeCloseTo(1 / Math.sqrt(12), 2);
    expect(outputSpectrum(y, 12).enob).toBeGreaterThan(11.8);
  });
});
