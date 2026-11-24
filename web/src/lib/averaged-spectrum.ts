/**
 * ADCToolbox compute_spectrum (b96e033: 0.9.3 plus PR #130) over several runs of the same tone, as analyze_spectrum
 * does it (power averaging) and as analyze_spectrum_polar does it (coherent averaging, with the phase of every bin
 * kept):
 *   spectrum/_spectrum_averaging     _power_average, _coherent_average
 *   spectrum/_align_spectrum_phase   the rotation that puts every run's fundamental at phase 0, including window lobes
 *   spectrum/_harmonics              harmonic bins and their power, integrated-lobe largest spur
 *   spectrum/_estimate_noise_power   the averaging-aware median noise floor behind SNR, nf_method 0
 * The pieces a single run shares with it live in src/lib/spectrum.ts. python/adc_polar_averaging.py checks this
 * against ADCToolbox itself.
 */
import { fftAny } from './fft';
import { foldBin } from './frequency';
import { npSum, roundEven } from './numeric';
import { autoSideBin, fractionalPeak, highestSpur, inbandBins, median, SIDE_BINS, windowOf, type Window } from './spectrum';

export interface AveragedSpectrum {
  /** power per bin, 0 … n/2, and its dBFS */
  power: Float64Array;
  dbfs: Float64Array;
  /** coherent averaging only: the aligned complex spectrum, re and im, scaled so that |V|² is the power */
  re: Float64Array | null;
  im: Float64Array | null;
  signal: number;
  /** the fundamental's bin refined by a parabola */
  refined: number;
  sideBin: number;
  /** bins of harmonics 2 … maxHarmonic, folded and rounded as _locate_harmonic_bins does */
  harmonicBins: number[];
  /** dBc of each, and of all of them together */
  harmonics: number[];
  thd: number;
  spur: number;
  sfdr: number;
  sigDbfs: number;
  sndr: number;
  snr: number;
  enob: number;
}

/** fold_bin_to_nyquist for a bin that may be fractional: Python's modulo, then the mirror above n/2. */
function foldFractional(bin: number, n: number): number {
  const b = ((bin % n) + n) % n;
  return b > Math.floor(n / 2) ? n - b : b;
}

