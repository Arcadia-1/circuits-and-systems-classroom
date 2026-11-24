/**
 * ADCToolbox analyze_spectrum (spectrum/compute_spectrum, spectrum/_window, spectrum/_harmonics,
 * spectrum/_side_bin_auto) as of b96e033 (0.9.3 plus PR #130): the window, its power correction, the side bins that
 * count as signal, integrated-lobe SFDR spur ranking with masked-lobe compensation, and the metrics built from them.
 * Harmonics 2 … 5.
 * Shared by the converter pages; python/sar_binary_vs_redundant.py checks the port against ADCToolbox itself.
 */
import { fftAny } from './fft';

function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export const N_FFT = 4096;

/** The windows of ADCToolbox's _create_window that are worth choosing between, periodic (scipy's sym=False). */
export type Window = 'rectangular' | 'hann' | 'hamming' | 'blackmanharris' | 'flattop';

const COSINES: Record<Window, number[]> = {
  rectangular: [1],
  hann: [0.5, 0.5],
  hamming: [0.54, 0.46],
  blackmanharris: [0.35875, 0.48829, 0.14128, 0.01168],
  flattop: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368],
};

/** Side bins ADCToolbox counts as signal for a coherent tone, from _SIDE_BIN_DEFAULTS. */
export const SIDE_BINS: Record<Window, number> = { rectangular: 0, hann: 1, hamming: 1, blackmanharris: 3, flattop: 4 };
/** _SIDE_BIN_AUTO_FALLBACKS: the side bins auto detection settles for when the leakage never meets the floor. */
export const AUTO_FALLBACK: Record<Window, number> = { rectangular: 1, hann: 3, hamming: 3, blackmanharris: 5, flattop: 6 };

export const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * _locate_fundamental's refinement: a parabola through the log powers of the peak and its neighbours, unless a
 * neighbour lies four decades down, where it is floor or a spur rather than leakage of the peak, or the peak sits
 * next to DC or the halved Nyquist bin.
 */
export function fractionalPeak(P: Float64Array, bin: number, inband: number): number {
  const upperLimit = Math.min(inband - 1, P.length - 2);
  if (bin <= 1 || bin >= upperLimit) return bin;
  const [m1, y0, p1] = [P[bin - 1], P[bin], P[bin + 1]].map((v) => Math.log10(Math.max(v, 1e-30)));
  if (Math.min(m1, p1) < y0 - 4) return bin;
  const denom = 2 * (2 * y0 - m1 - p1);
  if (denom === 0) return bin;
  const at = bin + (p1 - m1) / denom;
  return Number.isFinite(at) ? at : bin;
}

/**
 * _detect_side_bin_auto, MATLAB plotspec's sideBin 'auto': the windowed leakage of an ideal tone at the refined peak,
 * scaled to the measured peak, against the median of the in-band bins; the signal band stops one bin short of where the
 * leakage on both sides has sunk below that floor.
 */
export function autoSideBin(P: Float64Array, bin: number, inband: number, w: Float64Array, correction: number, kind: Window): number {
  const len = w.length, half = Math.floor(len / 2), at = fractionalPeak(P, bin, inband);
  const re = Float64Array.from(w, (v, t) => Math.sin((2 * Math.PI * at * t) / len) * v), im = new Float64Array(len);
  fftAny(re, im);
  const ideal = Float64Array.from({ length: half + 1 }, (_, k) => (re[k] ** 2 + im[k] ** 2) / len ** 2);
  ideal[0] /= 2;
  if (len % 2 === 0) ideal[half] /= 2;
  const top = Math.max(P[bin], 1e-30);
  for (let k = 0; k <= half; k++) ideal[k] *= correction;
  const scale = top / Math.max(ideal[bin], 1e-30);
  for (let k = 0; k <= half; k++) ideal[k] *= scale;
  const band = Array.from(P.subarray(0, inband)), positive = band.filter((v) => v > 0);
  const floor = Math.max(positive.length >= 3 ? median(positive) : median(band), top * 1e-24);
  const most = Math.min(bin, inband - 1 - bin), least = Math.max(SIDE_BINS[kind], 0);
  for (let sb = 1; sb <= most; sb++) {
    const left = bin - sb >= 0 && ideal[bin - sb] <= floor;
    const right = bin + sb < inband && ideal[bin + sb] <= floor;
    if (left && right) return Math.max(sb - 1, least);
  }
  return Math.max(Math.min(AUTO_FALLBACK[kind], most), least);
}

