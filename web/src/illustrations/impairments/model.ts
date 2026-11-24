/**
 * What sets a converter's floor: one impairment at a time, its signature in the spectrum, what it does to SNDR as it
 * grows, and the SNR it alone would allow.
 * Ported from ADCToolbox 0.9.1 (github.com/Arcadia-1/ADCToolbox):
 *   siggen/nonidealities   apply_jitter, apply_incomplete_sampling, apply_memory_effect, apply_am_tone,
 *                          apply_quantization_noise, and apply_thermal_noise's sum
 *   aout/                  analyze_error_by_phase, over fit_sine_4param, through ../errors/model.ts
 *   fundamentals/          find_coherent_frequency, and amplitudes_to_snr and calculate_jitter_limit through
 *                          src/lib/units.ts
 *   spectrum/              analyze_spectrum, through src/lib/spectrum.ts
 * following its examples exp_g01, exp_g03, exp_g04, exp_a04, exp_g06 and exp_g07.
 * python/adc_impairments.py calls ADCToolbox on the same samples; tests/impairments-model.test.ts compares the two.
 *
 * Volts on a 0 … 1 V range, as those examples have them: 4096 samples at 1 GS/s.
 */
import { coherentFrequency } from '../../lib/frequency';
import { gaussians } from '../../lib/rng';
import { analyzeSpectrum, N_FFT, type Spectrum } from '../../lib/spectrum';
import { amplitudesToSnr, jitterLimit } from '../../lib/units';
import { byPhase, fitSine, type Phase } from '../errors/model';

export const N = N_FFT;
export const FS = 1e9;
export const AMP = 0.45;
export const DC = 0.5;
/** the noise floor and the converter behind every impairment but their own, as exp_g06 and exp_g07 have them */
export const BASE_NOISE = 10e-6;
export const BITS = 14;
/** exp_g07's interfering tone, moved onto a bin of its own */
export const AM_BIN = 41;
export const TONE = coherentFrequency(FS, 97e6, N);

const NOISE = gaussians(N, 31);
const JITTER = gaussians(N, 32);

export type Kind = 'thermal' | 'quantiser' | 'jitter' | 'settling' | 'memory' | 'interferer';

/** What each impairment is measured in, the strengths the sweep reads, and where the lesson opens. */
export const SWEEPS: Record<Kind, { unit: string; scale: number; strengths: number[]; start: number }> = {
  thermal: { unit: 'µV', scale: 1e6, strengths: [1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3], start: 5e-5 },
  quantiser: { unit: 'bits', scale: 1, strengths: [4, 6, 8, 10, 11, 12, 13, 14, 15, 16], start: 12 },
  jitter: { unit: 'fs', scale: 1e15, strengths: [1e-15, 2e-15, 5e-15, 1e-14, 2e-14, 5e-14, 1e-13, 2e-13, 5e-13, 1e-12], start: 1e-13 },
  settling: { unit: '', scale: 1, strengths: [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5], start: 0.15 },
  memory: { unit: '%', scale: 100, strengths: [0, 0.0005, 0.001, 0.002, 0.005, 0.009, 0.02], start: 0.005 },
  interferer: { unit: '%', scale: 100, strengths: [0, 0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03], start: 0.003 },
};

/** A strength in the unit its impairment is measured in: 50 µV, 12 bits, 100 fs, 0.15, 0.5 %. */
export function strengthText(kind: Kind, strength: number, withUnit = true): string {
  const { scale, unit } = SWEEPS[kind], v = strength * scale;
  const digits = v === 0 || Number.isInteger(v) ? 0 : v < 0.1 ? 3 : v < 1 ? 2 : 1;
  const text = v.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return text + (withUnit && unit ? ` ${unit}` : '');
}

/** apply_incomplete_sampling: the track lasts a fifth of a period, and a bigger sample takes longer to settle. */
export function settle(signal: Float64Array, k: number, tauNom = 40e-12): Float64Array {
  const track = (1 / FS) * 0.2;
  const out = new Float64Array(signal.length);
  let previous = 0;
  for (let i = 0; i < signal.length; i++) {
    const target = signal[i] - DC;
    out[i] = target + (previous - target) * Math.exp(-track / (tauNom * (1 + k * target * target))) + DC;
    previous = out[i] - DC;
  }
  return out;
}

/** apply_memory_effect: a share of the previous sample's coarse code leaks into this one; the first sample sees the last. */
export function remember(signal: Float64Array, strength: number): Float64Array {
  const n = signal.length;
  const msb = Float64Array.from(signal, (v) => Math.floor(v * 2 ** 4) / 2 ** 4);
  const lsb = Float64Array.from(signal, (v, i) => Math.floor((v - msb[i]) * 2 ** 12) / 2 ** 12);
  return Float64Array.from({ length: n }, (_, i) => msb[i] + lsb[i] + strength * msb[(i + n - 1) % n]);
}

/** apply_am_tone: a slow tone rides on the signal's amplitude. */
export const modulate = (signal: Float64Array, depth: number, bin = AM_BIN): Float64Array =>
  Float64Array.from(signal, (v, i) => (v - DC) * (1 + depth * Math.sin((2 * Math.PI * bin * i) / N)) + DC);

