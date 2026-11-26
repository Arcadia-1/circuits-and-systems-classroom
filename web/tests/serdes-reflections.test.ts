import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_CONFIG,
  FN,
  LEVELS,
  NFPRE,
  Z0,
  WaveLattice,
  analyze224gLink,
  echoGeometry,
  evalAbcdAt,
  evalMetrics,
  physicalSegments,
  runLatticeCrossCheck,
  runViterbiPr1,
  type LinkConfig,
} from '../src/illustrations/serdes-reflections/model';

const referenceLines = readFileSync(
  new URL('../python/expected/serdes_224g_reflections.txt', import.meta.url),
  'utf8',
).trim().split('\n').slice(1);

const CASE_CONFIGS: Record<string, LinkConfig> = {
  matched: { ...DEFAULT_CONFIG, lossDb: 18, zVia: 50, zConn: 50, pcbMm: 14.5, padCapFf: 140, tcoil: true, ffePostTaps: 40, rxNoiseMv: 0.6, xtMv: 1.2 },
  tcoil_off: { ...DEFAULT_CONFIG, lossDb: 30, zVia: 34, zConn: 72, pcbMm: 14.5, padCapFf: 140, tcoil: false, ffePostTaps: 40, rxNoiseMv: 0.6, xtMv: 1.2 },
  tcoil_on: { ...DEFAULT_CONFIG, lossDb: 30, zVia: 34, zConn: 72, pcbMm: 14.5, padCapFf: 140, tcoil: true, ffePostTaps: 40, rxNoiseMv: 0.6, xtMv: 1.2 },
  far_echo: { ...DEFAULT_CONFIG, lossDb: 30, zVia: 28, zConn: 78, pcbMm: 14.5, padCapFf: 140, tcoil: true, ffePostTaps: 40, rxNoiseMv: 0.4, xtMv: 0.8 },
  stress_40db: { ...DEFAULT_CONFIG, lossDb: 40, zVia: 32, zConn: 74, pcbMm: 14.5, padCapFf: 140, tcoil: true, ffePostTaps: 40, rxNoiseMv: 0.6, xtMv: 1.2 },
};

