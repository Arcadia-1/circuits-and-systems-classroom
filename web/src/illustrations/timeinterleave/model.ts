/**
 * Time-interleaved converters: M slower sub-ADCs take turns, and whatever differs between them, an offset, a gain, the
 * instant each one samples, repeats every M samples and becomes spurs. One sine is enough to measure all three and take
 * them out again across the aggregate first Nyquist zone.
 * Ported from ADCToolbox (b96e033, github.com/Arcadia-1/ADCToolbox):
 *   timeinterleave/   deinterleave, interleave, extract_mismatch_sine, predict_spurs, calibrate_foreground,
 *                     fractional_delay_fft, fractional_delay_farrow
 *   fundamentals/     find_coherent_frequency, fold_frequency_to_nyquist, through src/lib/frequency.ts
 *   siggen/           apply_quantization_noise, and apply_thermal_noise's sum
 *   spectrum/         analyze_spectrum, through src/lib/spectrum.ts
 * following its example exp_ti01, which builds the mismatched capture this way and compares the two delays.
 * python/adc_time_interleave.py calls ADCToolbox on the same samples; tests/timeinterleave-model.test.ts compares the two.
 *
 * Volts on a ±0.5 V range, seconds and hertz: about 4096 samples at 1 GS/s, adjusted to complete channel turns.
 */
import { fftAny } from '../../lib/fft';
import { coherentFrequency, foldFrequency } from '../../lib/frequency';
import { solve } from '../../lib/numeric';
import { gaussians } from '../../lib/rng';
import { analyzeSpectrum, N_FFT, type Spectrum } from '../../lib/spectrum';
import { fitSine } from '../errors/model';

export const FS = 1e9;
export const N = N_FFT;
export const AMP = 0.4;
export const MIN_CHANNELS = 1;
export const MAX_CHANNELS = 16;
export const MAX_DECIMATION = 255;
export const HARMONIC_ORDERS = [2, 3, 5, 7] as const;
export type HarmonicOrder = (typeof HARMONIC_ORDERS)[number];
export type HarmonicLevels = Record<HarmonicOrder, number>;
export const HARMONIC_PHASE: HarmonicLevels = { 2: 0.31, 3: -0.47, 5: 0.83, 7: -1.11 };
/** exp_ti01's Farrow interpolator */
export const TAPS = 9;
export const DEFAULT_THERMAL_NOISE_LSB = 0.3;
const NOISE_SEED = 7;
const JITTER_SEED = 71;

export type Method = 'off' | 'fft' | 'farrow';

/**
 * Keep the record close to 4096 points, even, and an integer number of complete channel turns. Then the carrier and
 * every k·fs/M mismatch image can be coherent in the same rectangular FFT, including for odd channel counts.
 */
export function analysisPoints(m: number): number {
  if (!Number.isInteger(m) || m < MIN_CHANNELS || m > MAX_CHANNELS) throw new Error(`unsupported channel count ${m}`);
  const period = m % 2 === 0 ? m : 2 * m;
  return N - (N % period);
}

/** Per channel: relative gain, offset in volts, skew in seconds. */
export interface Mismatch {
  gain: Float64Array;
  offset: Float64Array;
  skew: Float64Array;
  /** Relative mismatch of each channel's one-pole input bandwidth. */
  bandwidth?: Float64Array;
}

// One fixed draw per quantity and channel; the controls only scale it. Keep the original first eight values so the
// 2/4/8-channel reference cases remain unchanged, then extend each independent pattern through the UI's full range.
const LEGACY_DRAWS = gaussians(32, 2026);
const DRAWS = Array.from({ length: 4 }, (_, which) => {
  const values = gaussians(MAX_CHANNELS, 2027 + which);
  values.set(LEGACY_DRAWS.subarray(8 * which, 8 * (which + 1)));
  return values;
});

/** Draws `which` for the first m channels, less their mean and scaled to an rms of one. */
export function pattern(which: number, m: number): Float64Array {
  if (!Number.isInteger(m) || m < MIN_CHANNELS || m > MAX_CHANNELS) throw new Error(`unsupported channel count ${m}`);
  // A single ADC has no channel-to-channel mismatch. It is still useful as the non-interleaved reference case.
  if (m === 1) return new Float64Array(1);
  const source = DRAWS[which];
  if (!source) throw new Error(`unsupported mismatch pattern ${which}`);
  const z = source.slice(0, m);
  let sum = 0, square = 0;
  for (const v of z) sum += v;
  const d = z.map((v) => v - sum / m);
  for (const v of d) square += v * v;
  return d.map((v) => v / Math.sqrt(square / m));
}

/** A mismatch with the given rms across the m channels: gain as a fraction, offset in volts, skew in seconds. */
export function mismatch(m: number, gainRms: number, offsetRms: number, skewRms: number, bandwidthRms?: number): Mismatch {
  const out: Mismatch = {
    gain: pattern(0, m).map((z) => 1 + gainRms * z),
    offset: pattern(1, m).map((z) => offsetRms * z),
    skew: pattern(2, m).map((z) => skewRms * z),
  };
  if (bandwidthRms !== undefined) out.bandwidth = pattern(3, m).map((z) => bandwidthRms * z);
  return out;
}

