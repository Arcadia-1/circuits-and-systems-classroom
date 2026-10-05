import { convertPipeline, type ConfigurableStage } from './configurable';

export interface ErrorSettings {
  /** Zero-based residue-amplifier stage; the final flash has no amplifier. */
  stage: number;
  /** Percent error of the ideal residue amplifier's gain. */
  gainError: number;
  /** Percent coefficient of the endpoint-preserving cubic term below. */
  nonlinearity: number;
}

/** A single legacy injection, or independent errors in any subset of amplifiers. */
export type PipelineErrorSettings = ErrorSettings | readonly ErrorSettings[];

export const DEFAULT_ERRORS: ErrorSettings = { stage: 0, gainError: 0, nonlinearity: 0 };

export interface ErrorStage extends Omit<ConfigurableStage, 'lower' | 'upper'> {
  idealResidue: number;
  injected: boolean;
  /** Nominal code-prefix edges, NOT the true input transition locations. */
  nominalLower: number;
  nominalUpper: number;
}

export interface ErrorConversion {
  input: number;
  stages: ErrorStage[];
  code: number;
  levels: number;
  totalBits: number;
  estimate: number;
  error: number;
}

export interface LinearityAnalysis {
  bits: number[];
  /** Canonical stage-ordered settings, including zero entries for every amplifier. */
  settings: ErrorSettings[];
  totalBits: number;
  levels: number;
  /** T[k] = first input attaining code >= k, clipped to the measured 0–1 V range. */
  thresholds: number[];
  /** False for range edges and thresholds never reached inside the input range. */
  transitionValid: boolean[];
  widths: number[];
  /** N code widths / nominal LSB - 1, including range-limited first/last bins. */
  nominalDnl: number[];
  /** N+1 transition INLs against k/N; unavailable transitions are null. */
  nominalInl: Array<number | null>;
  /** N code-width DNL values using the observed endpoint fit. Outer bins are null. */
  endpointDnl: Array<number | null>;
  /** N+1 transition INLs fitted through the first/last observed transitions. */
  endpointInl: Array<number | null>;
  endpointCodes: [number, number] | null;
  fittedLsb: number | null;
  endpointValid: boolean;
  missingCodes: number[];
  monotonic: boolean;
  minimumDerivative: number;
}

interface Prepared { bits: number[]; settings: ErrorSettings[]; configured: Set<number>; totalBits: number; levels: number }

function entries(settings: PipelineErrorSettings): readonly ErrorSettings[] {
  return Array.isArray(settings) ? settings : [settings as ErrorSettings];
}

function normalize(bits: readonly number[], settings: PipelineErrorSettings): ErrorSettings[] {
  const normalized = bits.slice(0, -1).map((_, stage) => ({ stage, gainError: 0, nonlinearity: 0 }));
  const seen = new Set<number>();
  for (const entry of entries(settings)) {
    if (!Number.isInteger(entry.stage) || entry.stage < 0 || entry.stage >= bits.length - 1) {
      throw new RangeError('Apply errors to a residue amplifier before the final flash.');
    }
    if (seen.has(entry.stage)) throw new RangeError('Specify each residue amplifier at most once.');
    if (![entry.gainError, entry.nonlinearity].every(value => Number.isFinite(value) && Math.abs(value) <= 5)) {
      throw new RangeError('Gain error and cubic coefficient must lie between −5% and +5%.');
    }
    seen.add(entry.stage);
    normalized[entry.stage] = { ...entry };
  }
  return normalized;
}

/** Validate and copy settings; omitted stages are ideal and array order is immaterial. */
export function normalizeErrorSettings(bits: readonly number[], settings: PipelineErrorSettings = DEFAULT_ERRORS): ErrorSettings[] {
  convertPipeline(0, bits);
  return normalize(bits, settings);
}

function prepare(bits: readonly number[], settings: PipelineErrorSettings): Prepared {
  const ideal = convertPipeline(0, bits); // Reuse the topology's validation.
  return { bits: Array.from(bits), settings: normalize(bits, settings), configured: new Set(entries(settings).map(entry => entry.stage)), totalBits: ideal.totalBits, levels: ideal.levels };
}

/**
 * F(r) = (1+g)r + 4n r(1−r)(2r−1), g and n expressed as fractions.
 * The cubic term vanishes at r=0, 1/2, 1, so n adds no endpoint gain error.
 * F'(r)=1+g+n(−24r²+24r−4) >= 0.75 over [0,1] for permitted settings.
 * Outside [0,1], continue along the endpoint tangent. An unrestricted cubic
 * extrapolation can reverse slope after upstream errors create overrange;
 * this C1 behavioral extension stays monotone without clipping analog values.
 */
