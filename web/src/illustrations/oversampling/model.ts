/**
 * Oversampling and noise shaping: sample faster than the band needs and only the band's share of the quantisation
 * noise counts; shape that noise and even less of it stays there.
 * Analysed with ADCToolbox (github.com/Arcadia-1/ADCToolbox):
 *   spectrum/              analyze_spectrum with an OSR, through src/lib/spectrum.ts
 *   oversampling/ntfperf   ntf_analyzer on MATLAB's million-point grid
 *   oversampling/perfosr   sweep_performance_vs_osr, with fundamentals/fit_sine_4param
 *   oversampling/ifilter   spectrum/extract_freq_components
 * following its examples exp_o01, exp_o02 and exp_o03.
 *
 * The displayed record uses the standard stationary linearised quantisation-noise model: a seeded white error with
 * variance LSB²/12, passed through the NTF with periodic boundary conditions. The periodic boundary is important for
 * an FFT lesson: it avoids inventing the broadband impulse produced when a finite FIR is started from zero. A clean
 * coherent sine quantised without dither has deterministic harmonic lines instead of a noise floor, while
 * apply_noise_shaping deliberately preserves those exact errors; that is useful for API testing but obscures the NTF
 * slope this lesson is meant to explain.
 *
 * python/adc_oversampling.py builds the same stationary record and calls ADCToolbox on it; the tests compare the two.
 *
 * Volts on a ±0.5 V range, as exp_o01 has them: 8192 samples at 100 MHz.
 */
import { fftAny } from '../../lib/fft';
import { coherentFrequency, foldFrequency } from '../../lib/frequency';
import { analyzeSpectrum, inbandBins, type Spectrum } from '../../lib/spectrum';

export const N = 8192;
export const FS = 100e6;
export const AMP = 0.4;
export const ORDERS = [0, 1, 2, 3];
export const OSRS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
/** exp_o03's tone, fs/640, low enough to stay in the band at every OSR offered */
export const TONE = coherentFrequency(FS, FS / 640, N);

/** (1 − z⁻¹)^order, the noise transfer function apply_noise_shaping uses unless it is given one. */
export function ntfTaps(order: number): number[] {
  let taps = [1];
  for (let i = 0; i < order; i++) taps = [...taps, 0].map((c, k) => c - (k ? taps[k - 1] : 0));
  return taps;
}

const UNIT_ERROR = (() => {
  // Portable LCG: python/adc_oversampling.py uses the same unsigned 32-bit recurrence and therefore the same record.
  let state = 0x5eed1234;
  return Float64Array.from({ length: N }, () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return (state + 0.5) / 2 ** 32 - 0.5;
  });
})();

const UNIT_WHITE = (() => {
  // A second portable white sequence, normalised to exactly 1 rms before the UI scales it in LSB rms.
  let state = 0xc0ffee12;
  const out = Float64Array.from({ length: N }, () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return (state + 0.5) / 2 ** 32 - 0.5;
  });
  let mean = 0, power = 0;
  for (const v of out) mean += v / N;
  for (const v of out) power += (v - mean) ** 2 / N;
  const sigma = Math.sqrt(power);
  return out.map((v) => (v - mean) / sigma);
})();

/**
 * A sine plus stationary quantisation noise of variance LSB²/12 and optional independent, unshaped white noise. Each
 * order takes one circular first difference of the quantisation error, so its DFT is exactly multiplied by
 * (1 − z⁻¹) and contains no artificial filter-startup impulse.
 */
export function capture(order: number, bits: number, whiteNoiseLsb = 0): Float64Array {
  const lsb = 1 / 2 ** bits;
  const sine = Float64Array.from({ length: N }, (_, i) => AMP * Math.sin(2 * Math.PI * TONE.fin * (i / FS)) + 0);
  let error = UNIT_ERROR.map((v) => v * lsb);
  for (let pass = 0; pass < order; pass++) error = error.map((v, i) => v - error[(i + N - 1) % N]);
  return sine.map((s, i) => s + error[i] + UNIT_WHITE[i] * whiteNoiseLsb * lsb);
}

