/**
 * Static error of an N-bit converter: where its code transitions actually sit, the DNL and INL that follow, and the two
 * histogram tests that measure them. Ported from ADCToolbox 0.9.1 (github.com/Arcadia-1/ADCToolbox):
 *   aout/compute_inl_from_ramp  counts / mean(counts) − 1, INL = [0, cumsum(DNL)] at the transitions
 *   aout/compute_inl_from_sine  code density through −cos(π · cumsum / total), then the same cumulative sum
 *   aout/_correct_inl           endpoint or best-fit reference line
 * python/adc_inl_dnl.py calls ADCToolbox on the same histograms; tests/inldnl-model.test.ts compares the two.
 *
 * Units are LSB throughout: code k of an ideal converter covers [k − ½, k + ½).
 */
import { gaussians } from '../../lib/rng';
import { analyzeSpectrum, N_FFT, type Spectrum } from '../../lib/spectrum';

export const TEST_BIN = 613;
export const TEST_PHASE = 0.37;
/** Both tests overdrive full scale a little, so that every code is exercised even when the weights have moved. */
const OVERDRIVE = 1.02;

export type Test = 'ramp' | 'sine';
export type Reference = 'endpoint' | 'fit';

export interface Shape {
  /** relative error of each binary weight, MSB first */
  trim: ArrayLike<number>;
  /** peak of a second-order bow, in LSB */
  bow: number;
  /** peak of a third-order S-curve, in LSB */
  sCurve: number;
}

/** One chip's weight errors: weight j is 2^(n−1−j) unit capacitors, so its own error is sigma / sqrt(units). */
export function chipTrim(n: number, sigma: number, chip: number): number[] {
  const z = gaussians(n, 1000 * chip + 7);
  return Array.from({ length: n }, (_, j) => (sigma / 2 ** ((n - 1 - j) / 2)) * z[j]);
}

const mean = (a: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
};

/**
 * Transition levels of a binary capacitor DAC, in LSB: t[k] is the input at which the code steps from k to k + 1, so an
 * ideal converter has t[k] = k + ½. Each weight carries its own relative error, which moves every level built from it;
 * the bow and the S-curve add the two lowest-order INL shapes on top, each zero at both ends of the range.
 */
export function transitions(n: number, { trim, bow, sCurve }: Shape): Float64Array {
  const codes = 2 ** n;
  const w = Float64Array.from({ length: n }, (_, j) => 2 ** (n - 1 - j) * (1 + trim[j]));
  const t = new Float64Array(codes - 1);
  for (let k = 1; k < codes; k++) {
    let dac = 0;
    for (let j = 0; j < n; j++) if ((k >> (n - 1 - j)) & 1) dac += w[j];
    const v = (2 * k) / codes - 1;
    t[k - 1] = dac - 0.5 + bow * (1 - v * v) + sCurve * 2.598 * v * (1 - v * v);
  }
  return t;
}

/** Code of an input x (LSB): the number of transitions at or below it. A code whose transitions cross is never output. */
export function codeOf(t: Float64Array, x: number): number {
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Remove the reference line from raw transition INL: the line through its ends, or its least-squares fit. */
export function correct(raw: Float64Array, reference: Reference): Float64Array {
  const m = raw.length;
  if (reference === 'endpoint') return raw.map((v, i) => v - (raw[0] + ((raw[m - 1] - raw[0]) * i) / (m - 1)));
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) {
    sx += i;
    sy += raw[i];
    sxx += i * i;
    sxy += i * raw[i];
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx), icpt = (sy - slope * sx) / m;
  return raw.map((v, i) => v - (icpt + slope * i));
}

export interface Static {
  /** one value per code with both edges, so codes 1 … 2^N − 2 */
  dnl: Float64Array;
  /** one value per transition bounding those codes, so one sample more than dnl */
  inl: Float64Array;
  missing: number;
}

