import { convertPipeline, type ConfigurableStage } from './configurable';

export interface ErrorSettings {
  /** Zero-based residue-amplifier stage; the final flash has no amplifier. */
  stage: number;
  /** Percent error of the ideal residue amplifier's gain. */
  gainError: number;
  /** Percent coefficient of the endpoint-preserving cubic term below. */
  nonlinearity: number;
}

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
  settings: ErrorSettings;
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

interface Prepared { bits: number[]; settings: ErrorSettings; totalBits: number; levels: number }

function prepare(bits: readonly number[], settings: ErrorSettings): Prepared {
  const ideal = convertPipeline(0, bits); // Reuse the topology's validation.
  if (!Number.isInteger(settings.stage) || settings.stage < 0 || settings.stage >= bits.length - 1) {
    throw new RangeError('Apply errors to a residue amplifier before the final flash.');
  }
  if (![settings.gainError, settings.nonlinearity].every(value => Number.isFinite(value) && Math.abs(value) <= 5)) {
    throw new RangeError('Gain error and cubic coefficient must lie between −5% and +5%.');
  }
  return { bits: Array.from(bits), settings: { ...settings }, totalBits: ideal.totalBits, levels: ideal.levels };
}

/**
 * F(r) = (1+g)r + 4n r(1−r)(2r−1), g and n expressed as fractions.
 * The cubic term vanishes at r=0, 1/2, 1, so n adds no endpoint gain error.
 * F'(r)=1+g+n(−24r²+24r−4) >= 0.75 over [0,1] for permitted settings.
 */
function amplified(r: number, settings: ErrorSettings): number {
  return (1 + settings.gainError / 100) * r + 4 * settings.nonlinearity / 100 * r * (1 - r) * (2 * r - 1);
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
  const { bits, settings, totalBits, levels } = prepared;
  let localInput = input, code = 0, resolvedBits = 0;
  const stages = bits.map((stageBits, index): ErrorStage => {
    // Quantizers saturate; the analog residue is deliberately NOT clipped.
    const injected = index === settings.stage;
    const { gain, digit, dac, idealResidue, residue } = evaluateStage(localInput, stageBits, injected ? settings : null);
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

export function convertWithErrors(input: number, bits: readonly number[], settings: ErrorSettings = DEFAULT_ERRORS): ErrorConversion {
  return run(input, prepare(bits, settings));
}

/** Invert the strictly increasing amplifier only within its physical 0–1 V input. */
function inverseAmplifier(target: number, settings: ErrorSettings): number {
  if (target <= 0) return 0;
  if (target >= amplified(1, settings)) return 1;
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
 * Solve actual code crossings, not a warped ideal DNL curve. Stages before the
 * single injected amplifier are ideal: its input ramps repeat in equal prefix
 * bins. All following ideal quantizers together saturate a suffix quantizer.
 * Thus only suffix thresholds require inversion; prefix bins repeat them.
 */
export function analyzeLinearity(bits: readonly number[], settings: ErrorSettings = DEFAULT_ERRORS): LinearityAnalysis {
  const prepared = prepare(bits, settings);
  const { levels, totalBits } = prepared;
  const prefixBits = bits.slice(0, settings.stage + 1).reduce((sum, bit) => sum + bit, 0);
  const prefixLevels = 2 ** prefixBits, suffixLevels = levels / prefixLevels;
  const suffixThresholds = Array.from({ length: suffixLevels }, (_, k) => inverseAmplifier(k / suffixLevels, settings));
  const thresholds = Array.from({ length: levels + 1 }, (_, code) => {
    if (code === levels) return 1;
    return (Math.floor(code / suffixLevels) + suffixThresholds[code % suffixLevels]) / prefixLevels;
  });
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
  const g = settings.gainError / 100, n = settings.nonlinearity / 100;
  const minimumDerivative = Math.min(1 + g - 4 * n, 1 + g + 2 * n);
  return { bits: prepared.bits, settings: prepared.settings, totalBits, levels, thresholds, transitionValid, widths, nominalDnl, nominalInl, endpointDnl, endpointInl, endpointCodes, fittedLsb, endpointValid, missingCodes, monotonic: minimumDerivative > 0, minimumDerivative };
}

export interface ResiduePoint { x: number; y: number }

/** Actual continuous residue branches, separated at true prefix-code crossings. */
export function actualResidueCurves(bits: readonly number[], settings: ErrorSettings, analysis: LinearityAnalysis, stageIndex: number, domain: readonly [number, number]): ResiduePoint[][] {
  const prepared = prepare(bits, settings);
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= bits.length - 1) throw new RangeError('Select an actual residue stage.');
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1]) || domain[0] < 0 || domain[1] > 1 || domain[0] >= domain[1]) throw new RangeError('The input domain must satisfy 0 ≤ lower < upper ≤ 1.');
  if (analysis.bits.join(',') !== bits.join(',') || analysis.settings.stage !== settings.stage || analysis.settings.gainError !== settings.gainError || analysis.settings.nonlinearity !== settings.nonlinearity) throw new RangeError('Transition analysis must match the topology and error settings.');
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