export interface CaptureOptions {
  fs?: number;
  /** Shared one-pole analog input bandwidth in hertz. Defaults to fs/2. */
  analogBandwidth?: number;
  /** Input-referred white thermal-noise RMS, in ideal converter LSB. */
  thermalNoiseLsb?: number;
  /** RMS aperture jitter in seconds. */
  jitter?: number;
  /** Independent source harmonics in dBc. Values at or below −100 dBc are disabled. */
  harmonics?: Partial<HarmonicLevels>;
  /** Keep every Dth converter sample, without an anti-alias filter. */
  decimation?: number;
}

const harmonicLevel = (harmonics: Partial<HarmonicLevels>, order: HarmonicOrder): number => harmonics[order] ?? -Infinity;

/** The source before channel mismatch: fundamental plus independently controlled H2, H3, H5, and H7. */
export function inputValue(t: number, fin: number, harmonics: Partial<HarmonicLevels> = {}): number {
  let v = AMP * Math.cos(2 * Math.PI * fin * t);
  for (const order of HARMONIC_ORDERS) {
    const dbc = harmonicLevel(harmonics, order);
    if (dbc > -100) v += AMP * 10 ** (dbc / 20) * Math.cos(2 * Math.PI * order * fin * t + HARMONIC_PHASE[order]);
  }
  return v;
}

/**
 * A channel bandwidth error shifts its physical one-pole analog input corner around the selected common bandwidth.
 */
export function bandwidthResponse(relativeError: number, frequency: number, analogBandwidth: number): { amplitude: number; phase: number } {
  if (!Number.isFinite(analogBandwidth) || analogBandwidth <= 0) throw new Error(`invalid analog bandwidth ${analogBandwidth}`);
  const actual = analogBandwidth * Math.max(0.05, 1 + relativeError);
  const x = frequency / actual;
  return {
    amplitude: 1 / Math.sqrt(1 + x * x),
    phase: -Math.atan(x),
  };
}

/** SNR imposed by input-referred white thermal noise alone; quantisation and all other errors are excluded. */
export function thermalOnlySnr(bits: number, noiseLsb: number, frequency: number, analogBandwidth: number): number {
  if (!Number.isFinite(noiseLsb) || noiseLsb < 0) throw new Error(`invalid thermal noise ${noiseLsb} LSB`);
  if (noiseLsb === 0) return Infinity;
  const signalRms = AMP * bandwidthResponse(0, frequency, analogBandwidth).amplitude / Math.SQRT2;
  const noiseRms = noiseLsb / 2 ** bits;
  return 20 * Math.log10(signalRms / noiseRms);
}

/** Small-jitter sine-wave limit: SNR = -20 log10(2 pi f_in sigma_t). */
export function jitterOnlySnr(frequency: number, jitter: number): number {
  if (!Number.isFinite(jitter) || jitter < 0) throw new Error(`invalid aperture jitter ${jitter}`);
  return jitter === 0 || frequency === 0 ? Infinity : -20 * Math.log10(2 * Math.PI * Math.abs(frequency) * jitter);
}

/** The same memoryless converter sampled at ADC indices 0, stride, 2·stride, … . */
function captureAtStride(fin: number, mm: Mismatch, bits: number, len: number, options: CaptureOptions, stride: number): Float64Array {
  const fs = options.fs ?? FS, jitter = options.jitter ?? 0, harmonics = options.harmonics ?? {};
  const analogBandwidth = options.analogBandwidth ?? fs / 2;
  const thermalNoiseLsb = options.thermalNoiseLsb ?? DEFAULT_THERMAL_NOISE_LSB;
  if (!Number.isFinite(thermalNoiseLsb) || thermalNoiseLsb < 0) throw new Error(`invalid thermal noise ${thermalNoiseLsb} LSB`);
  const m = mm.gain.length, T = 1 / fs, lsb = 1 / 2 ** bits, top = 2 ** bits - 1;
  const z = gaussians(len, NOISE_SEED), clock = jitter ? gaussians(len, JITTER_SEED) : null;
  return Float64Array.from({ length: len }, (_, n) => {
    const sample = n * stride, c = sample % m, t = sample * T + mm.skew[c] + (clock?.[n] ?? 0) * jitter;
    const fundamental = mm.bandwidth === undefined ? { amplitude: 1, phase: 0 } : bandwidthResponse(mm.bandwidth[c], fin, analogBandwidth);
    let signal = AMP * fundamental.amplitude * Math.cos(2 * Math.PI * fin * t + fundamental.phase);
    for (const order of HARMONIC_ORDERS) {
      const dbc = harmonicLevel(harmonics, order);
      if (dbc <= -100) continue;
      const bw = mm.bandwidth === undefined ? { amplitude: 1, phase: 0 } : bandwidthResponse(mm.bandwidth[c], order * fin, analogBandwidth);
      signal += AMP * 10 ** (dbc / 20) * bw.amplitude * Math.cos(2 * Math.PI * order * fin * t + HARMONIC_PHASE[order] + bw.phase);
    }
    const v = mm.gain[c] * signal + mm.offset[c] + z[n] * thermalNoiseLsb * lsb;
    return Math.min(top, Math.max(0, Math.floor((v - -0.5) / lsb))) * lsb + -0.5;
  });
}

