/**
 * Pulling the harmonics out: ask a converter for a given amount of second- and third-order distortion, then measure it
 * back three ways — a least-squares fit of the harmonics themselves, the polynomial that made them, and the FFT.
 * Ported from ADCToolbox 0.9.1 (github.com/Arcadia-1/ADCToolbox):
 *   siggen/nonidealities   apply_static_nonlinearity, apply_static_nonlinearity_hd, apply_thermal_noise's sum,
 *                          apply_quantization_noise
 *   aout/                  decompose_harmonic_error under analyze_decomposition_time and analyze_decomposition_polar,
 *                          and fit_static_nonlin
 *   fundamentals/          find_coherent_frequency, fit_sine_4param and the FFT estimate under it
 *   spectrum/              analyze_spectrum, through src/lib/spectrum.ts
 * following its examples exp_a11, exp_a12, exp_a25 and exp_a31.
 * python/adc_harmonics.py calls ADCToolbox on the same samples; tests/harmonics-model.test.ts compares the two.
 */
import { fftAny } from '../../lib/fft';
import { coherentFrequency } from '../../lib/frequency';
import { gaussians } from '../../lib/rng';
import { analyzeSpectrum, N_FFT, type Spectrum } from '../../lib/spectrum';
import { solve } from '../../lib/numeric';
import { fitSine, type Fit } from '../errors/model';

export const N = N_FFT;
export const FS = 1e9;
export const AMP = 0.45;
export const DC = 0.5;
export const BITS = 14;
export const TONE = coherentFrequency(FS, 97e6, N);

const NOISE = gaussians(N, 31);

export interface Case {
  /** the second and third harmonic asked for, in dBc, or null for none */
  hd2: number | null;
  hd3: number | null;
  /** thermal noise, V rms */
  noise: number;
}

/** Working points the lesson opens at: nothing, one harmonic, the other, both, and both under a noise floor. */
export const CASES: Record<string, Case> = {
  clean: { hd2: null, hd3: null, noise: 10e-6 },
  second: { hd2: -60, hd3: null, noise: 10e-6 },
  third: { hd2: null, hd3: -60, noise: 10e-6 },
  both: { hd2: -55, hd3: -65, noise: 10e-6 },
  buried: { hd2: -70, hd3: -75, noise: 200e-6 },
};

/** apply_static_nonlinearity_hd: the coefficient that puts a harmonic at this many dBc, k = 2^(n−1)·10^(dBc/20) / A^(n−1). */
export const hdToK = (db: number | null, order: number, amp = AMP): number =>
  db === null ? 0 : (2 ** (order - 1) * 10 ** (db / 20)) / amp ** (order - 1);

/** apply_static_nonlinearity: y = k1·x + k2·x² + k3·x³ on the part of the signal that swings. */
export const bend = (signal: Float64Array, k2: number, k3: number, dc = DC, k1 = 1): Float64Array =>
  Float64Array.from(signal, (v) => {
    const x = v - dc;
    let d = k1 * x;
    if (k2 !== 0) d += k2 * x ** 2;
    if (k3 !== 0) d += k3 * x ** 3;
    return d + dc;
  });

/** apply_quantization_noise on 0 … 1 V. */
export function quantise(signal: Float64Array, bits: number): Float64Array {
  const lsb = 1 / 2 ** bits, top = 2 ** bits - 1;
  return Float64Array.from(signal, (v) => Math.min(top, Math.max(0, Math.floor(v / lsb))) * lsb);
}

/** One capture: a coherent sine bent by apply_static_nonlinearity_hd's Chebyshev curve (#123), noise, then quantiser. */
export function capture(c: Case, fin = TONE.fin, bits = BITS): Float64Array {
  const clean = Float64Array.from({ length: N }, (_, i) => AMP * Math.sin((2 * Math.PI * fin * i) / FS) + DC);
  const k1 = c.hd3 === null ? 1 : 1 - 3 * 10 ** (c.hd3 / 20);
  const bent = bend(clean, hdToK(c.hd2, 2), hdToK(c.hd3, 3), DC, k1);
  return quantise(Float64Array.from(bent, (v, i) => v + NOISE[i] * c.noise), bits);
}