export function windowOf(kind: Window, n: number): Float64Array {
  const a = COSINES[kind];
  return Float64Array.from({ length: n }, (_, i) => {
    let v = a[0];
    for (let k = 1; k < a.length; k++) v += (k % 2 ? -a[k] : a[k]) * Math.cos((2 * Math.PI * k * i) / n);
    return v;
  });
}

export interface Spectrum {
  /** dBFS per bin, 0 … N_FFT/2 */
  dbfs: Float64Array;
  signal: number;
  spur: number;
  /** bins of harmonics 2 … 5 after folding */
  harmonics: number[];
  /** bins 0 … inband − 1 make up the analysis band, fs / (2·OSR) wide */
  inband: number;
  /** bins either side of the peak counted as signal */
  sideBin: number;
  sndr: number;
  enob: number;
  sfdr: number;
}

/** rfft_inband_bin_count: the bins from DC up to fs / (2·osr), the edge bin included when it falls on a whole bin. */
export function inbandBins(len: number, osr = 1): number {
  const edge = len / (2 * osr), whole = Math.round(edge);
  const at = Math.abs(edge - whole) <= 1e-12 + 1e-12 * Math.abs(whole) ? whole : edge;
  return Math.max(1, Math.min(Math.floor(at) + 1, Math.floor(len / 2) + 1));
}

/**
 * _extract_highest_spur's masked-lobe compensation (ADCToolbox #100). The spur is summed over its side bins with DC,
 * the signal band and the band edge zeroed, so a spur beside any of them loses part of its lobe and the SFDR reads up to
 * 1.8 dB optimistic. When the lobe touches a mask or an edge, it is rebuilt from its centre bin with the lobe-to-peak
 * ratio the fundamental shows, and the larger of the two estimates is kept. A fully visible lobe is left as summed.
 * `spurEnd` and `signalEnd` are exclusive.
 */
export function completeMaskedLobe(
  spurPower: number, spurPeak: number, signalPower: number, signalPeak: number,
  spurCenter: number, spurStart: number, spurEnd: number, signalStart: number, signalEnd: number, sideBin: number, inband: number,
  nFull = inband,
): number {
  const dcMaskEnd = Math.min(Math.max(sideBin, 1), inband);
  const touchesNyquist = inband === nFull && sideBin > 0 && spurCenter + sideBin >= inband - 1;
  const touchesEdge = spurCenter - sideBin < dcMaskEnd || spurCenter + sideBin + 1 > inband || touchesNyquist;
  const touchesSignal = Math.max(spurStart, signalStart) < Math.min(spurEnd, signalEnd);
  if (!(touchesEdge || touchesSignal) || signalPeak <= 0 || spurPeak <= 0) return spurPower;
  return Math.max(spurPower, (spurPeak * signalPower) / signalPeak);
}

/**
 * _extract_highest_spur (ADCToolbox #101 and #121): rank every local peak outside the DC and signal masks by its
 * integrated lobe power (centre ± sideBin, with masked-lobe compensation when the lobe touches a mask or band edge),
 * rather than by a single FFT bin. `rest` has length >= `inband` with masked bins already zeroed; `signalEnd` is
 * exclusive.
 */