/**
 * exp_ti01's capture: sample n comes from sub-ADC n mod m, which samples its skew late and scales and shifts what it
 * sees. Then the selected input-referred thermal noise (0.3 LSB RMS by default) and the quantiser, which floors and
 * clips on ±0.5 V as apply_quantization_noise does.
 */
export function capture(fin: number, mm: Mismatch, bits: number, len = N, options: CaptureOptions = {}): Float64Array {
  return captureAtStride(fin, mm, bits, len, options, 1);
}

/** deinterleave: channel c holds samples c, c + m, c + 2m, … */
export const deinterleave = (x: Float64Array, m: number): Float64Array[] =>
  Array.from({ length: m }, (_, c) => x.filter((_, n) => n % m === c));

/** interleave: the inverse. */
export function interleave(channels: Float64Array[]): Float64Array {
  const m = channels.length, out = new Float64Array(m * channels[0].length);
  channels.forEach((ch, c) => ch.forEach((v, k) => (out[k * m + c] = v)));
  return out;
}

export interface Params {
  fin: number;
  /** the tone's amplitude, averaged over the channels */
  amp: number;
  gain: Float64Array;
  offset: Float64Array;
  skew: Float64Array;
}

const mean = (a: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
};

/** np.unwrap: a step between neighbours of π or more is taken as whole turns plus the rest, and the turns removed. */
export function unwrap(p: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(p), turn = 2 * Math.PI;
  let correction = 0;
  for (let i = 1; i < p.length; i++) {
    const dd = p[i] - p[i - 1];
    // np.mod keeps the sign of the divisor
    let rest = (dd - -Math.PI) % turn;
    if (rest < 0) rest += turn;
    let wrapped = rest + -Math.PI;
    if (wrapped === -Math.PI && dd > 0) wrapped = Math.PI;
    if (!(Math.abs(dd) < Math.PI)) correction += wrapped - dd;
    out[i] = p[i] + correction;
  }
  return out;
}

/**
 * extract_mismatch_sine: per-channel 3-parameter linear least squares [cos(wt), -sin(wt), 1] at sample times
 * (k·m + c)/fs. Exact for both coherent and non-coherent captures (no single-bin DFT leakage between DC and tone).
 */
export function extractMismatch(x: Float64Array, m: number, fs: number, fin: number): Params {
  const T = 1 / fs;
  const offset = new Float64Array(m), amps = new Float64Array(m), phases = new Float64Array(m);
  deinterleave(x, m).forEach((y, c) => {
    const K = y.length;
    const mat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rhs = [0, 0, 0];
    for (let k = 0; k < K; k++) {
      const th = 2 * Math.PI * fin * ((k * m + c) * T);
      const v = [Math.cos(th), -Math.sin(th), 1];
      for (let p = 0; p < 3; p++) {
        for (let q = p; q < 3; q++) mat[p][q] += v[p] * v[q];
        rhs[p] += v[p] * y[k];
      }
    }
    for (let p = 0; p < 3; p++) for (let q = 0; q < p; q++) mat[p][q] = mat[q][p];
    const [a, b, off] = solve(mat, rhs);
    offset[c] = off;
    amps[c] = Math.hypot(a, b);
    phases[c] = Math.atan2(b, a);
  });
  const amp = mean(amps), unwrapped = unwrap(phases), mid = mean(unwrapped);
  return {
    fin,
    amp,
    gain: amps.map((a) => (amp > 0 ? a / amp : 1)),
    offset,
    skew: unwrapped.map((p) => (p - mid) / (2 * Math.PI * fin)),
  };
}

export interface Spur {
  /** folded into 0 … fs/2 */
  freq: number;
  kind: 'offset' | 'image';
  k: number;
  amp: number;
  dbfs: number;
  dbc: number;
}

/** |X_k| of an m-point sequence. Bluestein's transform handles odd and other non-radix-2 channel counts. */
function dft(re: ArrayLike<number>, im: ArrayLike<number>): Float64Array {
  const r = Float64Array.from(re), i = Float64Array.from(im);
  fftAny(r, i);
  return r.map((v, k) => Math.hypot(v, i[k]));
}

/**
 * predict_spurs: an offset pattern puts a tone at k·fs/m, O its m-point DFT, for k = 1 … m/2. O_k and O_{m−k} are one
 * tone there, so it is 2|O_k|/m, except at fs/2, which is its own mirror and |O_k|/m. Gain and skew together, as the
 * complex gain α = gain·e^{j2π·fin·skew} less its mean, put images at fin + k·fs/m of A·|Â_k|/m. Sorted by frequency.
 */