/** _estimate_frequency_fft: the biggest bin through Nyquist, with a parabola through its neighbours. */
export function estimateFrequency(y: Float64Array): number {
  const n = y.length, re = Float64Array.from(y), im = new Float64Array(n);
  fftAny(re, im);
  const half = Math.floor(n / 2), spec = new Float64Array(half + 1);
  for (let k = 1; k <= half; k++) spec[k] = Math.hypot(re[k], im[k]);
  let k = 0;
  for (let i = 1; i <= half; i++) if (spec[i] > spec[k]) k = i;
  let at = k;
  if (k > 0 && k < half) {
    const r = spec[k + 1] > spec[k - 1] ? 1 : -1;
    at += (r * spec[k + r]) / (spec[k] + spec[k + r]);
  }
  return at / n;
}

export interface Decomposition {
  /** the size of harmonics 1 … n, in volts and against the signal's own range */
  magnitudes: number[];
  db: number[];
  /** each harmonic's phase relative to the fundamental's, wrapped to ±π */
  phases: number[];
  /** what is left once every harmonic is taken out: its rms in full-scale terms, and in dB */
  residualRms: number;
  noiseDb: number;
  frequency: number;
  fundamental: Float64Array;
  harmonic: Float64Array;
  residual: Float64Array;
  reconstructed: Float64Array;
}

/**
 * decompose_harmonic_error: fit DC, the fundamental and its harmonics all at once by least squares, then read each
 * one's size and phase off the pair of coefficients. It never touches an FFT, so nothing leaks between bins.
 */
export function decompose(signal: Float64Array, nHarmonics = 5, frequency?: number): Decomposition {
  const n = signal.length;
  let dc = 0;
  for (const v of signal) dc += v;
  dc /= n;
  const zero = Float64Array.from(signal, (v) => v - dc);
  const freq = fitSine(zero, (frequency ?? estimateFrequency(zero)) * n, 100).frequency;

  // the design matrix, a column at a time: DC, then the cos and sin of every harmonic
  const w = 2 * Math.PI * freq, k = 2 * nHarmonics + 1;
  const basis: Float64Array[] = [new Float64Array(n).fill(1)];
  for (let h = 1; h <= nHarmonics; h++) {
    basis.push(Float64Array.from({ length: n }, (_, i) => Math.cos(h * w * i)));
    basis.push(Float64Array.from({ length: n }, (_, i) => Math.sin(h * w * i)));
  }
  const m = Array.from({ length: k }, () => new Array<number>(k).fill(0)), r = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      for (let q = p; q < k; q++) m[p][q] += basis[p][i] * basis[q][i];
      r[p] += basis[p][i] * zero[i];
    }
  }
  for (let p = 0; p < k; p++) for (let q = 0; q < p; q++) m[p][q] = m[q][p];
  const coeffs = solve(m, r);

  const reconstructed = new Float64Array(n), fundamental = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < k; c++) sum += coeffs[c] * basis[c][i];
    reconstructed[i] = sum;
    fundamental[i] = coeffs[0] + coeffs[1] * basis[1][i] + coeffs[2] * basis[2][i];
  }
  const harmonic = Float64Array.from(reconstructed, (v, i) => v - fundamental[i]);
  const residual = Float64Array.from(zero, (v, i) => v - reconstructed[i]);

  let sq = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    sq += residual[i] * residual[i];
    lo = Math.min(lo, signal[i]);
    hi = Math.max(hi, signal[i]);
  }
  const residualRms = Math.sqrt(sq / n), range = hi - lo;

  const magnitudes: number[] = [], phases: number[] = [], db: number[] = [];
  for (let h = 1; h <= nHarmonics; h++) {
    const a = coeffs[2 * h - 1], b = coeffs[2 * h];
    magnitudes.push(Math.hypot(a, b) * 2);
    phases.push(Math.atan2(-b, a));
    db.push(20 * Math.log10(Math.hypot(a, b) * 2 / range + 1e-20));
  }
  const first = phases[0];
  for (let h = 0; h < nHarmonics; h++) {
    const p = phases[h] - first * (h + 1);
    phases[h] = ((p + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }

  return {
    magnitudes,
    db,
    phases,
    residualRms,
    noiseDb: 20 * Math.log10(Math.max((residualRms * 2 * Math.SQRT2) / range, 1e-30)),
    frequency: freq,
    fundamental: Float64Array.from(fundamental, (v) => v + dc),
    harmonic,
    residual,
    reconstructed: Float64Array.from(reconstructed, (v) => v + dc),
  };
}

/** polyfit: least squares for c0 + c1·x + … + cn·xⁿ, the coefficients in ascending order. */
export function polyfit(x: Float64Array, y: Float64Array, order: number): number[] {
  const k = order + 1, n = x.length;
  const m = Array.from({ length: k }, () => new Array<number>(k).fill(0)), r = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const p = new Array<number>(2 * k - 1).fill(1);
    for (let j = 1; j < 2 * k - 1; j++) p[j] = p[j - 1] * x[i];
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) m[a][b] += p[a + b];
      r[a] += p[a] * y[i];
    }
  }
  return solve(m, r);
}