const LANCZOS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logFactorial(n: number): number {
  let x = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) x += LANCZOS[i] / (n + i);
  const t = n + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (n + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * _median_to_mean_ratio (ADCToolbox #122): median/mean of a white-noise bin in an averaged power spectrum,
 * gammaincinv(k, 0.5) / k where k is 1 for coherent averaging (complex Gaussian stays exponential) and max(nRecords, 1)
 * for power averaging (mean of k independent exponentials).
 */
export function medianToMeanRatio(nRecords: number, coherent: boolean): number {
  const k = coherent ? 1 : Math.max(Math.trunc(nRecords), 1);
  if (k <= 1) return Math.LN2;
  let x = k * (1 - 1 / (9 * k)) ** 3;
  for (let it = 0; it < 12; it++) {
    const mode = Math.min(k - 1, Math.floor(x));
    const pm = Math.exp(mode * Math.log(x) - x - logFactorial(mode));
    let q = pm, term = pm;
    for (let j = mode - 1; j >= 0; j--) {
      term *= (j + 1) / x;
      q += term;
      if (term < 1e-17 * q) break;
    }
    term = pm;
    let pLast = mode === k - 1 ? pm : 0;
    for (let j = mode + 1; j < k; j++) {
      term *= x / j;
      q += term;
      if (j === k - 1) pLast = term;
      else if (term < 1e-17 * q) break;
    }
    if (mode < k - 1 && pLast === 0) pLast = Math.exp((k - 1) * Math.log(x) - x - logFactorial(k - 1));
    const dx = (0.5 - q) / pLast;
    x -= dx;
    if (Math.abs(dx) <= 1e-15 * x) break;
  }
  return x / k;
}

/**
 * _align_spectrum_phase (ADCToolbox PR #130): rotate a full FFT so the fundamental sits at phase 0. Harmonic h and its
 * ±lobeHalfWidth window main-lobe bins turn by h times the fundamental's rotation (conjugated where folded from an odd
 * Nyquist zone), lowest harmonic order winning; every remaining bin turns by bin / refined fundamental; DC is dropped.
 */
export function alignPhase(re: Float64Array, im: Float64Array, bin: number, refined: number, lobeHalfWidth = 0): void {
  const n = re.length;
  if (bin <= 0) return;
  const size = Math.hypot(re[bin], im[bin]) + 1e-20;
  const rotationAngle = -Math.atan2(im[bin] / size, re[bin] / size);
  const nHalf = Math.floor(n / 2);
  const halfWidth = Math.max(Math.trunc(lobeHalfWidth), 0);

  const noOwner = n + 1;
  const owner = new Int32Array(nHalf + 1).fill(noOwner);
  const oddZone = new Uint8Array(n);
  for (let h = 1; h <= n; h++) {
    const folded = (h * bin) % n;
    const odd = 2 * folded >= n;
    oddZone[h - 1] = odd ? 1 : 0;
    const center = odd ? n - folded : folded;
    for (let offset = -halfWidth; offset <= halfWidth; offset++) {
      const pos = center + offset;
      if (pos >= 0 && pos <= nHalf && h < owner[pos]) owner[pos] = h;
    }
  }

  for (let pos = 0; pos <= nHalf; pos++) {
    const h = owner[pos];
    if (h === noOwner) continue;
    const signedOrder = oddZone[h - 1] ? -h : h;
    const angle = rotationAngle * signedOrder;
    const c = Math.cos(angle), s = Math.sin(angle);
    [re[pos], im[pos]] = [re[pos] * c - im[pos] * s, re[pos] * s + im[pos] * c];
  }

  if (refined > 0) {
    for (let pos = 0; pos < n; pos++) {
      if (pos <= nHalf && owner[pos] !== noOwner) continue;
      const angle = (rotationAngle * pos) / refined;
      const c = Math.cos(angle), s = Math.sin(angle);
      [re[pos], im[pos]] = [re[pos] * c - im[pos] * s, re[pos] * s + im[pos] * c];
    }
  }
  re[0] = 0;
  im[0] = 0;
}

/** _locate_fundamental: the largest bin above DC, and its parabola-refined position. */
function locate(P: Float64Array, inband: number): { bin: number; refined: number } {
  let bin = inband > 1 ? 1 : 0;
  for (let k = 2; k < inband; k++) if (P[k] > P[bin]) bin = k;
  return { bin, refined: fractionalPeak(P, bin, inband) };
}

/**
 * compute_spectrum(runs, win_type, coherent_averaging, max_harmonic), with max_scale_range left to the data's own span
 * and side_bin to auto detection. `runs` are records of the same length.
 */
export function averagedSpectrum(runs: Float64Array[], kind: Window, coherent: boolean, maxHarmonic = 5): AveragedSpectrum {
  const n = runs[0].length, half = Math.floor(n / 2), inband = inbandBins(n);
  let lo = Infinity, hi = -Infinity;
  for (const run of runs) for (const v of run) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  const peak = (hi - lo) / 2;
  const w = windowOf(kind, n);
  const gain = npSum(w) / n, enbw = (n * npSum(w.map((v) => v * v))) / npSum(w) ** 2;
  const correction = 4 / (gain ** 2 * enbw);
  const prepared = runs.map((run) => {
    const mean = npSum(run) / n;
    return run.map((v, i) => ((v - mean) / (peak || 1)) * w[i]);
  });

  const power = new Float64Array(half + 1);
  let re: Float64Array | null = null, im: Float64Array | null = null;
  let nAveraged = prepared.length;
  if (coherent) {
    const sr = new Float64Array(n), si = new Float64Array(n);
    const lobeHalfWidth = SIDE_BINS[kind];
    let valid = 0;
    for (const run of prepared) {
      if (Math.max(...Array.from(run, Math.abs)) < 1e-10) continue;
      const fr = Float64Array.from(run), fi = new Float64Array(n);
      fftAny(fr, fi);
      const raw = Float64Array.from({ length: half + 1 }, (_, k) => Math.hypot(fr[k], fi[k]) ** 2);
      const { bin, refined } = locate(raw, inband);
      if (bin <= 0) continue;
      alignPhase(fr, fi, bin, refined, lobeHalfWidth);
      for (let k = 0; k < n; k++) {
        sr[k] += fr[k];
        si[k] += fi[k];
      }
      valid++;
    }
    nAveraged = valid;
    const den = n * (valid || 1);
    re = Float64Array.from({ length: half + 1 }, (_, k) => sr[k] / den);
    im = Float64Array.from({ length: half + 1 }, (_, k) => si[k] / den);
    for (let k = 0; k <= half; k++) power[k] = Math.hypot(re[k], im[k]) ** 2;
    power[0] /= 2;
    re[0] /= Math.SQRT2;
    im[0] /= Math.SQRT2;
    if (n % 2 === 0) {
      power[half] /= 2;
      re[half] /= Math.SQRT2;
      im[half] /= Math.SQRT2;
    }
    const scale = Math.sqrt(correction);
    for (let k = 0; k <= half; k++) {
      re[k] *= scale;
      im[k] *= scale;
    }
  } else {
    const nonzero = prepared.filter((run) => Math.max(...Array.from(run, Math.abs)) >= 1e-10);
    const active = nonzero.length ? nonzero : prepared;
    nAveraged = active.length;
    for (const run of active) {
      const fr = Float64Array.from(run), fi = new Float64Array(n);
      fftAny(fr, fi);
      for (let k = 0; k <= half; k++) power[k] += Math.hypot(fr[k], fi[k]) ** 2;
    }
    for (let k = 0; k <= half; k++) power[k] = power[k] / nAveraged / (n * n);
    power[0] /= 2;
    if (n % 2 === 0) power[half] /= 2;
  }
  for (let k = 0; k <= half; k++) power[k] *= correction;

  const { bin: signal, refined } = locate(power, inband);
  const sideBin = autoSideBin(power, signal, inband, w, correction, kind);
  const start = Math.max(signal - sideBin, 0), end = Math.min(signal + sideBin + 1, inband);
  const sig = npSum(power, start, end);

  const harmonicBins = Array.from({ length: maxHarmonic - 1 }, (_, i) => Math.min(roundEven(foldFractional(refined * (i + 2), n)), half));
  const harmonicPower = harmonicBins.map(() => 1e-15);
  const thdBins = new Set<number>();
  harmonicBins.forEach((center, i) => {
    if (center <= sideBin) return;
    const lobe: number[] = [];
    for (let k = Math.max(center - sideBin, 0); k < Math.min(center + sideBin + 1, power.length); k++) {
      if (k < sideBin + 1 || (k >= start && k < end)) continue;
      lobe.push(k);
    }
    if (!lobe.length) return;
    harmonicPower[i] = Math.max(npSum(lobe.map((k) => power[k])), 1e-15);
    lobe.forEach((k) => thdBins.add(k));
  });
  const thdPower = Math.max(thdBins.size ? npSum([...thdBins].sort((a, b) => a - b).map((k) => power[k])) : 1e-15, 1e-15);

  // the strongest spur lobe outside DC and the signal band
  const rest = Float64Array.from(power.subarray(0, inband), (v, k) => (k < sideBin || (k >= start && k < end) ? 0 : v));
  const { spur, spurPower } = highestSpur(rest, sig, power[signal], start, end, sideBin, inband, npSum);

  const sndr = 10 * Math.log10(sig / (npSum(rest) + 1e-20));

  // nf_method 0: the median of a median-based, a trimmed-mean and an excluding estimate of the noise
  const floorBins = Array.from(rest).filter((v) => Math.abs(v) > 1e-20);
  const pool = floorBins.length ? floorBins : Array.from(rest);
  const mn = medianToMeanRatio(nAveraged, coherent);
  const byMedian = (median(pool) / mn) * inband;
  const sorted = [...pool].sort((a, b) => a - b);
  const from = Math.max(1, Math.floor(sorted.length * 0.05)) - 1;
  const to = Math.min(Math.max(from + 1, Math.max(1, Math.floor(sorted.length * 0.95))), sorted.length);
  const trimmed = (npSum(sorted, from, to) / (to - from)) * inband;
  const excluded = Float64Array.from(rest);
  for (const center of harmonicBins) {
    if (center <= sideBin) continue;
    for (let k = Math.max(center - sideBin, 0); k < Math.min(center + sideBin + 1, inband); k++) excluded[k] = 0;
  }
  const noise = Math.max(median([byMedian, trimmed, npSum(excluded)]), 1e-15);

  return {
    power,
    dbfs: power.map((p) => 10 * Math.log10(p + 1e-20)),
    re,
    im,
    signal,
    refined,
    sideBin,
    harmonicBins,
    harmonics: harmonicPower.map((p) => 10 * Math.log10(p / sig)),
    thd: 10 * Math.log10(thdPower / sig),
    spur,
    sfdr: spurPower > 0 ? 10 * Math.log10(sig / spurPower) : Infinity,
    sigDbfs: 10 * Math.log10(Math.max(sig, 1e-30)),
    sndr,
    snr: 10 * Math.log10(sig / noise),
    enob: (sndr - 1.76) / 6.02,
  };
}

/** foldBin re-exported for the integer bins the pages mark. */
export { foldBin };
