/**
 * ADCToolbox analyze_spectrum (spectrum/compute_spectrum and spectrum/_window) as of cd72061, 0.9.1 plus the masked-lobe
 * SFDR fix of #101: the window, its power correction, the side bins that count as signal, and the metrics built from
 * them. Harmonics 2 … 5.
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
 * neighbour lies four decades down, where it is floor or a spur rather than leakage of the peak.
 */
export function fractionalPeak(P: Float64Array, bin: number, inband: number): number {
  if (bin <= 0 || bin >= inband - 1) return bin;
  const [m1, y0, p1] = [P[bin - 1], P[bin], P[bin + 1]].map((v) => Math.log10(Math.max(v, 1e-20)));
  if (Math.min(m1, p1) < y0 - 4) return bin;
  const at = bin + (p1 - m1) / (2 * (2 * y0 - m1 - p1));
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
  const band = Array.from(P.subarray(0, inband)), positive = band.filter((v) => v > 1e-20);
  const floor = Math.max(positive.length >= 3 ? median(positive) : median(band), top * 1e-24);
  const most = Math.min(bin, inband - 1 - bin), least = Math.min(Math.max(SIDE_BINS[kind], 0), most);
  for (let sb = 1; sb <= most; sb++) {
    const left = bin - sb >= 0 && ideal[bin - sb] <= floor;
    const right = bin + sb < inband && ideal[bin + sb] <= floor;
    if (left && right) return Math.max(sb - 1, least);
  }
  return Math.min(Math.max(AUTO_FALLBACK[kind], least), most);
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
  spurStart: number, spurEnd: number, signalStart: number, signalEnd: number, sideBin: number, inband: number,
): number {
  const touchesEdge = spurStart === 0 || spurEnd === inband;
  const touchesDc = spurStart < Math.min(sideBin, inband);
  const touchesSignal = Math.max(spurStart, signalStart) < Math.min(spurEnd, signalEnd);
  if (!(touchesEdge || touchesDc || touchesSignal) || signalPeak <= 0 || spurPeak <= 0) return spurPower;
  return Math.max(spurPower, (spurPeak * signalPower) / signalPeak);
}

/**
 * analyze_spectrum: remove DC, normalise to full scale 2^N, window, one-sided power corrected by 4 / mean(window²).
 * The signal is the fundamental bin and `sides` bins either side of it; everything else in band is noise, and the
 * largest bin outside that band is the spur. The band runs to fs / (2·osr), all of the spectrum when osr is 1.
 * `sides` 'auto' is what analyze_spectrum does when side_bin is left as None.
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
  // everything the signal band and the DC leakage beside it do not claim; the rest is noise, and its peak is the spur
  const rest = Float64Array.from(P, (v, k) => ((k >= lo && k <= hi) || k < sideBin ? 0 : v));
  let spur = 0, noise = 0;
  for (let k = 0; k <= top; k++) {
    noise += rest[k];
    if (rest[k] > rest[spur]) spur = k;
  }
  // a windowed spur is spread over the same side bins as the signal, so it is measured over the same span
  const spurStart = Math.max(spur - sideBin, 0), spurLast = Math.min(spur + sideBin, top);
  let spurPower = 0;
  for (let k = spurStart; k <= spurLast; k++) spurPower += rest[k];
  spurPower = completeMaskedLobe(spurPower, rest[spur], signalPower, P[peakBin], spurStart, spurLast + 1, lo, hi + 1, sideBin, inband);
  const fold = (b: number) => (b % len > half ? len - (b % len) : b % len);
  const sndr = 10 * Math.log10(signalPower / (noise + 1e-20));
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
