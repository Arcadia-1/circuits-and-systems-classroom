/**
 * ADCToolbox compute_spectrum (cd72061, 0.9.1 plus the masked-lobe SFDR fix of #101) over several runs of the same tone,
 * as analyze_spectrum does it (power averaging) and as analyze_spectrum_polar does it (coherent averaging, with the phase
 * of every bin kept):
 *   spectrum/_spectrum_averaging     _power_average, _coherent_average
 *   spectrum/_align_spectrum_phase   the rotation that puts every run's fundamental at phase 0
 *   spectrum/_harmonics              harmonic bins and their power, the largest spur
 *   spectrum/_estimate_noise_power   the noise floor behind SNR, nf_method 0
 * The pieces a single run shares with it live in src/lib/spectrum.ts. python/adc_polar_averaging.py checks this
 * against ADCToolbox itself.
 */
import { fftAny } from './fft';
import { foldBin } from './frequency';
import { npSum, roundEven } from './numeric';
import { autoSideBin, completeMaskedLobe, fractionalPeak, inbandBins, median, windowOf, type Window } from './spectrum';

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

/** np.complex128 ** float for a unit-size phasor: exp(p·log z), which is what the library's cpow comes down to. */
function cpow(re: number, im: number, p: number): [number, number] {
  if (p === 0) return [1, 0];
  const size = Math.exp(p * Math.log(Math.hypot(re, im))), angle = p * Math.atan2(im, re);
  return [size * Math.cos(angle), size * Math.sin(angle)];
}

/**
 * _align_spectrum_phase: rotate a full FFT so the fundamental sits at phase 0. The h-th harmonic turns by h times
 * the fundamental's rotation, conjugated where it folded from an odd Nyquist zone; every other bin turns by its own
 * fraction of that, bin / refined fundamental; DC is dropped.
 */
export function alignPhase(re: Float64Array, im: Float64Array, bin: number, refined: number): void {
  const n = re.length;
  if (bin <= 0) return;
  const size = Math.hypot(re[bin], im[bin]) + 1e-20;
  const pr = re[bin] / size, pi = -(im[bin] / size);
  const done = new Uint8Array(n);
  let hr = pr, hi = pi;
  for (let h = 1; h <= n; h++) {
    const f = bin * h;
    const even = Math.floor((f / n) * 2) % 2 === 0;
    const pos = even ? f - Math.floor(f / n) * n : n - f + Math.floor(f / n) * n;
    if (pos >= 0 && pos < n && !done[pos]) {
      const qi = even ? hi : -hi;
      [re[pos], im[pos]] = [re[pos] * hr - im[pos] * qi, re[pos] * qi + im[pos] * hr];
      done[pos] = 1;
    }
    [hr, hi] = [hr * pr - hi * pi, hr * pi + hi * pr];
  }
  for (let pos = 0; pos < n; pos++) {
    if (done[pos]) continue;
    const [cr, ci] = cpow(pr, pi, refined > 0 ? pos / refined : 0);
    [re[pos], im[pos]] = [re[pos] * cr - im[pos] * ci, re[pos] * ci + im[pos] * cr];
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
  const m = runs.length, n = runs[0].length, half = n / 2, inband = inbandBins(n);
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
  if (coherent) {
    const sr = new Float64Array(n), si = new Float64Array(n);
    let valid = 0;
    for (const run of prepared) {
      if (Math.max(...Array.from(run, Math.abs)) < 1e-10) continue;
      const fr = Float64Array.from(run), fi = new Float64Array(n);
      fftAny(fr, fi);
      const raw = Float64Array.from({ length: half + 1 }, (_, k) => Math.hypot(fr[k], fi[k]) ** 2);
      const { bin, refined } = locate(raw, inband);
      if (bin <= 0) continue;
      alignPhase(fr, fi, bin, refined);
      for (let k = 0; k < n; k++) {
        sr[k] += fr[k];
        si[k] += fi[k];
      }
      valid++;
    }
    const den = n * (valid || 1);
    re = Float64Array.from({ length: half + 1 }, (_, k) => sr[k] / den);
    im = Float64Array.from({ length: half + 1 }, (_, k) => si[k] / den);
    for (let k = 0; k <= half; k++) power[k] = Math.hypot(re[k], im[k]) ** 2;
    for (const k of [0, half]) {
      power[k] /= 2;
      re[k] /= Math.SQRT2;
      im[k] /= Math.SQRT2;
    }
    const scale = Math.sqrt(correction);
    for (let k = 0; k <= half; k++) {
      re[k] *= scale;
      im[k] *= scale;
    }
  } else {
    for (const run of prepared) {
      const fr = Float64Array.from(run), fi = new Float64Array(n);
      fftAny(fr, fi);
      for (let k = 0; k <= half; k++) power[k] += Math.hypot(fr[k], fi[k]) ** 2;
    }
    for (let k = 0; k <= half; k++) power[k] = power[k] / m / (n * n);
    power[0] /= 2;
    power[half] /= 2;
  }
  for (let k = 0; k <= half; k++) power[k] *= correction;

  const { bin: signal, refined } = locate(power, inband);
  const sideBin = autoSideBin(power, signal, inband, w, correction, kind);
  const start = Math.max(signal - sideBin, 0), end = Math.min(signal + sideBin + 1, inband);
  const sig = npSum(power, start, end);

  const harmonicBins = Array.from({ length: maxHarmonic - 1 }, (_, i) => roundEven(foldFractional(refined * (i + 2), n)));
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

  // the largest spur outside DC and the signal band
  const rest = Float64Array.from(power.subarray(0, inband), (v, k) => (k < sideBin || (k >= start && k < end) ? 0 : v));
  let spur = 0;
  for (let k = 1; k < inband; k++) if (rest[k] > rest[spur]) spur = k;
  const spurStart = Math.max(spur - sideBin, 0), spurEnd = Math.min(spur + sideBin + 1, inband);
  const spurPower = completeMaskedLobe(npSum(rest, spurStart, spurEnd), rest[spur], sig, power[signal], spurStart, spurEnd, start, end, sideBin, inband);

  const sndr = 10 * Math.log10(sig / (npSum(rest) + 1e-20));

  // nf_method 0: the median of a median-based, a trimmed-mean and an excluding estimate of the noise
  const floorBins = Array.from(rest).filter((v) => Math.abs(v) > 1e-20);
  const pool = floorBins.length ? floorBins : Array.from(rest);
  const mn = m === 1 ? 0.72 : (1 - 2 / (9 * m)) ** 3;
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
