/**
 * Reading the bits: what a SAR converter's raw output says before anything is reconstructed. How often each bit is 1,
 * where the part of the code from each bit down sits between its limits, the weights a sine fit finds and the ratios
 * between them, and how many effective bits each bit adds.
 * Ported from ADCToolbox 0.9.1 (github.com/Arcadia-1/ADCToolbox):
 *   dout/          analyze_bit_activity, analyze_overflow, analyze_weight_radix, analyze_enob_sweep
 *   calibration/   calibrate_weight_sine at a known frequency, through src/lib/calibration.ts
 *   spectrum/      analyze_spectrum with a Hamming window and automatic side bins, through src/lib/spectrum.ts
 * following its examples exp_d11, exp_d12, exp_d13 and exp_d14, whose SAR loop this repeats.
 * python/adc_reading_the_bits.py calls ADCToolbox on the same bits; tests/bits-model.test.ts compares the two.
 *
 * The converter's range is ±1, as in those examples: the input is 2·amplitude·sin + offset.
 */
import { calibrateWeightSine } from '../../lib/calibration';
import { coherentFrequency } from '../../lib/frequency';
import { npSum, roundEven } from '../../lib/numeric';
import { gaussians, uniforms } from '../../lib/rng';
import { analyzeSpectrum, type Spectrum } from '../../lib/spectrum';

export const N = 8192;
export const FS = 1e9;
export const TONE = coherentFrequency(FS, 300e6, N);

/** The capacitor arrays of the examples, MSB first: exp_d11's binary one, exp_d14's with a repeated bit, exp_d13's sub-radix one. */
export const ARRAYS = {
  binary: [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 1],
  redundant: [1024, 512, 256, 256, 128, 64, 32, 16, 8, 4, 2, 1, 1],
  subradix: [1156, 642, 357, 198, 110, 61, 34, 18, 10, 5, 3, 2, 1, 1],
};
export type ArrayName = keyof typeof ARRAYS;
/** exp_d11's poor contact, which reads the second-last bit as 0 in one sample in ten, or exp_d12's LSB that is a coin toss */
export type Fault = 'none' | 'contact' | 'lsb';

const NOISE = gaussians(N, 11);
const FAULT = uniforms(N, 12);

/**
 * The examples' SAR loop, one row of bits per sample, MSB first: a bit is 1 if what is left of the input is above
 * zero, and then that capacitor's share of the full scale is taken off or put back. The last decision changes nothing.
 */
export function capture(caps: number[], amp: number, dc: number, noise: number, fault: Fault): Uint8Array {
  const m = caps.length, total = npSum(caps);
  const steps = caps.map((c) => c / total);
  const bits = new Uint8Array(N * m);
  for (let i = 0; i < N; i++) {
    let residue = 2 * amp * Math.sin(2 * Math.PI * TONE.fin * (i / FS)) + dc + NOISE[i] * noise;
    for (let j = 0; j < m; j++) {
      const bit = residue > 0 ? 1 : 0;
      bits[i * m + j] = bit;
      if (j < m - 1) residue -= (2 * bit - 1) * steps[j];
    }
    if (fault === 'contact' && FAULT[i] < 0.1) bits[i * m + m - 2] = 0;
    if (fault === 'lsb') bits[i * m + m - 1] = Math.floor(FAULT[i] * 2);
  }
  return bits;
}

/** analyze_bit_activity: the share of samples in which each bit is 1, in percent; 50 is what a full-scale sine gives. */
export function activity(bits: Uint8Array, m: number): number[] {
  const count = new Array<number>(m).fill(0);
  for (let i = 0; i < bits.length; i++) count[i % m] += bits[i];
  return count.map((c) => (c / (bits.length / m)) * 100);
}

export interface Radix {
  /** |w_{j−1}| / |w_j| for j = 1 … m − 1 */
  radix: number[];
  /** the scale that puts the significant weights nearest to whole LSBs */
  wgtsca: number;
  /** log2 of the significant weights' span, plus one */
  effres: number;
  /** how many of the largest weights count as significant */
  significant: number;
}

/**
 * analyze_weight_radix: the ratio of each weight to the next, and, from the magnitudes sorted largest first and cut
 * where one is three times the next, the resolution they span, log2(Σ|w| / min|w| + 1), and the scale that puts them
 * nearest to whole numbers, searched over MSB values from half to one and a half times the first guess.
 */