export function predictSpurs(p: Params, fs: number, fullScale = 1): Spur[] {
  const m = p.gain.length;
  const re = p.gain.map((g, c) => g * Math.cos(2 * Math.PI * p.fin * p.skew[c]));
  const im = p.gain.map((g, c) => g * Math.sin(2 * Math.PI * p.fin * p.skew[c]));
  const reMean = mean(re), imMean = mean(im);
  const fund = 20 * Math.log10(Math.max((p.amp * Math.hypot(reMean, imMean)) / fullScale, 1e-300));
  const db = (amp: number, isNyquistReal = false) => {
    if (amp <= 0) return { dbfs: -Infinity, dbc: -Infinity };
    const equiv = isNyquistReal ? amp * Math.SQRT2 : amp;
    const dbfs = 20 * Math.log10(equiv / fullScale);
    return { dbfs, dbc: dbfs - fund };
  };
  const spurs: Spur[] = [];
  const O = dft(p.offset, new Float64Array(m));
  for (let k = 1; k <= m / 2; k++) {
    const isNyq = 2 * k === m;
    const amp = (O[k] / m) * (isNyq ? 1 : 2);
    spurs.push({ freq: foldFrequency((k * fs) / m, fs), kind: 'offset', k, amp, ...db(amp, isNyq) });
  }
  const G = dft(re.map((v) => v - reMean), im.map((v) => v - imMean));
  for (let k = 1; k < m; k++) {
    const amp = (p.amp * G[k]) / m;
    spurs.push({ freq: foldFrequency(p.fin + (k * fs) / m, fs), kind: 'image', k, amp, ...db(amp) });
  }
  // a stable sort, as Python's
  return spurs.map((s, i) => ({ s, i })).sort((a, b) => a.s.freq - b.s.freq || a.i - b.i).map(({ s }) => s);
}

/**
 * fractional_delay_fft: rotate every rfft bin by its own frequency times the delay and transform back; the Nyquist
 * bin keeps only its real part, as irfft reads it.
 */
export function delayFft(x: Float64Array, delay: number, fs: number): Float64Array {
  const n = x.length, half = Math.floor(n / 2);
  const re = Float64Array.from(x), im = new Float64Array(n);
  fftAny(re, im);
  const step = 1 / (n * (1 / fs));
  // the full spectrum irfft rebuilds: the rotated rfft bins, and their conjugates above them
  const yr = new Float64Array(n), yi = new Float64Array(n);
  for (let k = 0; k <= half; k++) {
    const th = -2 * Math.PI * (k * step) * delay, c = Math.cos(th), s = Math.sin(th);
    yr[k] = re[k] * c - im[k] * s;
    yi[k] = re[k] * s + im[k] * c;
  }
  if (n % 2 === 0) yi[half] = 0;
  for (let k = 1; k < n - half; k++) {
    yr[n - k] = yr[k];
    yi[n - k] = -yi[k];
  }
  // the inverse transform is the forward one read backwards, divided by n
  fftAny(yr, yi);
  return Float64Array.from({ length: n }, (_, j) => yr[(n - j) % n] / n);
}

/** np.round: halves go to the even neighbour. */
function roundEven(v: number): number {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** The Lagrange interpolator fractional_delay_farrow convolves with: n taps, evaluated at p = n//2 + frac. */
export function lagrangeTaps(frac: number, taps: number): Float64Array {
  const p = Math.floor(taps / 2) + frac, h = new Float64Array(taps).fill(1);
  for (let i = 0; i < taps; i++) for (let j = 0; j < taps; j++) if (j !== i) h[i] *= (p - j) / (i - j);
  return h;
}

/**
 * fractional_delay_farrow: convolve with the centered Lagrange taps BEFORE shifting by the integer part so boundary
 * samples stay continuous across half-integer delays.
 */
export function delayFarrow(x: Float64Array, delay: number, fs: number, taps = TAPS): Float64Array {
  const n = x.length, d = delay * fs, whole = roundEven(d), P = Math.floor(taps / 2);
  const h = lagrangeTaps(d - whole, taps);
  const fullLen = n + taps - 1;
  const full = new Float64Array(fullLen);
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    for (let k = 0; k < taps; k++) full[i + k] += xi * h[k];
  }
  const out = new Float64Array(n);
  const nStart = Math.max(0, whole - P);
  const nEnd = Math.min(n, fullLen + whole - P);
  for (let i = nStart; i < nEnd; i++) out[i] = full[i - whole + P];
  return out;
}

const FARROW_SKEW_PASSES = 3;
const SKEW_RESIDUAL_TOLERANCE = 1e-14;