/** analyze_spectrum on the ±0.5 V range: codes of the same resolution scale it to the full scale the port expects. */
export const spectrumOf = (data: Float64Array, bits: number, osr: number): Spectrum =>
  analyzeSpectrum(data.map((v) => v * 2 ** bits), bits, 'rectangular', 0, osr);

const GRID = 1_000_000;
const ntfPower = new Map<string, number>();

/**
 * ntfperf: how far the in-band noise of (1 − z⁻¹)^order sits below a flat NTF over the whole band, dB, integrated on
 * MATLAB's grid of a million frequencies in (0, fs/2]. |NTF|² there is (2 sin πf)^(2·order).
 */
export function ntfperf(order: number, osr: number): number {
  const key = `${order}/${osr}`;
  let power = ntfPower.get(key);
  if (power === undefined) {
    power = 0;
    for (let k = 1; k <= GRID; k++) {
      const w = k / GRID / 2;
      if (!(w < 0.5 / osr)) break;
      const s = 2 * Math.sin(Math.PI * w);
      power += (s * s) ** order;
    }
    power /= GRID;
    ntfPower.set(key, power);
  }
  return -10 * Math.log10(power);
}

/** The SNR of white quantisation noise over the whole band, which ntfperf's gain is measured from. */
export const whiteSnr = (bits: number): number => 10 * Math.log10(AMP ** 2 / 2 / ((1 / 2 ** bits) ** 2 / 12));

/**
 * What analyze_spectrum reads in one bin, dBFS, for quantisation noise of lsb²/12 through the NTF plus independent
 * unshaped white noise: on the ±0.5 V range a variance σ² lands 16σ²/N in each bin.
 */
export const floorModel = (bits: number, order: number, whiteNoiseLsb = 0) => (bin: number): number => {
  const lsb = 1 / 2 ** bits;
  const ntf = (2 * Math.sin((Math.PI * bin) / N)) ** (2 * order);
  return 10 * Math.log10((16 / N) * (lsb ** 2 / 12 * ntf + (whiteNoiseLsb * lsb) ** 2));
};

export interface NoiseBudget {
  bins: Float64Array;
  ntfDb: Float64Array;
  /** Noise accumulated from DC through this bin, relative to all noise through Nyquist. */
  cumulativeDb: Float64Array;
}

/** The NTF itself and the running integral of the shaped + unshaped noise it produces. */
export function noiseBudget(order: number, bits: number, whiteNoiseLsb = 0): NoiseBudget {
  const half = N / 2, lsb = 1 / 2 ** bits, quant = lsb ** 2 / 12, white = (whiteNoiseLsb * lsb) ** 2;
  const bins = Float64Array.from({ length: half }, (_, i) => i + 1);
  const ntfDb = bins.map((bin) => {
    const magnitude = (2 * Math.sin((Math.PI * bin) / N)) ** order;
    return 20 * Math.log10(Math.max(magnitude, 1e-20));
  });
  const power = bins.map((bin) => quant * (2 * Math.sin((Math.PI * bin) / N)) ** (2 * order) + white);
  let total = 0;
  for (const value of power) total += value;
  let sum = 0;
  const cumulativeDb = power.map((value) => {
    sum += value;
    return 10 * Math.log10(Math.max(sum / total, 1e-20));
  });
  return { bins, ntfDb, cumulativeDb };
}

/** Predicted in-band SNR when shaped quantisation noise and unshaped added white noise are independent. */
export function predictedSnr(bits: number, order: number, osr: number, whiteNoiseLsb = 0): number {
  const lsb = 1 / 2 ** bits;
  const shaped = lsb ** 2 / 12 * 10 ** (-ntfperf(order, osr) / 10);
  const white = (whiteNoiseLsb * lsb) ** 2 * 10 ** (-ntfperf(0, osr) / 10);
  return 10 * Math.log10((AMP ** 2 / 2) / (shaped + white));
}