describe('224G reflections & equalization model', () => {
  const refRows = referenceLines.map((line) => {
    const parts = line.split(/\s+/);
    return [parts[0], parts.slice(1).map(Number)] as const;
  });

  it.each(refRows)('matches the independent NumPy reference bit-for-bit on %s', (name, vals) => {
    const [s21_56, s11Max, gdc, gdc2, snr12, snr44, snrd, b1, errFfe, errDfe, errMlse] = vals;
    const a = analyze224gLink(CASE_CONFIGS[name], 8000, 0x224a);
    expect(a.freq.s21AtFnDb).toBeCloseTo(s21_56, 3);
    expect(a.freq.s11MaxDb).toBeCloseTo(s11Max, 3);
    expect(a.gdc).toBe(gdc);
    expect(a.gdc2).toBe(gdc2);
    expect(a.eqFfe12.snrDb).toBeCloseTo(snr12, 3);
    expect(a.eqFfe.snrDb).toBeCloseTo(snr44, 3);
    expect(a.eqPr1.snrDb).toBeCloseTo(snrd, 3);
    expect(a.eqPr1.b1).toBeCloseTo(b1, 4);
    // Exact symbol error match across the shared mulberry32 + Box-Muller stream
    expect(a.mc.ffe.symbolErrors).toBe(errFfe);
    expect(a.mc.dfe.symbolErrors).toBe(errDfe);
    expect(a.mc.mlse.symbolErrors).toBe(errMlse);
  });

  it('enforces exact ABCD passivity and lossless energy conservation', () => {
    const lossless = physicalSegments({ lossDb: 0, zVia: 30, zConn: 78, pcbMm: 14.5 });
    const lossy = physicalSegments({ lossDb: 36, zVia: 30, zConn: 78, pcbMm: 14.5 });
    for (let fGhz = 0; fGhz <= 112; fGhz += 2) {
      for (const tcoil of [false, true]) {
        const a0 = evalAbcdAt(fGhz * 1e9, lossless, 140, tcoil);
        const p0 = a0.s11r ** 2 + a0.s11i ** 2 + a0.s21PassR ** 2 + a0.s21PassI ** 2;
        expect(p0).toBeCloseTo(1, 10);

        const a1 = evalAbcdAt(fGhz * 1e9, lossy, 140, tcoil);
        const p1 = a1.s11r ** 2 + a1.s11i ** 2 + a1.s21PassR ** 2 + a1.s21PassI ** 2;
        expect(p1).toBeLessThanOrEqual(1 + 1e-10);
      }
    }
  });

  it('matches bridged T-coil constant resistance (S11 = 0) vs strong bare pad capacitance reflection', () => {
    const matchedLine = physicalSegments({ lossDb: 0, zVia: Z0, zConn: Z0, pcbMm: 14.5 });
    for (const fGhz of [5, 28, 56, 84]) {
      const withTc = evalAbcdAt(fGhz * 1e9, matchedLine, 140, true);
      expect(Math.hypot(withTc.s11r, withTc.s11i)).toBeLessThan(1e-12);
    }
    const bareAt56 = evalAbcdAt(FN, matchedLine, 140, false);
    const s11BareDb = 20 * Math.log10(Math.hypot(bareAt56.s11r, bareAt56.s11i));
    expect(s11BareDb).toBeGreaterThan(-4);
  });

  it('agrees between the 1-D bounce-decomposed wave lattice and frequency-domain ABCD IFFT', () => {
    const cfg = { zVia: 30, zConn: 76, pcbMm: 14.5, padCapFf: 0, tcoil: true };
    const chk = runLatticeCrossCheck(cfg, 900);
    expect(chk.maxDecompErr).toBeLessThan(1e-13);
    let maxRxErr = 0, maxTxErr = 0;
    for (let i = 0; i < chk.rxLattice.length; i++) {
      maxRxErr = Math.max(maxRxErr, Math.abs(chk.rxLattice[i] - chk.rxAbcd[i]));
      maxTxErr = Math.max(maxTxErr, Math.abs(chk.txRefLattice[i] - chk.txRefAbcd[i]));
    }
    expect(maxRxErr).toBeLessThan(5e-5);
    expect(maxTxErr).toBeLessThan(5e-5);

    // Also verify exact linear bounce-order decomposition with bare shunt pad capacitance (T-coil OFF)
    const chkCap = runLatticeCrossCheck({ ...cfg, padCapFf: 140, tcoil: false }, 900);
    expect(chkCap.maxDecompErr).toBeLessThan(1e-13);
    // And verify that matched 50-ohm line produces strictly zero reflected or secondary-echo waves
    const clean = new WaveLattice({ lossDb: 0, zVia: 50, zConn: 50, pcbMm: 14.5, padCapFf: 140, tcoil: true }, true);
    for (let n = 0; n < 400; n++) {
      clean.step(Math.exp(-0.5 * ((n - 30) / 5) ** 2));
      for (let i = 0; i < clean.nCells; i++) {
        expect(Math.abs(clean.v1m[i])).toBe(0);
        expect(Math.abs(clean.v2p[i])).toBe(0);
        expect(Math.abs(clean.v2m[i])).toBe(0);
      }
    }
  });

  it('tracks round-trip echo timing and notch spacing from cavity geometry', () => {
    const shortCav = echoGeometry({ pcbMm: 8.0, zVia: 32, zConn: 74 });
    const longCav = echoGeometry({ pcbMm: 20.0, zVia: 32, zConn: 74 });
    expect(shortCav.viaConnUi).toBeCloseTo(2 * (8 + 2) * 6 / (1e12 / 112e9), 6);
    expect(longCav.viaConnUi).toBeGreaterThan(shortCav.viaConnUi + 15);
    expect(shortCav.notchSpacingGhz).toBeGreaterThan(longCav.notchSpacingGhz);
    expect(shortCav.gammaVia).toBeCloseTo((32 - 50) / (32 + 50), 9);
    expect(shortCav.gammaConn).toBeCloseTo((74 - 50) / (74 + 50), 9);
  });

  it('achieves MMSE optimality for 44-tap FFE and cancels the far connector reflection', () => {
    const a = analyze224gLink(CASE_CONFIGS.far_echo, 4000, 0x224a);
    const h = Float64Array.from(a.adcCursors, (v) => v * (a.eqBypass.taps[NFPRE] ? 1 / a.eqBypass.taps[NFPRE] : 1));
    const best = evalMetrics(h, a.eqFfe.taps, a.noise, false).snr;
    expect(best).toBeCloseTo(a.eqFfe.snr, 7);
    for (let i = 0; i < a.eqFfe.taps.length; i++) {
      for (const delta of [-1e-3, 1e-3]) {
        const w = Float64Array.from(a.eqFfe.taps);
        w[i] += delta;
        expect(evalMetrics(h, w, a.noise, false).snr).toBeLessThanOrEqual(best * (1 + 1e-8));
      }
    }
    // 44-tap FFE reaches the ~22 UI echo that 12-tap FFE misses
    expect(a.farEchoUi).toBeGreaterThanOrEqual(18);
    expect(a.farEchoUi).toBeLessThanOrEqual(26);
    expect(a.eqFfe.snrDb - a.eqFfe12.snrDb).toBeGreaterThan(2.5);
    // Far tap near farEchoUi is actively cancelling the reflection
    let maxFarTap = 0;
    for (let u = a.farEchoUi - 2; u <= a.farEchoUi + 2; u++) {
      maxFarTap = Math.max(maxFarTap, Math.abs(a.eqFfe.taps[NFPRE + u]));
    }
    expect(maxFarTap).toBeGreaterThan(0.05);
  });

  it('demonstrates DFE noise savings, real burst error propagation, and Viterbi MLSE recovery', () => {
    const a = analyze224gLink(CASE_CONFIGS.stress_40db, 8000, 0x224a);
    // DFE reduces linear FFE noise enhancement dramatically
    expect(a.eqPr1.noiseEnhDb).toBeLessThan(a.eqFfe.noiseEnhDb - 3.5);
    // Real DFE suffers error propagation above genie-aided DFE
    expect(a.mc.dfe.symbolErrors).toBeGreaterThan(a.mc.dfeGenie.symbolErrors * 1.4);
    expect(a.mc.dfe.burstsGe2).toBeGreaterThan(15);
    // 4-state Viterbi MLSE dramatically beats both pure FFE and real DFE on the exact same samples
    expect(a.mc.mlse.symbolErrors).toBeLessThan(a.mc.ffe.symbolErrors * 0.25);
    expect(a.mc.mlse.symbolErrors).toBeLessThan(a.mc.dfe.symbolErrors * 0.5);
    expect(a.mc.mlse.burstsGe2).toBeLessThan(a.mc.dfe.burstsGe2 * 0.5);
    expect(a.mc.rescuedCount).toBeGreaterThan(100);
  });

  it('reduces 4-state Viterbi MLSE to exact hard PAM4 slicing when alpha = 0', () => {
    const y = new Float64Array(400);
    for (let i = 0; i < y.length; i++) {
      y[i] = LEVELS[i % 4] + 0.22 * Math.sin(i * 1.73);
    }
    const vit = runViterbiPr1(y, 0, 10, 390);
    for (let i = 10; i < 390; i++) {
      const hard = y[i] < -2 / 3 ? 0 : y[i] < 0 ? 1 : y[i] < 2 / 3 ? 2 : 3;
      expect(vit.decisions[i]).toBe(hard);
    }
  });

  it('registers the lesson in the public SerDes catalog with its own thumbnail', async () => {
    const { featuredLessons } = await import('../src/data/illustrations');
    const { isLessonPath, isPublicLessonPath } = await import('../src/data/publication');
    const path = '/serdes/reflections-and-224g-eq/';
    expect(isLessonPath(path)).toBe(true);
    expect(isPublicLessonPath(path)).toBe(true);
    expect(featuredLessons.find((x) => x.href === path)).toMatchObject({ category: 'SerDes', thumb: 'reflections' });
  });
});