export function weightRadix(weights: ArrayLike<number>): Radix {
  const abs = Array.from(weights, Math.abs);
  const radix = abs.slice(1).map((w, j) => abs[j] / w);
  const sorted = [...abs].sort((a, b) => b - a);
  let k = sorted.length - 1;
  for (let j = 0; j < sorted.length - 1; j++) {
    if (sorted[j] / sorted[j + 1] >= 3) {
      k = j;
      break;
    }
  }
  const sig = sorted.slice(0, k + 1);
  const error = (scale: number) => {
    const off = sig.map((w) => w * scale - roundEven(w * scale));
    return Math.sqrt(npSum(off.map((d) => d * d)) / sig.length);
  };
  let wgtsca = 1 / sig[k];
  const wErr = error(wgtsca);
  if (wErr > 1e-12) {
    const first = roundEven(sorted[0] * wgtsca);
    const radius = Math.min(Math.max(1, roundEven(first * 0.1)), 2048);
    const lo = Math.max(1, first - radius), hi = Math.max(lo, first + radius);
    let best = wErr, bestScale = wgtsca;
    for (let msb = lo; msb <= hi; msb++) {
      const scale = msb / sorted[0], e = error(scale);
      if (e < best) [best, bestScale] = [e, scale];
    }
    if (best < 0.1) wgtsca = bestScale;
  }
  return { radix, wgtsca, effres: Math.log2(npSum(sig) / sig[k] + 1), significant: k + 1 };
}

export interface Overflow {
  /** per bit: the smallest and largest share of its segment's weight the segment reached */
  lo: number[];
  hi: number[];
  /** per bit, percent of samples whose segment reads 0 or less, and 1 or more (to within 1e-12) */
  atZero: number[];
  atOne: number[];
  /** per bit, the share each sample's segment reads */
  share: Float64Array[];
}

/**
 * analyze_overflow: the segment from bit j down to the LSB, weighted and divided by its weights' total, for every
 * sample. It stays inside 0 … 1 by construction; how close it gets, and how often it sits on a limit, is what tells a
 * clipped input or a comparison with no margin left. The limits are counted to within 1e-12, where the library tests
 * them exactly and a segment of all ones can land an ulp short.
 */
export function overflow(bits: Uint8Array, m: number, weights: ArrayLike<number>): Overflow {
  const n = bits.length / m;
  const out: Overflow = { lo: [], hi: [], atZero: [], atOne: [], share: [] };
  for (let j = 0; j < m; j++) {
    const total = npSum(weights, j, m);
    const share = new Float64Array(n);
    let lo = Infinity, hi = -Infinity, zero = 0, one = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let q = j; q < m; q++) s += bits[i * m + q] * weights[q];
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
      share[i] = s / total;
      if (share[i] <= 0) zero++;
      if (share[i] >= 1 - 1e-12) one++;
    }
    out.lo.push(lo / total);
    out.hi.push(hi / total);
    out.atZero.push((zero / n) * 100);
    out.atOne.push((one / n) * 100);
    out.share.push(share);
  }
  return out;
}

/** analyze_spectrum with the Hamming window analyze_enob_sweep uses, side bins left to auto detection and the record's own span as full scale. */
export function spectrumOf(x: Float64Array): Spectrum {
  let lo = Infinity, hi = -Infinity;
  for (const v of x) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  const peak = (hi - lo) / 2 || 1;
  return analyzeSpectrum(x.map((v) => v / peak), 1, 'hamming', 'auto');
}

/** The first `count` bits of every sample, weighted and summed. */
export function reconstruct(bits: Uint8Array, m: number, weights: ArrayLike<number>, count = m): Float64Array {
  return Float64Array.from({ length: bits.length / m }, (_, i) => {
    let s = 0;
    for (let j = 0; j < count; j++) s += bits[i * m + j] * weights[j];
    return s;
  });
}

/**
 * analyze_enob_sweep, prefix_of_full_calibration: one calibration with every bit, then the ENOB of the output built
 * from the first one, two, … bits of it.
 */
export const enobSweep = (bits: Uint8Array, m: number, weights: ArrayLike<number>): number[] =>
  Array.from({ length: m }, (_, k) => spectrumOf(reconstruct(bits, m, weights, k + 1)).enob);

/** exp_d13's nominal weights: the array's capacitors, with the last one's half unit that terminates it. */
export const nominalWeights = (caps: number[]): number[] => caps.map((c, j) => (j === caps.length - 1 ? c * 0.5 : c));

export interface Reading {
  caps: number[];
  bits: Uint8Array;
  activity: number[];
  /** calibrate_weight_sine's weights, in units of the fitted tone */
  weights: Float64Array;
  radix: Radix;
  nominal: Radix;
  overflow: Overflow;
  /** the ENOB sweep, left out when the caller runs it later: it takes most of the time */
  sweep: number[] | null;
  /** ENOB with the capacitors as weights, the same analysis as the sweep */
  uncalibrated: number;
}

export function read(array: ArrayName, amp: number, dc: number, noise: number, fault: Fault, withSweep = true): Reading {
  const caps = ARRAYS[array], m = caps.length;
  const bits = capture(caps, amp, dc, noise, fault);
  const { weight } = calibrateWeightSine(bits, m, TONE.fin / FS);
  return {
    caps,
    bits,
    activity: activity(bits, m),
    weights: weight,
    radix: weightRadix(weight),
    nominal: weightRadix(nominalWeights(caps)),
    overflow: overflow(bits, m, weight),
    sweep: withSweep ? enobSweep(bits, m, weight) : null,
    uncalibrated: spectrumOf(reconstruct(bits, m, caps)).enob,
  };
}