/** Solve A z = b for a small M × M complex linear system using partial-pivoting Gaussian elimination. */
function solveComplex(ar: Float64Array[], ai: Float64Array[], br: Float64Array, bi: Float64Array): [Float64Array, Float64Array] {
  const m = br.length;
  const mr = ar.map((row) => Float64Array.from(row));
  const mi = ai.map((row) => Float64Array.from(row));
  const xr = Float64Array.from(br);
  const xi = Float64Array.from(bi);
  for (let col = 0; col < m; col++) {
    let pivot = col, best = mr[col][col] ** 2 + mi[col][col] ** 2;
    for (let row = col + 1; row < m; row++) {
      const mag2 = mr[row][col] ** 2 + mi[row][col] ** 2;
      if (mag2 > best) {
        best = mag2;
        pivot = row;
      }
    }
    if (pivot !== col) {
      [mr[col], mr[pivot]] = [mr[pivot], mr[col]];
      [mi[col], mi[pivot]] = [mi[pivot], mi[col]];
      [xr[col], xr[pivot]] = [xr[pivot], xr[col]];
      [xi[col], xi[pivot]] = [xi[pivot], xi[col]];
    }
    const pr = mr[col][col], pi = mi[col][col], denom = pr * pr + pi * pi;
    if (denom === 0) continue;
    for (let row = col + 1; row < m; row++) {
      const nr = mr[row][col], ni = mi[row][col];
      const fr = (nr * pr + ni * pi) / denom;
      const fi = (ni * pr - nr * pi) / denom;
      for (let j = col; j < m; j++) {
        mr[row][j] -= fr * mr[col][j] - fi * mi[col][j];
        mi[row][j] -= fr * mi[col][j] + fi * mr[col][j];
      }
      xr[row] -= fr * xr[col] - fi * xi[col];
      xi[row] -= fr * xi[col] + fi * xr[col];
    }
  }
  const zr = new Float64Array(m), zi = new Float64Array(m);
  for (let row = m - 1; row >= 0; row--) {
    let sr = xr[row], si = xi[row];
    for (let j = row + 1; j < m; j++) {
      sr -= mr[row][j] * zr[j] - mi[row][j] * zi[j];
      si -= mr[row][j] * zi[j] + mi[row][j] * zr[j];
    }
    const pr = mr[row][row], pi = mi[row][row], denom = pr * pr + pi * pi;
    if (denom === 0) continue;
    zr[row] = (sr * pr + si * pi) / denom;
    zi[row] = (si * pr - sr * pi) / denom;
  }
  return [zr, zi];
}

/**
 * calibrate_foreground: offset out first, then gain, then skew inverted on the interleaved full-rate stream.
 * For `fft`, solve the K independent M × M frequency-domain coupling blocks directly (exact at arbitrary skew).
 * For `farrow`, run fixed-point iteration z <- z + (y - A z) with a monotonic residual guard.
 */