/** Least squares by Householder QR, which keeps the design matrix's conditioning instead of squaring it. */
function leastSquares(columns: Float64Array[], y: Float64Array): number[] {
  const m = y.length, p = columns.length;
  const a = columns.map((c) => c.slice()), b = y.slice(), v = new Float64Array(m);
  for (let j = 0; j < p; j++) {
    let norm = 0;
    for (let i = j; i < m; i++) norm += a[j][i] ** 2;
    const alpha = a[j][j] > 0 ? -Math.sqrt(norm) : Math.sqrt(norm);
    let vv = 0;
    for (let i = j; i < m; i++) {
      v[i] = a[j][i] - (i === j ? alpha : 0);
      vv += v[i] ** 2;
    }
    if (!vv) continue;
    for (const col of [...a.slice(j), b]) {
      let dot = 0;
      for (let i = j; i < m; i++) dot += v[i] * col[i];
      const f = (2 * dot) / vv;
      for (let i = j; i < m; i++) col[i] -= f * v[i];
    }
  }
  const x = new Array<number>(p).fill(0);
  for (let j = p - 1; j >= 0; j--) {
    let s = b[j];
    for (let c = j + 1; c < p; c++) s -= a[c][j] * x[c];
    x[j] = s / a[j][j];
  }
  return x;
}

/** _estimate_frequency_fft: the largest bin through Nyquist, moved toward its larger neighbour by their magnitudes. */
function estimateFrequency(y: Float64Array): number {
  const n = y.length, half = Math.floor(n / 2), re = y.slice(), im = new Float64Array(n);
  fftAny(re, im);
  const mag = (k: number) => (k ? Math.hypot(re[k], im[k]) : 0);
  let k = 0;
  for (let i = 1; i <= half; i++) if (mag(i) > mag(k)) k = i;
  let at = k;
  if (k > 0 && k < half) {
    const r = mag(k + 1) > mag(k - 1) ? 1 : -1;
    at += (r * mag(k + r)) / (mag(k) + mag(k + r));
  }
  return at / n;
}

export interface SineFit {
  fitted: Float64Array;
  /** cycles per sample */
  frequency: number;
  amplitude: number;
}

const DEFAULT_MAX_ITERATIONS = 100;

function solveThreeParam(y: Float64Array, t: Float64Array, freq: number): { a: number; b: number; c: number; fitted: Float64Array; sse: number } {
  const n = y.length, omega = 2 * Math.PI * freq;
  const cos = t.map((k) => Math.cos(omega * k)), sin = t.map((k) => Math.sin(omega * k));
  const [a, b, c] = leastSquares([cos, sin, new Float64Array(n).fill(1)], y);
  const fitted = t.map((_, j) => a * cos[j] + b * sin[j] + c);
  let sse = 0;
  for (let j = 0; j < n; j++) sse += (y[j] - fitted[j]) ** 2;
  return { a, b, c, fitted, sse };
}

/**
 * fit_sine_4param (ADCToolbox PR #130) with no frequency given: three-parameter fit at the FFT estimate, then up to
 * 100 four-parameter refinement steps until convergence, followed by a three-parameter re-solve at the final frequency.
 */
export function fitSine(y: Float64Array, maxIterations = DEFAULT_MAX_ITERATIONS, tolerance = 1e-9): SineFit {
  const n = y.length, t = Float64Array.from({ length: n }, (_, i) => i);
  const initialFreq = estimateFrequency(y);
  const initial = solveThreeParam(y, t, initialFreq);
  let freq = initialFreq, { a, b, fitted } = initial;
  let nIter = 0, leftValidRange = false;

  for (let i = 1; i <= maxIterations; i++) {
    const omega = 2 * Math.PI * freq;
    const cos = t.map((k) => Math.cos(omega * k)), sin = t.map((k) => Math.sin(omega * k));
    const colScale = Math.max(n * Math.hypot(a, b), 1);
    const deriv = t.map((k, j) => (k / colScale) * (-a * sin[j] + b * cos[j]));
    const x = leastSquares([cos, sin, new Float64Array(n).fill(1), deriv], y);
    [a, b] = x;
    const delta = x[3] / colScale / (2 * Math.PI);
    nIter++;
    freq += delta;
    if (!(freq > 1e-10 && freq < 0.5 - 1e-10)) {
      leftValidRange = true;
      break;
    }
    if (Math.abs(delta) < tolerance) break;
  }

  let reverted = leftValidRange;
  if (!reverted && nIter > 0) {
    const refined = solveThreeParam(y, t, freq);
    let energy = 0;
    for (let j = 0; j < n; j++) energy += y[j] * y[j];
    if (refined.sse - initial.sse > 1e-18 * energy) reverted = true;
    else ({ a, b, fitted } = refined);
  }
  if (reverted) {
    freq = initialFreq;
    ({ a, b, fitted } = initial);
  }

  return { fitted, frequency: freq, amplitude: Math.sqrt(a ** 2 + b ** 2) };
}

