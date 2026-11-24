/**
 * Reading an ADC's error: fit an ideal sine to the output, subtract it, and look at what is left four different ways.
 * Ported from ADCToolbox 0.9.1 (github.com/Arcadia-1/ADCToolbox):
 *   fundamentals/fit_sine_4param   least squares for A cos + B sin + C at a known frequency
 *   aout/rearrange_error_by_value  residual binned by signal value, mean and rms per bin
 *   aout/rearrange_error_by_phase  residual binned by phase, with the AM / PM / noise split
 *   aout/analyze_error_pdf         distribution of the residual
 *   aout/analyze_error_spectrum    spectrum of the residual
 *   siggen/nonidealities           apply_thermal_noise, apply_static_nonlinearity, apply_jitter,
 *                                  apply_memory_effect, apply_am_tone, apply_quantization_noise
 * python/adc_error_views.py calls ADCToolbox on the same waveform; tests/errors-model.test.ts compares the two.
 *
 * Units are LSB: full scale is 2^N and the sine sits at mid-scale.
 */
import { solve } from '../../lib/numeric';
import { gaussians } from '../../lib/rng';
import { analyzeSpectrum, N_FFT, type Spectrum } from '../../lib/spectrum';

/** Sampling rate of the modelled converter, so jitter carries familiar units. */
export const FS = 100e6;
export const TEST_BIN = 613;
const AMP_DBFS = -1;

export interface Impairments {
  /** rms thermal noise, LSB */
  noise: number;
  /** second-order term of the static curve, as a fraction of full swing */
  k2: number;
  /** third-order term */
  k3: number;
  /** rms sampling-clock jitter, seconds */
  jitter: number;
  /** fraction of the previous coarse sample that leaks into this one */
  memory: number;
  /** depth of an amplitude-modulating tone, and its bin */
  amDepth: number;
  amBin: number;
}

export const QUIET: Impairments = { noise: 0, k2: 0, k3: 0, jitter: 0, memory: 0, amDepth: 0, amBin: 41 };

/**
 * One capture of a coherent sine through the impairments, in the order ADCToolbox's signal generator applies them:
 * the static curve bends the input, the sampler carries jitter and memory of the last sample, an interfering tone
 * modulates it, thermal noise adds, and the quantiser rounds to the nearest code.
 */
export function capture(n: number, bin: number, imp: Impairments, seed: number): Float64Array {
  const codes = 2 ** n, mid = codes / 2, amp = mid * 10 ** (AMP_DBFS / 20);
  const zJitter = gaussians(N_FFT, seed), zNoise = gaussians(N_FFT, seed + 1);
  const out = new Float64Array(N_FFT);
  let prevMsb = 0;
  for (let i = 0; i < N_FFT; i++) {
    const t = i + (imp.jitter ? zJitter[i] * imp.jitter * FS : 0);
    const u = Math.sin((2 * Math.PI * bin * t) / N_FFT);
    // apply_static_nonlinearity, with the swing normalised so k2 and k3 read as fractions of full scale
    let ac = amp * (u + imp.k2 * u * u + imp.k3 * u * u * u);
    // apply_am_tone
    if (imp.amDepth) ac *= 1 + imp.amDepth * Math.sin((2 * Math.PI * imp.amBin * i) / N_FFT);
    let x = mid + ac;
    // apply_memory_effect: the previous coarse decision leaks back into this sample
    if (imp.memory) {
      const msb = Math.floor((x / codes) * 16) / 16;
      x = codes * (msb + Math.floor((x / codes - msb) * 4096) / 4096 + imp.memory * prevMsb);
      prevMsb = msb;
    }
    // apply_thermal_noise, then the converter itself
    out[i] = Math.round(x + (imp.noise ? zNoise[i] * imp.noise : 0));
  }
  return out;
}

export interface Fit {
  fitted: Float64Array;
  error: Float64Array;
  amplitude: number;
  dc: number;
  /** phase of the fitted A cos(wt) + B sin(wt), as ADCToolbox reports it */
  phase: number;
  rmse: number;
  /** where the fit ended up, in cycles per sample: a refinement step moves it off the bin it started on */
  frequency: number;
}