export function calibrate(x: Float64Array, m: number, p: Params, fs: number, method: Exclude<Method, 'off'>, taps = TAPS): Float64Array {
  const channels = deinterleave(x, m).map((ch, c) => ch.map((v) => (v - p.offset[c]) / p.gain[c]));
  const corrected = interleave(channels);
  const active: number[] = [];
  for (let c = 0; c < m; c++) if (Math.abs(p.skew[c]) >= 1e-18) active.push(c);
  if (!active.length || p.fin > fs / 2) return corrected;

  const n = corrected.length;
  if (method === 'fft') {
    const K = n / m;
    const yr = Float64Array.from(corrected), yi = new Float64Array(n);
    fftAny(yr, yi);
    // Precompute W[p][q][c] = exp(-j 2 pi (p - q) c / m) / m
    const wr: Float64Array[][] = Array.from({ length: m }, (_, pIdx) =>
      Array.from({ length: m }, (_, qIdx) => Float64Array.from({ length: m }, (_, c) => Math.cos((-2 * Math.PI * (pIdx - qIdx) * c) / m) / m)),
    );
    const wi: Float64Array[][] = Array.from({ length: m }, (_, pIdx) =>
      Array.from({ length: m }, (_, qIdx) => Float64Array.from({ length: m }, (_, c) => Math.sin((-2 * Math.PI * (pIdx - qIdx) * c) / m) / m)),
    );
    const zrFull = new Float64Array(n), ziFull = new Float64Array(n);
    const hr = Array.from({ length: m }, () => new Float64Array(m));
    const hi = Array.from({ length: m }, () => new Float64Array(m));
    const rhsR = new Float64Array(m), rhsI = new Float64Array(m);
    const phiR = Array.from({ length: m }, () => new Float64Array(m));
    const phiI = Array.from({ length: m }, () => new Float64Array(m));
    const nyqIdx = n % 2 === 0 ? n / 2 : -1;

    for (let r = 0; r < K; r++) {
      for (let q = 0; q < m; q++) {
        const idx = q * K + r;
        rhsR[q] = yr[idx];
        rhsI[q] = yi[idx];
        const freq = (idx <= Math.floor((n - 1) / 2) ? idx : idx - n) * (fs / n);
        for (let c = 0; c < m; c++) {
          if (idx === nyqIdx) {
            phiR[q][c] = Math.cos(Math.PI * fs * p.skew[c]);
            phiI[q][c] = 0;
          } else {
            const th = 2 * Math.PI * p.skew[c] * freq;
            phiR[q][c] = Math.cos(th);
            phiI[q][c] = Math.sin(th);
          }
        }
      }
      for (let pIdx = 0; pIdx < m; pIdx++) {
        for (let qIdx = 0; qIdx < m; qIdx++) {
          let sr = 0, si = 0;
          const wrpq = wr[pIdx][qIdx], wipq = wi[pIdx][qIdx], pr = phiR[qIdx], pi = phiI[qIdx];
          for (let c = 0; c < m; c++) {
            sr += wrpq[c] * pr[c] - wipq[c] * pi[c];
            si += wrpq[c] * pi[c] + wipq[c] * pr[c];
          }
          hr[pIdx][qIdx] = sr;
          hi[pIdx][qIdx] = si;
        }
      }
      const [zbR, zbI] = solveComplex(hr, hi, rhsR, rhsI);
      for (let q = 0; q < m; q++) {
        const idx = q * K + r;
        zrFull[idx] = zbR[q];
        ziFull[idx] = zbI[q];
      }
    }
    // Inverse FFT: forward FFT read backwards divided by n
    fftAny(zrFull, ziFull);
    return Float64Array.from({ length: n }, (_, j) => zrFull[(n - j) % n] / n);
  }

  const resample = (stream: Float64Array) => {
    const skewed = stream.slice();
    for (const c of active) {
      const shifted = delayFarrow(stream, -p.skew[c], fs, taps);
      for (let i = c; i < n; i += m) skewed[i] = shifted[i];
    }
    return skewed;
  };
  let estimate = corrected.slice(), bestEstimate = corrected.slice();
  let scale = 0, bestResNorm = Infinity;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(corrected[i]));

  for (let pass = 0; pass < FARROW_SKEW_PASSES; pass++) {
    const skewed = resample(estimate);
    let maxRes = 0;
    const residual = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      residual[i] = corrected[i] - skewed[i];
      maxRes = Math.max(maxRes, Math.abs(residual[i]));
    }
    if (maxRes < bestResNorm) {
      bestResNorm = maxRes;
      bestEstimate = estimate.slice();
    } else {
      return bestEstimate;
    }
    for (let i = 0; i < n; i++) estimate[i] += residual[i];
    if (maxRes <= SKEW_RESIDUAL_TOLERANCE * scale) break;
  }
  const finalSkewed = resample(estimate);
  let finalRes = 0;
  for (let i = 0; i < n; i++) finalRes = Math.max(finalRes, Math.abs(corrected[i] - finalSkewed[i]));
  return finalRes <= bestResNorm ? estimate : bestEstimate;
}

/** analyze_spectrum on the ±0.5 V range: codes of the same resolution scale it to the full scale the port expects. */
export const spectrumOf = (x: Float64Array, bits: number): Spectrum => analyzeSpectrum(x.map((v) => v * 2 ** bits), bits);

/** A finite, noncoherent output record needs a window for display and a sine fit for total residual power. */
export function outputSpectrum(x: Float64Array, bits: number, frequency: number, coherent: boolean): Spectrum {
  if (coherent) return spectrumOf(x, bits);
  const codes = x.map((v) => v * 2 ** bits);
  const fit = fitSine(codes, frequency * x.length);
  const spectrum = analyzeSpectrum(codes, bits, 'blackmanharris', 4);
  // Remove the carrier before measuring a spur: its window skirt must not be counted as ADC distortion.
  const residual = analyzeSpectrum(fit.error, bits, 'blackmanharris', 4);
  let spurPower = 0;
  for (let k = Math.max(1, residual.signal - 4); k <= Math.min(residual.inband - 1, residual.signal + 4); k++) {
    spurPower += 10 ** (residual.dbfs[k] / 10);
  }
  const signalPower = (fit.amplitude / 2 ** (bits - 1)) ** 2;
  const sndr = 20 * Math.log10(fit.amplitude / (Math.SQRT2 * fit.rmse));
  return { ...spectrum, sndr, enob: (sndr - 1.76) / 6.02, sfdr: 10 * Math.log10(signalPower / spurPower), spur: residual.signal };
}

/** Direct decimation used by the lesson: no anti-alias filter, so tones fold into the reduced output band. */
export function decimate(x: Float64Array, factor: number): Float64Array {
  if (!Number.isInteger(factor) || factor < 1 || factor > MAX_DECIMATION) throw new Error(`invalid decimation factor ${factor}`);
  return Float64Array.from({ length: Math.ceil(x.length / factor) }, (_, i) => x[i * factor]);
}

/** The largest spur predict_spurs expects, as an SFDR. */
export const predictedSfdr = (spurs: Spur[]): number => -Math.max(...spurs.map((s) => s.dbc));