export interface StaticFit {
  /** the curvature the polynomial fit found, as apply_static_nonlinearity's own coefficients */
  k2: number;
  k3: number;
  /** the linear term they are normalised by, volts out per volt in, and where the fitted sine sits */
  k1: number;
  centre: number;
  level: number;
  fit: Fit;
  /** the fitted transfer curve, and the straight line it is measured against */
  transfer: { x: Float64Array; y: Float64Array };
}

/**
 * fit_static_nonlin (ADCToolbox PR #130): fit the output fundamental, take its zero-DC sine as the reference input,
 * and fit a polynomial to the output. Referring the coefficients back through the fitted linear term `k1` uses
 * `k_i = c_i / k1^i` so cubic gain on the fundamental is removed.
 */
export function fitStaticNonlin(signal: Float64Array, order = 3): StaticFit {
  const n = signal.length;
  const fit = fitSine(signal, estimateFrequency(signal) * n, 100);
  const xOffset = fit.dc;
  let meanSig = 0;
  for (let i = 0; i < n; i++) meanSig += signal[i];
  meanSig /= n;
  let xMax = 0;
  for (let i = 0; i < n; i++) xMax = Math.max(xMax, Math.abs(fit.fitted[i] - xOffset));
  const xNorm = Float64Array.from(fit.fitted, (v) => (v - xOffset) / xMax);
  const yAc = Float64Array.from(signal, (v) => v - meanSig);
  const c = polyfit(xNorm, yAc, order);
  const k1 = c[1] / xMax;

  let lo = Infinity, hi = -Infinity;
  for (const v of fit.fitted) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const points = 1000, x = new Float64Array(points), y = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    x[i] = lo + ((hi - lo) * i) / (points - 1);
    const u = (x[i] - xOffset) / xMax;
    let sum = 0;
    for (let j = c.length - 1; j >= 0; j--) sum = sum * u + c[j];
    y[i] = sum + meanSig;
  }
  return {
    k2: c[2] / xMax ** 2 / k1 ** 2,
    k3: order >= 3 ? c[3] / xMax ** 3 / k1 ** 3 : NaN,
    k1,
    centre: xOffset,
    level: meanSig,
    fit,
    transfer: { x, y },
  };
}

/** analyze_spectrum over the whole 0 … 1 V range, the rectangular window on a coherent tone. */
export const spectrumOf = (x: Float64Array): Spectrum => analyzeSpectrum(x.map((v) => v * 2), 1);

/**
 * The curve the static fit found, against the one that was asked for: both as the deviation from the straight line
 * through them, which is what k2 and k3 describe once the linear term is subtracted out.
 */
export function curve(fit: StaticFit, k2: number, k3: number, points = 160): { x: Float64Array; measured: Float64Array; asked: Float64Array } {
  const { x: tx, y: ty } = fit.transfer;
  const x = new Float64Array(points), measured = new Float64Array(points), asked = new Float64Array(points);
  // subtracting the fitted linear term leaves c2·u² + c3·u³, matching the k2·u² + k3·u³ curve asked for
  const dev = (i: number) => ty[i] - fit.level - fit.k1 * (tx[i] - fit.centre);
  let middle = 0;
  for (let i = 1; i < tx.length; i++) if (Math.abs(tx[i] - fit.centre) < Math.abs(tx[middle] - fit.centre)) middle = i;
  const at = dev(middle);
  for (let i = 0; i < points; i++) {
    const j = Math.round((i * (tx.length - 1)) / (points - 1)), u = tx[j] - fit.centre;
    x[i] = tx[j];
    measured[i] = dev(j) - at;
    asked[i] = k2 * u * u + k3 * u * u * u;
  }
  return { x, measured, asked };
}

export interface Reading {
  data: Float64Array;
  decomposition: Decomposition;
  statik: StaticFit;
  spectrum: Spectrum;
  /** what was asked for, for comparison with what came back */
  k2: number;
  k3: number;
}

export function read(c: Case, harmonics = 5, fin = TONE.fin, bits = BITS): Reading {
  const data = capture(c, fin, bits);
  return {
    data,
    decomposition: decompose(data, harmonics),
    statik: fitStaticNonlin(data, 3),
    spectrum: spectrumOf(data),
    k2: hdToK(c.hd2, 2),
    k3: hdToK(c.hd3, 3),
  };
}