/** apply_quantization_noise on 0 … 1 V: floor to a code, clip, and read it back. */
export function quantise(signal: Float64Array, bits: number): Float64Array {
  const lsb = 1 / 2 ** bits, top = 2 ** bits - 1;
  return Float64Array.from(signal, (v) => Math.min(top, Math.max(0, Math.floor((v - 0) / lsb))) * lsb + 0);
}

/** One capture of a coherent sine through one impairment, then the noise floor and the converter. */
export function capture(kind: Kind, strength: number, fin = TONE.fin): Float64Array {
  let x: Float64Array =
    kind === 'jitter'
      ? Float64Array.from({ length: N }, (_, i) => AMP * Math.sin(2 * Math.PI * fin * (i / FS + JITTER[i] * strength)) + DC)
      : Float64Array.from({ length: N }, (_, i) => AMP * Math.sin(2 * Math.PI * fin * (i / FS)) + DC);
  if (kind === 'settling') x = settle(x, strength);
  else if (kind === 'memory') x = remember(x, strength);
  else if (kind === 'interferer') x = modulate(x, strength);
  const rms = kind === 'thermal' ? strength : BASE_NOISE;
  x = Float64Array.from(x, (v, i) => v + NOISE[i] * rms);
  return quantise(x, kind === 'quantiser' ? Math.round(strength) : BITS);
}

/** analyze_spectrum over the whole 0 … 1 V range, the rectangular window on a coherent tone. */
export const spectrumOf = (x: Float64Array): Spectrum => analyzeSpectrum(x.map((v) => v * 2), 1);

/**
 * The SNR analyze_spectrum reports with nf_method 3: the noise is everything in band except the tone and its
 * harmonics, so an impairment that distorts rather than adds noise leaves it where it was.
 */
export function snrFrom(s: Spectrum): number {
  const skip = new Set([s.signal, ...s.harmonics]);
  let signal = 0, noise = 0;
  for (let k = 0; k < s.inband; k++) {
    const p = 10 ** (s.dbfs[k] / 10);
    if (k === s.signal) signal += p;
    else if (!skip.has(k)) noise += p;
  }
  return 10 * Math.log10(signal / noise);
}

/**
 * The SNR each impairment alone would allow: thermal noise and a quantiser's own noise through amplitudes_to_snr, a
 * clock through calculate_jitter_limit. Settling, memory and an interferer distort rather than add noise, and have no
 * such number.
 */
export function limitOf(kind: Kind, strength: number, fin = TONE.fin): number | null {
  if (kind === 'thermal') return amplitudesToSnr(AMP, strength);
  if (kind === 'quantiser') return amplitudesToSnr(AMP, 1 / 2 ** Math.round(strength) / Math.sqrt(12));
  if (kind === 'jitter') return jitterLimit(fin, strength);
  return null;
}

export interface Split extends Phase {
  /** the pm part as an angle, which is what a clock's jitter comes back as */
  radians: number;
  amplitude: number;
}

/**
 * analyze_error_by_phase: fit the sine away and split what is left into the parts that ride on it, on its slope, and
 * on neither. Frequency refinement runs to convergence, so the frequency it ends on is the one the phases follow.
 */
export function splitError(x: Float64Array, fin = TONE.fin): { fit: ReturnType<typeof fitSine>; split: Split } {
  const fit = fitSine(x, (fin / FS) * N, 100);
  const phase = byPhase(fit.error, fit.frequency * N, fit.phase);
  return { fit, split: { ...phase, radians: fit.amplitude > 1e-10 ? phase.pm / fit.amplitude : 0, amplitude: fit.amplitude } };
}

/** exp_a04: the clock's jitter, read back from the phase-modulated part of the error. */
export const jitterFrom = (split: Split, fin = TONE.fin): number => split.radians / (2 * Math.PI * fin);

export interface Reading {
  kind: Kind;
  strength: number;
  fin: number;
  data: Float64Array;
  spectrum: Spectrum;
  /** SNDR is in the spectrum; this is SNR, with the harmonics left out of the noise */
  snr: number;
  split: Split;
  error: Float64Array;
  /** the SNR this impairment alone allows, when it has one */
  limit: number | null;
}

export function read(kind: Kind, strength: number, fin = TONE.fin): Reading {
  const data = capture(kind, strength, fin);
  const { fit, split } = splitError(data, fin);
  const spectrum = spectrumOf(data);
  return { kind, strength, fin, data, spectrum, snr: snrFrom(spectrum), split, error: fit.error, limit: limitOf(kind, strength, fin) };
}

export interface Sweep {
  strengths: number[];
  sndr: number[];
  snr: number[];
  sfdr: number[];
  /** the impairment's own limit at each strength, where it has one */
  limit: (number | null)[];
  /** for a clock, the jitter measured back out of the error */
  recovered: number[] | null;
}

/** The same capture at every strength the lesson sweeps. */
export function sweep(kind: Kind, fin = TONE.fin): Sweep {
  const { strengths } = SWEEPS[kind];
  const out: Sweep = { strengths, sndr: [], snr: [], sfdr: [], limit: [], recovered: kind === 'jitter' ? [] : null };
  for (const s of strengths) {
    const r = read(kind, s, fin);
    out.sndr.push(r.spectrum.sndr);
    out.snr.push(r.snr);
    out.sfdr.push(r.spectrum.sfdr);
    out.limit.push(r.limit);
    out.recovered?.push(jitterFrom(r.split, fin));
  }
  return out;
}