function solveThreeParam(y: Float64Array, freq: number): { a: number; b: number; dc: number; fitted: Float64Array; sse: number } {
  const n = y.length, w = 2 * Math.PI * freq;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = Math.cos(w * i), s = Math.sin(w * i);
    const v = [c, s, 1];
    for (let p = 0; p < 3; p++) {
      for (let q = p; q < 3; q++) m[p][q] += v[p] * v[q];
      r[p] += v[p] * y[i];
    }
  }
  for (let p = 0; p < 3; p++) for (let q = 0; q < p; q++) m[p][q] = m[q][p];
  const [a, b, dc] = solve(m, r);
  const fitted = new Float64Array(n);
  let sse = 0;
  for (let i = 0; i < n; i++) {
    fitted[i] = a * Math.cos(w * i) + b * Math.sin(w * i) + dc;
    const e = y[i] - fitted[i];
    sse += e * e;
  }
  return { a, b, dc, fitted, sse };
}

/**
 * fit_sine_4param (ADCToolbox PR #130): least squares for A cos(wt) + B sin(wt) + C, a 3 × 3 normal system at the
 * frequency it is given. With `iterations` above 0 it refines the frequency until convergence, then re-solves A, B, C
 * at the returned frequency and falls back to the initial estimate if refinement leaves (0, 0.5) or worsens the fit.
 */
export function fitSine(y: Float64Array, bin: number, iterations = 0, tolerance = 1e-9): Fit {
  const n = y.length;
  // a bin of this record: fractional bins are allowed, which is how a caller passes a frequency it already knows
  const initialFreq = bin / n;
  const initial = solveThreeParam(y, initialFreq);
  let freq = initialFreq, { a, b, dc, fitted, sse } = initial;
  let nIter = 0, leftValidRange = false;

  for (let it = 1; it <= iterations; it++) {
    const w = 2 * Math.PI * freq;
    // normalize the refinement column by n * hypot(a, b) so the normal system stays conditioned at large A * n^2
    const colScale = Math.max(n * Math.hypot(a, b), 1);
    const m = Array.from({ length: 4 }, () => [0, 0, 0, 0]), r = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const c = Math.cos(w * i), s = Math.sin(w * i);
      const v = [c, s, 1, (i / colScale) * (-a * s + b * c)];
      for (let p = 0; p < 4; p++) {
        for (let q = p; q < 4; q++) m[p][q] += v[p] * v[q];
        r[p] += v[p] * y[i];
      }
    }
    for (let p = 0; p < 4; p++) for (let q = 0; q < p; q++) m[p][q] = m[q][p];
    const coeffs = solve(m, r);
    [a, b, dc] = coeffs;
    const delta = coeffs[3] / colScale / (2 * Math.PI);
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
    const refined = solveThreeParam(y, freq);
    let energy = 0;
    for (let i = 0; i < n; i++) energy += y[i] * y[i];
    if (refined.sse - initial.sse > 1e-18 * energy) reverted = true;
    else ({ a, b, dc, fitted, sse } = refined);
  }
  if (reverted) {
    freq = initialFreq;
    ({ a, b, dc, fitted, sse } = initial);
  }

  const error = Float64Array.from(y, (v, i) => v - fitted[i]);
  return { fitted, error, amplitude: Math.hypot(a, b), dc, phase: Math.atan2(-b, a), rmse: Math.sqrt(sse / n), frequency: freq };
}

export interface Bins {
  centers: Float64Array;
  mean: Float64Array;
  rms: Float64Array;
  counts: Float64Array;
}

