import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULTS, HALF_PS, PRESETS, PS_PER_KHZ, SETTLED_FROM, SWEEP_BETAS, dcoStepPs, detectorSlope, erf, limitCyclePeriod,
  limitCyclePp, meanDecision, pullInKHz, simulate, summarize, sweep, type PresetKey,
} from '../src/illustrations/bbpll/model';

// Reference values from python/pll_bang_bang.py, which shares the noise generator, so the runs agree exactly.
const expected = readFileSync(new URL('../python/expected/pll_bang_bang.txt', import.meta.url), 'utf8').trim().split('\n');
const section = (title: string) => {
  const at = expected.findIndex((line) => line.startsWith(title));
  const rows: string[][] = [];
  for (let i = at + 1; i < expected.length && expected[i].startsWith('  '); i++) rows.push(expected[i].trim().split(/[\s:,]+/));
  return rows;
};

describe('bang-bang PLL model', () => {
  it('uses the constants the reference prints', () => {
    expect(expected[0]).toContain(`ps per kHz per cycle ${PS_PER_KHZ.toFixed(6)}`);
    expect(expected[0]).toContain(`half period ${HALF_PS.toFixed(1)} ps`);
    expect(expected[0]).toContain(`DCO step at -95 dBc/Hz ${dcoStepPs(-95).toFixed(6)} ps`);
    expect(expected[0]).toContain(`default pull-in ${pullInKHz(DEFAULTS).toFixed(1)} kHz`);
  });

  it('settles a noise-free proportional-only loop into a (2D + 1)-step limit cycle of period 4D + 2', () => {
    for (let latency = 0; latency <= 4; latency++) {
      const s = { ...PRESETS.limit, latency };
      const tail = Array.from(simulate(s).err.subarray(SETTLED_FROM));
      expect(Math.max(...tail) - Math.min(...tail)).toBeCloseTo(limitCyclePp(s), 9);
      const p = limitCyclePeriod(s);
      for (let i = 0; i + p < tail.length; i++) expect(tail[i + p]).toBeCloseTo(tail[i], 9);
      for (let q = 1; q < p; q++) expect(tail.some((v, i) => i + q < tail.length && Math.abs(tail[i + q] - v) > 1e-6)).toBe(true);
    }
  });

  const presets = section('presets, whole run');
  it.each(presets)('reproduces the reference run of preset %s', (name, acquired, settled, slips, rms, pp, meanFreq) => {
    const s = PRESETS[name as PresetKey];
    const m = summarize(simulate(s), s);
    expect(m.acquiredAt === null ? 'none' : String(m.acquiredAt)).toBe(acquired);
    expect(m.settledAt === null ? 'none' : String(m.settledAt)).toBe(settled);
    expect(m.slips).toBe(Number(slips));
    expect(m.rmsPs).toBeCloseTo(Number(rms), 5);
    expect(m.ppPs).toBeCloseTo(Number(pp), 5);
    expect(m.meanFreqKHz).toBeCloseTo(Number(meanFreq), 5);
  });

  it('covers every preset', () => expect(presets.map((r) => r[0]).sort()).toEqual(Object.keys(PRESETS).sort()));

  it('settles the default acquisition only after the frequency has overshot to pay back the phase', () => {
    const run = simulate(DEFAULTS), m = summarize(run, DEFAULTS);
    expect(m.settledAt).toBeGreaterThan(2 * (m.acquiredAt ?? Infinity));
    // the ramp runs past zero: the frequency goes negative while the phase error is still being paid back
    expect(Math.min(...run.freq.subarray(0, m.settledAt ?? 0))).toBeLessThan(-DEFAULTS.betaKHz);
  });

  it('pulls in up to the closed-form estimate and slips beyond it', () => {
    const clean = { ...DEFAULTS, noise: false };
    const limit = pullInKHz(DEFAULTS);
    expect(simulate({ ...clean, offsetKHz: limit - 300 }).slips).toBe(0);
    expect(simulate({ ...clean, offsetKHz: limit + 300 }).slips).toBeGreaterThan(0);
    expect(summarize(simulate(PRESETS.pullin), PRESETS.pullin).acquiredAt).toBeNull();
  });

  it('linearizes the detector behind jitter into erf, with slope √(2/π)/σ', () => {
    const rows = section('detector behind');
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      // e −0.6 ps mean decision −0.9545 erf −0.9545
      const e = Number(row[1]), mean = Number(row[5]), erfValue = Number(row[7]);
      expect(meanDecision(e, DEFAULTS.refJitterPs)).toBeCloseTo(erfValue, 4);
      expect(Math.abs(mean - erfValue)).toBeLessThan(0.01);
    }
    expect(expected.find((l) => l.startsWith('detector behind'))).toContain(detectorSlope(DEFAULTS.refJitterPs).toFixed(6));
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect((meanDecision(1e-4, 0.3) - meanDecision(-1e-4, 0.3)) / 2e-4).toBeCloseTo(detectorSlope(0.3), 4);
  });

  it('finds the jitter bathtub of the reference sweep', () => {
    const rows = section('beta sweep');
    const points = sweep(DEFAULTS);
    expect(points.map((p) => p.betaKHz)).toEqual(SWEEP_BETAS);
    rows.forEach(([beta, noisy, clean], i) => {
      expect(points[i].betaKHz).toBe(Number(beta));
      expect(points[i].noisyPs).toBeCloseTo(Number(noisy), 5);
      expect(points[i].cleanPs).toBeCloseTo(Number(clean), 5);
    });
    const best = points.reduce((a, b) => (b.noisyPs < a.noisyPs ? b : a));
    expect(best.betaKHz).toBeGreaterThan(SWEEP_BETAS[0]);
    expect(best.betaKHz).toBeLessThan(SWEEP_BETAS[SWEEP_BETAS.length - 1]);
  });
});