function amplified(r: number, settings: ErrorSettings): number {
  const g = settings.gainError / 100, n = settings.nonlinearity / 100;
  const endpointSlope = 1 + g - 4 * n;
  if (r < 0) return endpointSlope * r;
  if (r > 1) return 1 + g + endpointSlope * (r - 1);
  return (1 + g) * r + 4 * n * r * (1 - r) * (2 * r - 1);
}

export interface StageResponse { gain: number; digit: number; dac: number; idealResidue: number; residue: number }

/**
 * Shared local stage law. Callers validate the topology/settings first. An
 * explicit branchDigit evaluates the one-sided endpoint of that quantizer
 * branch; normal conversion omits it and uses the saturating quantizer.
 */
export function evaluateStage(input: number, bits: number, settings: ErrorSettings | null = null, branchDigit?: number): StageResponse {
  const gain = 2 ** bits;
  const digit = branchDigit ?? Math.max(0, Math.min(gain - 1, Math.floor(gain * input)));
  const dac = digit / gain;
  const idealResidue = gain * (input - dac);
  return { gain, digit, dac, idealResidue, residue: settings ? amplified(idealResidue, settings) : idealResidue };
}

function run(input: number, prepared: Prepared): ErrorConversion {
  if (!Number.isFinite(input) || input < 0 || input > 1) throw new RangeError('Input must be finite and in [0, 1] V.');
  const { bits, settings, configured, totalBits, levels } = prepared;
  let localInput = input, code = 0, resolvedBits = 0;
  const stages = bits.map((stageBits, index): ErrorStage => {
    // Quantizers saturate; the analog residue is deliberately NOT clipped.
    const injected = configured.has(index);
    const { gain, digit, dac, idealResidue, residue } = evaluateStage(localInput, stageBits, settings[index] ?? null);
    code = gain * code + digit;
    resolvedBits += stageBits;
    const prefixLevels = 2 ** resolvedBits;
    const stage = { index, bits: stageBits, gain, input: localInput, digit, dac, idealResidue, residue, injected, prefixCode: code, resolvedBits, nominalLower: code / prefixLevels, nominalUpper: (code + 1) / prefixLevels };
    localInput = residue;
    return stage;
  });
  const estimate = (code + 0.5) / levels;
  return { input, stages, code, levels, totalBits, estimate, error: estimate - input };
}

export function convertWithErrors(input: number, bits: readonly number[], settings: PipelineErrorSettings = DEFAULT_ERRORS): ErrorConversion {
  return run(input, prepare(bits, settings));
}

