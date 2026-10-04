import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BitSource, CdrSim, DEFAULTS, EYE_CLOSURE, JTOL_HZ, NPI, jtolAt, run, wrap, type CdrSettings } from '../src/illustrations/cdr/model';

const reference = readFileSync(new URL('../python/expected/serdes_cdr.txt', import.meta.url), 'utf8').trim().split('\n');
const table = (header: string, stop: (line: string) => boolean) => {
  const start = reference.findIndex((l) => l.startsWith(header)) + 1;
  const rows: string[][] = [];
  for (let i = start; i < reference.length && !stop(reference[i]); i++) rows.push(reference[i].split(/\s+/));
  return rows;
};
const CASES: Record<string, Partial<CdrSettings>> = {
  default: {},
  p_only_300ppm: { integral: false },
  p_only_800ppm: { integral: false, ppm: 800 },
  cdr_off: { cdr: false },
  sj_2MHz_4UIpp: { sjUipp: 4, sjHz: 2e6 },
  'sj_500MHz_0.8UIpp': { sjUipp: 0.8, sjHz: 500e6 },
  cid72: { pattern: 'cid' },
  prbs7: { pattern: 'prbs7' },
};

describe('bang-bang CDR model', () => {
  it('counts each bit at most once when its two bounding edges violate the timing margin', () => {
    const sim = new CdrSim({ ...DEFAULTS, kp: 8, decim: 1, latency: 8, sjUipp: .9, sjHz: 1e9 });
    const violations = new Set<number>();
    let previousTheta = 0;
    for (let i = 0; i < 10000; i++) {
      const s = sim.step();
      if (s.transition) {
        if (s.n > 0 && .5 + wrap(s.edge - previousTheta) < EYE_CLOSURE) violations.add(s.n - 1);
        if (.5 - wrap(s.edge - s.theta) < EYE_CLOSURE) violations.add(s.n);
      }
      previousTheta = s.theta;
    }
    expect(violations.size).toBeGreaterThan(500);
    expect(sim.errors).toBe(violations.size);
  });
  it.each(table('case ', (l) => l.startsWith('jtol')).map((r) => [r[0], r] as const))('matches the Python reference for %s', (name, r) => {
    const out = run({ ...DEFAULTS, ...CASES[name] }, 40000);
    expect(out.slips).toBe(Number(r[1]));
    expect(out.errors).toBe(Number(r[2]));
    expect(out.trackedPpm).toBeCloseTo(Number(r[3]), 2);
    expect(out.rmsUi * 1e3).toBeCloseTo(Number(r[4]), 3);
    expect(out.peakUi * 1e3).toBeCloseTo(Number(r[5]), 3);
    expect(out.code).toBe(Number(r[6]));
  });

  it('reproduces the jitter-tolerance curve of the reference', () => {
    const rows = table('jtol_MHz', () => false);
    expect(rows.map((r) => Number(r[0]) * 1e6)).toEqual(JTOL_HZ);
    for (const [mhz, uipp] of rows) expect(jtolAt(DEFAULTS, Number(mhz) * 1e6)).toBeCloseTo(Number(uipp), 4);
  });

  it('tolerates large slow jitter and only about the eye opening at high frequency', () => {
    const rows = table('jtol_MHz', () => false).map((r) => Number(r[1]));
    expect(rows[0]).toBeGreaterThan(5);
    for (let i = 1; i < 4; i++) expect(rows[i]).toBeLessThan(rows[i - 1]);
    for (const v of rows.slice(4)) {
      expect(v).toBeGreaterThan(0.25);
      expect(v).toBeLessThan(0.6);
    }
  });

  it('learns the frequency offset in the integral path', () => {
    const sim = new CdrSim({ ...DEFAULTS, sjUipp: 0 });
    let sum = 0, count = 0;
    for (let i = 0; i < 60000; i++) {
      sim.step();
      if (i >= 20000 && i % DEFAULTS.decim === 0) {
        sum += sim.trackedPpm;
        count++;
      }
    }
    expect(sum / count).toBeGreaterThan(290);
    expect(sum / count).toBeLessThan(310);
  });

  it('holds lock with the proportional path alone only below kp/(NPI·decim)', () => {
    const limitPpm = (DEFAULTS.kp / (NPI * DEFAULTS.decim)) * 1e6;
    expect(limitPpm).toBeCloseTo(488.28, 2);
    expect(run({ ...DEFAULTS, integral: false, ppm: 0.8 * limitPpm, sjUipp: 0 }, 40000).slips).toBe(0);
    expect(run({ ...DEFAULTS, integral: false, ppm: 1.5 * limitPpm, sjUipp: 0 }, 40000).slips).toBeGreaterThan(5);
  });

  it('slips once per 1/ppm UI when the loop is open', () => {
    const out = run({ ...DEFAULTS, cdr: false, ppm: 250, sjUipp: 0, rjUi: 0 }, 40000);
    expect(out.slips).toBe(10);
  });

  it('can show the bits still to arrive without changing the run', () => {
    const s = { ...DEFAULTS, ppm: 3000, sjUipp: 0.5, sjHz: 200e6 };
    const plain = new CdrSim(s), peeking = new CdrSim(s);
    for (let i = 0; i < 3000; i++) {
      const ahead = peeking.peek(i % 9);
      for (let k = 0; k < i % 9; k++) {
        const a = plain.step(), b = peeking.step();
        expect([b.bit, b.edge, b.theta]).toEqual([a.bit, a.edge, a.theta]);
      }
      const a = plain.step(), b = peeking.step();
      expect(b.edge).toBeCloseTo(ahead.edge, 9);
      expect(b.bit).toBe(ahead.bit);
      expect(b.theta).toBe(a.theta);
    }
    expect(peeking.errors).toBe(plain.errors);
  });

  it('wraps phase into half a UI either side', () => {
    expect(wrap(0.49)).toBeCloseTo(0.49, 12);
    expect(wrap(0.51)).toBeCloseTo(-0.49, 12);
    expect(wrap(-1.2)).toBeCloseTo(-0.2, 12);
  });

  it('generates PRBS7 with period 127 and 72-bit runs for the CID pattern', () => {
    const p = new BitSource('prbs7');
    const seq = Array.from({ length: 254 }, () => p.next());
    expect(seq.slice(0, 127)).toEqual(seq.slice(127));
    expect(seq.slice(0, 127).reduce((a, b) => a + b, 0)).toBe(64);
    const cid = new BitSource('cid');
    expect(Array.from({ length: 72 }, () => cid.next()).every((b) => b === 0)).toBe(true);
    const p31 = new BitSource('prbs31', 0x2468ace1);
    expect(`prbs31 first ${Array.from({ length: 48 }, () => p31.next()).join('')}`).toBe(reference[1]);
  });
});

describe('CDR lesson registration', () => {
  it('is a public SerDes lesson with its own thumbnail', async () => {
    const { featuredLessons } = await import('../src/data/illustrations');
    const { isLessonPath, isPublicLessonPath } = await import('../src/data/publication');
    const path = '/serdes/clock-and-data-recovery/';
    expect(isLessonPath(path)).toBe(true);
    expect(isPublicLessonPath(path)).toBe(true);
    expect(featuredLessons.find((x) => x.href === path)).toMatchObject({ category: 'SerDes', thumb: 'cdr' });
  });
});
