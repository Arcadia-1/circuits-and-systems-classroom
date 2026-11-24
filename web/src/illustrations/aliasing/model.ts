/**
 * Aliasing and the Nyquist zones: whatever frequency goes into a sampler, it comes out somewhere in 0 … fs/2, and so do
 * its harmonics. Keeping only every N-th sample does the same again at fs/N.
 * Ported from ADCToolbox 0.9.1 (github.com/Arcadia-1/ADCToolbox):
 *   fundamentals/frequency  fold_frequency_to_nyquist, find_coherent_frequency, through src/lib/frequency.ts
 *   siggen/nonidealities    apply_static_nonlinearity_hd, apply_thermal_noise, apply_quantization_noise
 *   spectrum/               analyze_spectrum, through src/lib/spectrum.ts
 * following its examples exp_c01 (six Nyquist zones) and exp_d00 (every N-th sample, no anti-alias filter).
 * python/adc_aliasing.py calls ADCToolbox on the same samples; tests/aliasing-model.test.ts compares the two.
 *
 * Frequencies are in hertz; the record is in codes of a 12-bit converter on a 0 … 1 V range, as exp_d00 has it.
 */
import { coherentFrequency, foldFrequency } from '../../lib/frequency';
import { gaussians } from '../../lib/rng';
import { analyzeSpectrum, N_FFT, type Spectrum } from '../../lib/spectrum';

export const FS = 1e9;
export const N_BITS = 12;
export const KEEP = [1, 2, 3, 4];
/** Six Nyquist zones of the converter, as exp_c01 draws them. */
export const F_MAX = 3 * FS;
export const HARMONICS = [2, 3];
const AMP_DBFS = -1;
const NOISE_LSB = 0.3;

/** The Nyquist zone f falls in at rate fs, counted from 1. Odd zones land directly, even zones land mirrored. */
export const zoneOf = (f: number, fs: number): number => Math.floor(f / (fs / 2)) + 1;

/** Every frequency in 0 … fMax that lands where f does at rate fs: one in each zone, exp_c01's red points. */
export function twins(f: number, fs: number, fMax = F_MAX): number[] {
  const lands = foldFrequency(f, fs), out = new Set<number>();
  for (let k = 0; k * fs - lands <= fMax; k++) {
    // a tone that lands on 0 or on fs/2 has one twin per boundary rather than two per multiple of fs
    if (k > 0) out.add(k * fs - lands);
    if (k * fs + lands <= fMax) out.add(k * fs + lands);
  }
  return [...out];
}

/** apply_static_nonlinearity_hd: the coefficient of x^order that puts that harmonic of an amplitude-amp sine at dbc. */
export const hdCoefficient = (dbc: number, order: number, amp: number): number =>
  (2 ** (order - 1) * 10 ** (dbc / 20)) / amp ** (order - 1);

/**
 * The converter's own record, keep × 4096 samples at FS, in the order of exp_d00: a sine on a 0 … 1 V range, the
 * Chebyshev-designed static curve of apply_static_nonlinearity_hd (#123) that puts HD2 and HD3 at the exact requested
 * dBc while keeping the output fundamental amplitude unchanged, thermal noise, then the quantiser.
 */
export function capture(fin: number, keep: number, hd2: number, hd3: number, seed: number): Float64Array {
  const len = keep * N_FFT, lsb = 1 / 2 ** N_BITS, top = 2 ** N_BITS - 1;
  const amp = 0.5 * 10 ** (AMP_DBFS / 20), dc = 0.5;
  const k1 = 1 - 3 * 10 ** (hd3 / 20), k2 = hdCoefficient(hd2, 2, amp), k3 = hdCoefficient(hd3, 3, amp);
  const z = gaussians(len, seed);
  return Float64Array.from({ length: len }, (_, i) => {
    const ac = amp * Math.sin(2 * Math.PI * fin * (i / FS)) + dc - dc;
    const v = k1 * ac + k2 * ac ** 2 + k3 * ac ** 3 + dc + z[i] * NOISE_LSB * lsb;
    return Math.min(top, Math.max(0, Math.floor(v / lsb)));
  });
}

/** What a subsample-only rate adapter passes on: samples keep − 1, 2·keep − 1, …, as exp_d00's counter picks them. */
export const keepEvery = (record: Float64Array, keep: number): Float64Array => record.filter((_, i) => i % keep === keep - 1);

export interface Landing {
  order: number;
  /** where the tone or harmonic really is, and where it lands at the output rate */
  at: number;
  lands: number;
  /** false for a harmonic that stays where it is, below the output Nyquist */
  folded: boolean;
}

export interface Reading {
  fin: number;
  /** the tone's bin in the converter's record, keep × 4096 long */
  bin: number;
  fsOut: number;
  landings: Landing[];
  /** the converter's own record at FS, and what is left of it at FS / keep */
  before: Spectrum;
  after: Spectrum;
  /** the kept samples around mid-scale, as a fraction of the tone's amplitude */
  samples: Float64Array;
}

export function read(target: number, keep: number, hd2: number, hd3: number, seed = 7): Reading {
  const { fin, bin } = coherentFrequency(FS, target, keep * N_FFT);
  const fsOut = FS / keep;
  const record = capture(fin, keep, hd2, hd3, seed), kept = keepEvery(record, keep);
  const amp = 2 ** (N_BITS - 1) * 10 ** (AMP_DBFS / 20);
  let mean = 0;
  for (const v of kept) mean += v / kept.length;
  return {
    fin,
    bin,
    fsOut,
    landings: [1, ...HARMONICS].map((order) => {
      const at = order * fin, lands = foldFrequency(at, fsOut);
      return { order, at, lands, folded: lands !== at };
    }),
    before: analyzeSpectrum(record, N_BITS),
    after: analyzeSpectrum(kept, N_BITS),
    samples: kept.map((v) => (v - mean) / amp),
  };
}

/** The mean power of the bins that are neither the tone nor its folded harmonics, dBFS: the floor the noise sets. */
export function floorOf(s: Spectrum): number {
  const skip = new Set([s.signal, ...s.harmonics]);
  let sum = 0, count = 0;
  for (let k = 1; k < s.dbfs.length; k++) {
    if (skip.has(k)) continue;
    sum += 10 ** (s.dbfs[k] / 10);
    count++;
  }
  return 10 * Math.log10(sum / count);
}