export function highestSpur(
  rest: Float64Array, signalPower: number, signalPeak: number,
  signalStart: number, signalEnd: number, sideBin: number, inband: number,
  sumSlice: (a: Float64Array, start: number, end: number) => number = (a, s, e) => {
    let total = 0;
    for (let k = s; k < e; k++) total += a[k];
    return total;
  },
  nFull = inband,
): { spur: number; spurPower: number } {
  const dcMaskEnd = Math.min(Math.max(sideBin, 1), inband);
  const ratio = signalPeak > 0 ? signalPower / signalPeak : 0;
  const cum = new Float64Array(inband + 1);
  for (let k = 0; k < inband; k++) cum[k + 1] = cum[k] + rest[k];

  let spur = -1, bestRank = -Infinity;
  for (let k = 0; k < inband; k++) {
    const v = rest[k];
    if (v <= 0) continue;
    const left = k > 0 ? rest[k - 1] : -Infinity;
    const right = k + 1 < inband ? rest[k + 1] : -Infinity;
    if (v < left || v < right) continue;
    const lobeStart = Math.max(k - sideBin, 0), lobeEnd = Math.min(k + sideBin + 1, inband);
    const touchesNyquist = inband === nFull && sideBin > 0 && k + sideBin >= inband - 1;
    const touches = k - sideBin < dcMaskEnd || k + sideBin + 1 > inband || touchesNyquist
      || Math.max(lobeStart, signalStart) < Math.min(lobeEnd, signalEnd);
    const comp = touches && ratio > 0 ? v * ratio : 0;
    const rank = Math.max(cum[lobeEnd] - cum[lobeStart], comp);
    if (rank > bestRank) {
      bestRank = rank;
      spur = k;
    }
  }
  if (spur < 0) {
    spur = 0;
    for (let k = 1; k < inband; k++) if (rest[k] > rest[spur]) spur = k;
  }
  const spurStart = Math.max(spur - sideBin, 0), spurEnd = Math.min(spur + sideBin + 1, inband);
  const direct = sumSlice(rest, spurStart, spurEnd);
  const spurPower = completeMaskedLobe(direct, rest[spur], signalPower, signalPeak, spur, spurStart, spurEnd, signalStart, signalEnd, sideBin, inband, nFull);
  return { spur, spurPower };
}

/**
 * analyze_spectrum: remove DC, normalise to full scale 2^N, window, one-sided power corrected by 4 / mean(window²).
 * The signal is the fundamental bin and `sides` bins either side of it; everything else in band is noise, and the
 * strongest integrated spur lobe outside that band is the spur. The band runs to fs / (2·osr), all of the spectrum
 * when osr is 1. `sides` 'auto' is what analyze_spectrum does when side_bin is left as None.
 */
export function analyzeSpectrum(trace: Float64Array, n: number, kind: Window = 'rectangular', sides: number | 'auto' = 0, osr = 1): Spectrum {
  const len = trace.length, half = Math.floor(len / 2), mean = sum(trace) / len, peak = 2 ** (n - 1);
  const inband = inbandBins(len, osr), top = inband - 1;
  const w = windowOf(kind, len);
  let ww = 0;
  for (let i = 0; i < len; i++) ww += w[i] * w[i];
  const correction = 4 / (ww / len);
  const re = trace.map((v, i) => ((v - mean) / peak) * w[i]), im = new Float64Array(len);
  fftAny(re, im);
  const P = Float64Array.from({ length: half + 1 }, (_, k) => (correction * (re[k] ** 2 + im[k] ** 2)) / len ** 2);
  P[0] /= 2;
  if (len % 2 === 0) P[half] /= 2;
  let peakBin = 1;
  for (let k = 2; k <= top; k++) if (P[k] > P[peakBin]) peakBin = k;
  const sideBin = sides === 'auto' ? autoSideBin(P, peakBin, inband, w, correction, kind) : sides;
  const lo = Math.max(peakBin - sideBin, 0), hi = Math.min(peakBin + sideBin, top);
  let signalPower = 0;
  for (let k = lo; k <= hi; k++) signalPower += P[k];
  // everything the signal band and the DC leakage beside it do not claim; the rest is noise
  const dcMaskEnd = Math.min(Math.max(sideBin, 1), inband);
  const rest = Float64Array.from(P, (v, k) => ((k >= lo && k <= hi) || k < dcMaskEnd ? 0 : v));
  let noise = 0;
  for (let k = 0; k <= top; k++) noise += rest[k];
  // rank candidate spurs by their integrated lobe power over centre ± sideBin, compensating masked lobes
  const { spur, spurPower } = highestSpur(rest, signalPower, P[peakBin], lo, hi + 1, sideBin, inband, undefined, P.length);
  const fold = (b: number) => Math.min(b % len > half ? len - (b % len) : b % len, half);
  const sndr = 10 * Math.log10(signalPower / (noise + 1e-30));
  return {
    dbfs: P.map((p) => 10 * Math.log10(p + 1e-20)),
    signal: peakBin,
    spur,
    harmonics: [2, 3, 4, 5].map((h) => fold(h * peakBin)),
    inband,
    sideBin,
    sndr,
    enob: (sndr - 1.76) / 6.02,
    sfdr: 10 * Math.log10(signalPower / spurPower),
  };
}