/** Invert the monotone behavioral amplifier, including its unclipped overrange. */
function inverseAmplifier(target: number, settings: ErrorSettings): number {
  const g = settings.gainError / 100, n = settings.nonlinearity / 100;
  const endpointSlope = 1 + g - 4 * n;
  if (target <= 0) return target / endpointSlope;
  if (target >= 1 + g) return 1 + (target - (1 + g)) / endpointSlope;
  if (settings.nonlinearity === 0) return target / (1 + settings.gainError / 100);
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 54; iteration++) {
    const middle = (low + high) / 2;
    if (amplified(middle, settings) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * Recursively invert the complete suffix converter, starting with the flash.
 * Within a digit branch q, a suffix crossing t occurs at (q + F^-1(t))/2^b.
 * Nonfinal digit branches end at (q+1)/2^b: a missed suffix code is first
 * exceeded at that reset. The final digit is saturated and has no upper input
 * boundary, so its thresholds may exceed 1; only the ORIGINAL Vin is range-
 * clipped after every stage has been inverted. Each suffix threshold is
 * inverted just once per amplifier, then reused across its digit branches.
 */
export function analyzeLinearity(bits: readonly number[], settings: PipelineErrorSettings = DEFAULT_ERRORS): LinearityAnalysis {
  const prepared = prepare(bits, settings);
  const { levels, totalBits } = prepared;
  let suffixLevels = 2 ** bits[bits.length - 1];
  // Entry zero is a sentinel for the first digit, not a measured transition.
  let crossings = Array.from({ length: suffixLevels }, (_, code) => code / suffixLevels);
  for (let stage = bits.length - 2; stage >= 0; stage--) {
    const gain = 2 ** bits[stage];
    const inverse = crossings.map(value => inverseAmplifier(value, prepared.settings[stage]));
    const next = Array.from({ length: gain * suffixLevels }, (_, code) => {
      const digit = Math.floor(code / suffixLevels), suffix = code % suffixLevels;
      if (suffix === 0) return digit / gain;
      const residue = digit < gain - 1 ? Math.min(1, inverse[suffix]) : inverse[suffix];
      return (digit + residue) / gain;
    });
    crossings = next;
    suffixLevels *= gain;
  }
  const thresholds = [...crossings.map(value => Math.min(1, Math.max(0, value))), 1];
  const highestCode = run(1, prepared).code;
  const transitionValid = thresholds.map((_, code) => code > 0 && code < levels && code <= highestCode);
  const widths = Array.from({ length: levels }, (_, code) => thresholds[code + 1] - thresholds[code]);
  const nominalDnl = widths.map(width => width * levels - 1);
  const nominalInl = thresholds.map((threshold, code) => transitionValid[code] ? (threshold - code / levels) * levels : null);
  const observed = transitionValid.flatMap((valid, code) => valid ? [code] : []);
  const first = observed[0], last = observed.at(-1);
  const endpointCodes: [number, number] | null = first !== undefined && last !== undefined && last > first ? [first, last] : null;
  const candidateLsb = endpointCodes ? (thresholds[endpointCodes[1]] - thresholds[endpointCodes[0]]) / (endpointCodes[1] - endpointCodes[0]) : null;
  const fittedLsb = candidateLsb !== null && candidateLsb > 0 ? candidateLsb : null;
  const endpointValid = fittedLsb !== null;
  const endpointInl = thresholds.map((threshold, code) => {
    if (!transitionValid[code] || !endpointCodes || fittedLsb === null) return null;
    const ideal = thresholds[endpointCodes[0]] + (code - endpointCodes[0]) * fittedLsb;
    return (threshold - ideal) / fittedLsb;
  });
  const endpointDnl = widths.map((width, code) => code > 0 && code < levels - 1 && transitionValid[code] && transitionValid[code + 1] && fittedLsb !== null ? width / fittedLsb - 1 : null);
  const missingCodes = widths.flatMap((width, code) => width === 0 ? [code] : []);
  const minimumDerivative = Math.min(...prepared.settings.flatMap(entry => {
    const g = entry.gainError / 100, n = entry.nonlinearity / 100;
    return [1 + g - 4 * n, 1 + g + 2 * n];
  }));
  return { bits: prepared.bits, settings: prepared.settings, totalBits, levels, thresholds, transitionValid, widths, nominalDnl, nominalInl, endpointDnl, endpointInl, endpointCodes, fittedLsb, endpointValid, missingCodes, monotonic: minimumDerivative > 0, minimumDerivative };
}

export interface ResiduePoint { x: number; y: number }

/** Actual continuous residue branches, separated at true prefix-code crossings. */
export function actualResidueCurves(bits: readonly number[], settings: PipelineErrorSettings, analysis: LinearityAnalysis, stageIndex: number, domain: readonly [number, number]): ResiduePoint[][] {
  const prepared = prepare(bits, settings);
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= bits.length - 1) throw new RangeError('Select an actual residue stage.');
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1]) || domain[0] < 0 || domain[1] > 1 || domain[0] >= domain[1]) throw new RangeError('The input domain must satisfy 0 ≤ lower < upper ≤ 1.');
  if (analysis.bits.join(',') !== bits.join(',') || analysis.settings.length !== prepared.settings.length || analysis.settings.some((entry, stage) => entry.gainError !== prepared.settings[stage].gainError || entry.nonlinearity !== prepared.settings[stage].nonlinearity)) throw new RangeError('Transition analysis must match the topology and error settings.');
  const resolvedBits = bits.slice(0, stageIndex + 1).reduce((sum, bit) => sum + bit, 0);
  const prefixLevels = 2 ** resolvedBits, suffixLevels = prepared.levels / prefixLevels;
  const curves: ResiduePoint[][] = [];
  for (let prefix = 0; prefix < prefixLevels; prefix++) {
    const lower = analysis.thresholds[prefix * suffixLevels], upper = analysis.thresholds[(prefix + 1) * suffixLevels];
    const x0 = Math.max(domain[0], lower), x1 = Math.min(domain[1], upper);
    if (x1 <= x0) continue;
    const epsilon = Math.min((x1 - x0) * 1e-6, 1e-10);
    curves.push(Array.from({ length: 17 }, (_, point) => {
      const x = x0 + (x1 - x0) * point / 16;
      const evaluateAt = point === 0 && x0 === lower ? x0 + epsilon : point === 16 && x1 === upper && x1 !== 1 ? x1 - epsilon : x;
      return { x, y: run(evaluateAt, prepared).stages[stageIndex].residue };
    }));
  }
  return curves;
}