/**
 * perfosr (sweep_performance_vs_osr): fit the sine, take the one-sided spectrum of the Hann-windowed residual, mask
 * DC and fundamental sine-fit leakage bins, and at each OSR divide the fitted sine's power by the cumulative residual
 * power up to fs / (2·OSR). SNDR in dB, one per OSR given.
 */
export function perfosr(data: Float64Array, osrs: number[]): number[] {
  const n = data.length, half = Math.floor(n / 2), fit = fitSine(data);
  const hann = Float64Array.from({ length: n }, (_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * i) / n)));
  let ww = 0;
  for (const h of hann) ww += h ** 2;
  const scale = Math.sqrt(ww / n);
  const re = data.map((v, i) => ((v - fit.fitted[i]) * hann[i]) / scale), im = new Float64Array(n);
  fftAny(re, im);
  const spec = Float64Array.from({ length: half + 1 }, (_, k) => ((re[k] ** 2 + im[k] ** 2) / n ** 2) * (k > 0 && k < half ? 2 : 1));
  // Mask DC leakage (bins 0..1) and fundamental sine-fit leakage (center ± 3 bins)
  spec[0] = 0;
  if (spec.length > 1) spec[1] = 0;
  const fundBin = Math.round(fit.frequency * n);
  if (fundBin >= 0 && fundBin < spec.length) {
    for (let k = Math.max(0, fundBin - 3); k < Math.min(spec.length, fundBin + 4); k++) spec[k] = 0;
  }
  const cum = new Float64Array(spec.length);
  let running = 0;
  for (let k = 0; k < spec.length; k++) {
    running += spec[k];
    cum[k] = running;
  }
  const signal = fit.amplitude ** 2 / 2;
  return osrs.map((osr) => {
    const bins = inbandBins(n, osr);
    const noise = cum[bins - 1];
    return noise > 0 ? 10 * Math.log10(signal / noise) : Infinity;
  });
}

/** ifilter (extract_freq_components) for one band, lo … hi of fs: keep those bins and their mirrors, drop the rest. */
export function ifilter(x: Float64Array, lo: number, hi: number): Float64Array {
  const n = x.length, re = x.slice(), im = new Float64Array(n), keep = new Uint8Array(n);
  fftAny(re, im);
  for (let k = Math.round(lo * n); k <= Math.round(hi * n); k++) {
    const id = Math.round(foldFrequency(k, n));
    keep[id] = 1;
    if (id > 0 && id < Math.floor(n / 2)) keep[n - id] = 1;
  }
  for (let k = 0; k < n; k++) if (!keep[k]) re[k] = im[k] = 0;
  // the forward transform read backwards is the inverse one, less its 1/n
  fftAny(re, im);
  return Float64Array.from({ length: n }, (_, k) => re[(n - k) % n] / n);
}

export const rms = (x: Float64Array): number => {
  let mean = 0, power = 0;
  for (const v of x) mean += v / x.length;
  for (const v of x) power += (v - mean) ** 2 / x.length;
  return Math.sqrt(power);
};

export interface Reading {
  data: Float64Array;
  /** analyze_spectrum over the band, and over everything to fs/2 */
  band: Spectrum;
  full: Spectrum;
  /** perfosr's SNDR at each of OSRS, and what ntfperf predicts there */
  sweep: number[];
  theory: number[];
  /** ifilter's band, 0 … fs / (2·OSR) */
  inband: Float64Array;
}

export function read(order: number, bits: number, osr: number, whiteNoiseLsb = 0): Reading {
  const data = capture(order, bits, whiteNoiseLsb);
  return {
    data,
    band: spectrumOf(data, bits, osr),
    full: spectrumOf(data, bits, 1),
    sweep: perfosr(data, OSRS),
    theory: OSRS.map((o) => predictedSnr(bits, order, o, whiteNoiseLsb)),
    inband: ifilter(data, 0, 0.5 / osr),
  };
}