/** The sub-ADCs' own Nyquist frequency, fs / (2M). */
export const channelNyquist = (m: number): number => FS / (2 * m);

/** The fundamental-frequency gain and phase that the physical channel front ends present to predict_spurs. */
export function physicalParams(mm: Mismatch, fin: number, fs: number, analogBandwidth = fs / 2): Params {
  const m = mm.gain.length, gain = new Float64Array(m), skew = new Float64Array(m);
  for (let c = 0; c < m; c++) {
    const bw = mm.bandwidth === undefined ? { amplitude: 1, phase: 0 } : bandwidthResponse(mm.bandwidth[c], fin, analogBandwidth);
    gain[c] = mm.gain[c] * bw.amplitude;
    skew[c] = mm.skew[c] + bw.phase / (2 * Math.PI * fin);
  }
  return { fin, amp: AMP, gain, offset: mm.offset, skew };
}

export interface Contribution {
  id: 'offset' | 'gain' | 'skew' | 'bandwidth' | 'harmonics';
  label: string;
  formula?: 'offset' | 'image' | 'harmonic';
  /** Strongest result in dBc. Negative infinity means that source is off. */
  level: number;
  frequencies: number[];
  /** Optional text attached to each frequency marker, in the same order. */
  toneLabels?: string[];
}

export interface HarmonicTone {
  order: HarmonicOrder;
  freq: number;
  dbc: number;
}

const zeroes = (m: number) => new Float64Array(m);
const ones = (m: number) => new Float64Array(m).fill(1);
const strongest = (spurs: Spur[]): number => Math.max(...spurs.map((s) => s.dbc));

/** Downsampling visits c = 0, D, 2D, … modulo M. Combine channel phasors BEFORE taking magnitudes. */
export function outputSpurs(p: Params, fs: number, factor = 1): Spur[] {
  const channels: number[] = [];
  for (let c = 0; !channels.includes(c); c = (c + factor) % p.gain.length) channels.push(c);
  const take = (x: Float64Array) => Float64Array.from(channels, (c) => x[c]);
  const sampled = { ...p, gain: take(p.gain), offset: take(p.offset), skew: take(p.skew) };
  const fsOut = fs / factor;
  // predictSpurs already applies |mean(alpha)| for carrier reference and sqrt(2) for real Nyquist offset tones.
  return predictSpurs(sampled, fsOut, 0.5).filter((s) => s.amp > 1e-14);
}

/** Active source harmonics, folded into the output Nyquist band. */
export function harmonicTones(fin: number, harmonics: Partial<HarmonicLevels>, outputFs: number): HarmonicTone[] {
  return HARMONIC_ORDERS.flatMap((order) => {
    const dbc = harmonicLevel(harmonics, order);
    return dbc > -100 ? [{ order, freq: foldFrequency(order * fin, outputFs), dbc }] : [];
  });
}

/** A source-by-source map of deterministic errors that produce discrete spectral lines. */
export function contributions(
  mm: Mismatch,
  fin: number,
  converterFs: number,
  harmonics: Partial<HarmonicLevels>,
  outputFs = converterFs,
  analogBandwidth = converterFs / 2,
): Contribution[] {
  const m = mm.gain.length;
  const factor = Math.round(converterFs / outputFs);
  const images = (gain: Float64Array, skew: Float64Array) =>
    outputSpurs({ fin, amp: AMP, gain, offset: zeroes(m), skew }, converterFs, factor).filter((s) => s.kind === 'image');
  const offset = outputSpurs({ fin, amp: AMP, gain: ones(m), offset: mm.offset, skew: zeroes(m) }, converterFs, factor).filter((s) => s.kind === 'offset');
  const gain = images(mm.gain, zeroes(m));
  const skew = images(ones(m), mm.skew);
  const bwGain = new Float64Array(m), bwSkew = new Float64Array(m);
  for (let c = 0; c < m; c++) {
    const bw = bandwidthResponse(mm.bandwidth?.[c] ?? 0, fin, analogBandwidth);
    bwGain[c] = bw.amplitude;
    bwSkew[c] = bw.phase / (2 * Math.PI * fin);
  }
  const bandwidth = images(bwGain, bwSkew);
  const tones = harmonicTones(fin, harmonics, outputFs);
  const folded = (spurs: Spur[]) => spurs.map((s) => foldFrequency(s.freq, outputFs));
  return [
    { id: 'offset', label: 'Offset', formula: 'offset', level: strongest(offset), frequencies: folded(offset) },
    { id: 'gain', label: 'Gain', formula: 'image', level: strongest(gain), frequencies: folded(gain) },
    { id: 'skew', label: 'Timing skew', formula: 'image', level: strongest(skew), frequencies: folded(skew) },
    { id: 'bandwidth', label: 'Bandwidth', formula: 'image', level: strongest(bandwidth), frequencies: folded(bandwidth) },
    {
      id: 'harmonics', label: 'Harmonics', formula: 'harmonic', level: tones.length ? Math.max(...tones.map((tone) => tone.dbc)) : -Infinity,
      frequencies: tones.map((tone) => tone.freq), toneLabels: tones.map((tone) => `H${tone.order}`),
    },
  ];
}