function bin(index: (i: number) => number, error: Float64Array, centers: Float64Array): Bins {
  const k = centers.length;
  const counts = new Float64Array(k), sum = new Float64Array(k), sq = new Float64Array(k);
  const idx = new Int32Array(error.length);
  for (let i = 0; i < error.length; i++) {
    const b = index(i);
    idx[i] = b;
    if (b < 0 || b >= k) continue;
    counts[b]++;
    sum[b] += error[i];
  }
  const mean = sum.map((v, b) => (counts[b] ? v / counts[b] : NaN));
  // RMS around each bin's deterministic mean (separates random noise from static/harmonic curvature)
  for (let i = 0; i < error.length; i++) {
    const b = idx[i];
    if (b < 0 || b >= k) continue;
    const d = error[i] - mean[b];
    sq[b] += d * d;
  }
  return {
    centers,
    counts,
    mean,
    rms: sq.map((v, b) => (counts[b] ? Math.sqrt(v / counts[b]) : NaN)),
  };
}

/** rearrange_error_by_value: the residual binned by the value the converter was looking at. */
export function byValue(y: Float64Array, error: Float64Array, k = 96): Bins {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < y.length; i++) {
    lo = Math.min(lo, y[i]);
    hi = Math.max(hi, y[i]);
  }
  const scale = (k - 1) / (hi - lo);
  return bin((i) => Math.round((y[i] - lo) * scale), error, Float64Array.from({ length: k }, (_, b) => lo + b / scale));
}

export interface Phase extends Bins {
  /** rms of the part of the error that rides on the signal, on its slope, and on neither */
  am: number;
  pm: number;
  base: number;
}

/**
 * rearrange_error_by_phase, with ADCToolbox's AM / PM split. An error proportional to the signal has power ∝ cos²φ and
 * one proportional to its slope ∝ sin²φ, so fitting e² to a constant plus cos 2φ separates them from plain noise.
 */
export function byPhase(error: Float64Array, bin_: number, phase: number, k = 96, recordLength = N_FFT): Phase {
  const w = (2 * Math.PI * bin_) / recordLength;
  const phi = (i: number) => {
    const p = (w * i + phase) % (2 * Math.PI);
    return p < 0 ? p + 2 * Math.PI : p;
  };
  const centers = Float64Array.from({ length: k }, (_, b) => ((b + 0.5) * 2 * Math.PI) / k);
  const binOf = (i: number) => Math.min(k - 1, Math.max(0, Math.floor((phi(i) / (2 * Math.PI)) * k)));
  const out = bin(binOf, error, centers);
  let cc = 0, c1 = 0, ec = 0, e1 = 0;
  for (let i = 0; i < error.length; i++) {
    const b = binOf(i);
    const mean = Number.isFinite(out.mean[b]) ? out.mean[b] : 0;
    const rand = error[i] - mean;
    const c = Math.cos(2 * phi(i)), e = rand * rand;
    cc += c * c;
    c1 += c;
    ec += e * c;
    e1 += e;
  }
  const nn = error.length;
  const A = (nn * ec - c1 * e1) / (nn * cc - c1 * c1), B = (e1 - A * c1) / nn;
  const amVar = Math.max(0, 2 * A), pmVar = Math.max(0, -2 * A);
  return { ...out, am: Math.sqrt(amVar), pm: Math.sqrt(pmVar), base: Math.sqrt(Math.max(0, B - (amVar + pmVar) / 2)) };
}

/** analyze_error_pdf: how often the residual takes each value, over a symmetric range of `span` LSB. */
export function pdf(error: Float64Array, span: number, k = 81): Bins {
  const centers = Float64Array.from({ length: k }, (_, b) => -span + (2 * span * (b + 0.5)) / k);
  const counts = new Float64Array(k);
  for (let i = 0; i < error.length; i++) {
    const b = Math.floor(((error[i] + span) / (2 * span)) * k);
    if (b >= 0 && b < k) counts[b]++;
  }
  return { centers, counts, mean: counts, rms: counts };
}

/** analyze_error_spectrum: the same spectrum tool, run on the residual instead of the output. */
export const errorSpectrum = (error: Float64Array, n: number): Spectrum => analyzeSpectrum(error, n);
export const outputSpectrum = (y: Float64Array, n: number): Spectrum => analyzeSpectrum(y, n);