/** DNL and INL from transition levels, normalised to the mean code width the way a histogram test reports them. */
export function staticError(t: Float64Array, reference: Reference): Static {
  const width = Float64Array.from({ length: t.length - 1 }, (_, k) => Math.max(0, t[k + 1] - t[k]));
  const lsb = mean(width);
  const dnl = width.map((v) => v / lsb - 1);
  const raw = new Float64Array(dnl.length + 1);
  for (let k = 0; k < dnl.length; k++) raw[k + 1] = raw[k] + dnl[k];
  return { dnl, inl: correct(raw, reference), missing: dnl.reduce((a, v) => a + (v <= -1 + 1e-9 ? 1 : 0), 0) };
}

/**
 * Share of a test's samples that lands in each code. A ramp is uniform over full scale, so a code's share is its width;
 * a full-scale sine spends its time at the ends, so the share follows the arcsine distribution between the transitions.
 */
export function shares(n: number, t: Float64Array, test: Test): Float64Array {
  const codes = 2 ** n, half = codes / 2, amp = half * OVERDRIVE;
  const cdf = test === 'ramp'
    ? (x: number) => Math.min(1, Math.max(0, (x - half) / (2 * amp) + 0.5))
    : (x: number) => 0.5 + Math.asin(Math.min(1, Math.max(-1, (x - half) / amp))) / Math.PI;
  const p = new Float64Array(codes);
  let last = 0;
  for (let k = 0; k < codes; k++) {
    const next = k < codes - 1 ? cdf(t[k]) : 1;
    // transitions that cross leave a code no input at all
    p[k] = Math.max(0, next - last);
    last = Math.max(last, next);
  }
  return p;
}

/**
 * Histogram counts of a test of `total` samples. Each code's count is Poisson about its expected share; at the counts a
 * code-density test needs, that is a Gaussian of variance equal to the mean, drawn once per chip from a fixed seed.
 */
export function counts(p: Float64Array, total: number, seed: number): Float64Array {
  const z = gaussians(p.length, seed);
  return p.map((v, k) => {
    const lambda = v * total;
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z[k]));
  });
}

/** compute_inl_from_ramp: a uniform sweep visits each code in proportion to its width, so the counts are the widths. */
export function measureRamp(c: Float64Array, reference: Reference): Static {
  const inner = c.subarray(1, c.length - 1);
  const lsb = mean(inner);
  const dnl = inner.map((v) => Math.max(-1, v / lsb - 1));
  const raw = new Float64Array(dnl.length + 1);
  for (let k = 0; k < dnl.length; k++) raw[k + 1] = raw[k] + dnl[k];
  return { dnl, inl: correct(raw, reference), missing: dnl.reduce((a, v) => a + (v <= -1 + 1e-9 ? 1 : 0), 0) };
}

/**
 * compute_inl_from_sine (ADCToolbox #118): the cumulative histogram of a sine is its arcsine CDF, so
 * −cos(π · cumsum / total) undoes the bow and returns the transition levels. Differences of those are the internal
 * code widths, normalised by their own mean so missing codes are exactly −1 and DNL has zero mean.
 */
export function measureSine(c: Float64Array, reference: Reference): Static {
  const total = c.reduce((a, v) => a + v, 0);
  const level = new Float64Array(c.length);
  let run = 0;
  for (let k = 0; k < c.length; k++) {
    run += c[k];
    level[k] = -Math.cos((Math.PI * run) / total);
  }
  const width = Float64Array.from({ length: c.length - 2 }, (_, k) => level[k + 1] - level[k]);
  const lsb = mean(width);
  const out = width.map((v) => v / lsb - 1);
  // the sine estimator's INL is the running sum of its own DNL, one sample per analysed code
  const raw = new Float64Array(out.length);
  for (let k = 0; k < out.length; k++) raw[k] = (k ? raw[k - 1] : 0) + out[k];
  return { dnl: out, inl: correct(raw, reference), missing: out.reduce((a, v) => a + (v <= -1 + 1e-9 ? 1 : 0), 0) };
}

/** Spectrum of a coherent −0.5 dBFS sine passed through the same transition levels. */
export function spectrum(n: number, t: Float64Array): Spectrum {
  const codes = 2 ** n, half = codes / 2, amp = half * 10 ** (-0.5 / 20);
  const out = Float64Array.from({ length: N_FFT }, (_, i) => codeOf(t, half + amp * Math.sin((2 * Math.PI * TEST_BIN * i) / N_FFT + TEST_PHASE)));
  return analyzeSpectrum(out, n);
}