export interface Reading {
  fin: number;
  bin: number;
  truth: Mismatch;
  /** what extract_mismatch_sine reads from the capture, and what predict_spurs makes of it */
  measured: Params;
  spurs: Spur[];
  harmonics: HarmonicTone[];
  /** Sample rate and channel-period-coherent analysis-record length after direct decimation. */
  fsOut: number;
  fftPoints: number;
  coherent: boolean;
  /** Windowed spur estimates need room to separate the carrier from DC and Nyquist. */
  metricsResolved: boolean;
  raw: Spectrum;
  /** the calibrated capture, or the raw one again when calibration is off */
  out: Spectrum;
  /** what extract_mismatch_sine still reads after calibration */
  left: Params | null;
  rawData: Float64Array;
  outData: Float64Array;
}

export function read(m: number, target: number, mm: Mismatch, bits: number, method: Method, options: CaptureOptions = {}): Reading {
  const fs = options.fs ?? FS, decimation = options.decimation ?? 1;
  if (!Number.isInteger(decimation) || decimation < 1 || decimation > MAX_DECIMATION) throw new Error(`unsupported decimation factor ${decimation}`);
  const fsOut = fs / decimation;
  const points = analysisPoints(m);
  const { fin, bin } = coherentFrequency(fs, target, points);
  const x = capture(fin, mm, bits, points, options);
  const measured = extractMismatch(x, m, fs, fin);
  const calibrationMethod = method === 'off' ? null : method;
  const y = calibrationMethod ? calibrate(x, m, measured, fs, calibrationMethod) : null;
  // Keep a full analysis record at every output rate. Generating only the retained samples is exactly the
  // memoryless ADC operation, and avoids constructing as many as 255 · N samples while the control is dragged.
  const rawRecord = decimation === 1 ? x : captureAtStride(fin, mm, bits, points, options, decimation);
  let outRecord = rawRecord;
  if (y && calibrationMethod) {
    if (decimation === 1) outRecord = y;
    else {
      // Calibration precedes downsampling. This slower branch is not used by the public lesson, which has no
      // calibration control, but keeps the model's programmatic combination physically ordered.
      const long = capture(fin, mm, bits, points * decimation, options);
      outRecord = decimate(calibrate(long, m, measured, fs, calibrationMethod), decimation);
    }
  }
  const coherent = true;
  const frequency = foldFrequency(fin, fsOut) / fsOut;
  const raw = outputSpectrum(rawRecord, bits, frequency, coherent);
  const spurs = outputSpurs(physicalParams(mm, fin, fs, options.analogBandwidth ?? fs / 2), fs, decimation);
  return {
    fin,
    bin,
    truth: mm,
    measured,
    spurs,
    harmonics: harmonicTones(fin, options.harmonics ?? {}, fsOut),
    fsOut,
    fftPoints: points,
    coherent,
    metricsResolved: true,
    raw,
    out: y ? outputSpectrum(outRecord, bits, frequency, coherent) : raw,
    left: y ? extractMismatch(y, m, fs, fin) : null,
    rawData: x,
    outData: y ?? x,
  };
}

/** RMS error against the ideal uniformly sampled input, over the requested leading samples or the whole record. */
export function residualRms(data: Float64Array, fin: number, count = data.length, fs = FS, harmonics: Partial<HarmonicLevels> = {}): number {
  let power = 0;
  const n = Math.min(count, data.length);
  for (let i = 0; i < n; i++) power += (data[i] - inputValue(i / fs, fin, harmonics)) ** 2;
  return Math.sqrt(power / n);
}

/** Where the sweep puts its tones: the middle of 40 equal steps from 0 to fs/2, each moved to its coherent bin. */
export const SWEEP = Array.from({ length: 40 }, (_, i) => coherentFrequency(FS, ((i + 0.5) * FS) / 80, N).fin);

export interface Sweep {
  fin: number[];
  /** SFDR in dB, measured on the raw capture, predicted from it, and measured after each calibration */
  off: number[];
  predicted: number[];
  fft: number[];
  farrow: number[];
}

/** The same capture, extraction and calibrations at every frequency of SWEEP. */
export function sweep(m: number, mm: Mismatch, bits: number): Sweep {
  const out: Sweep = { fin: SWEEP, off: [], predicted: [], fft: [], farrow: [] };
  for (const fin of SWEEP) {
    const x = capture(fin, mm, bits);
    const p = extractMismatch(x, m, FS, fin);
    out.off.push(spectrumOf(x, bits).sfdr);
    out.predicted.push(predictedSfdr(predictSpurs(p, FS, 0.5)));
    out.fft.push(spectrumOf(calibrate(x, m, p, FS, 'fft'), bits).sfdr);
    out.farrow.push(spectrumOf(calibrate(x, m, p, FS, 'farrow'), bits).sfdr);
  }
  return out;
}
