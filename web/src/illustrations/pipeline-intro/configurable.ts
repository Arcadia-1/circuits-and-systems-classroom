/** Ideal nonredundant stages. Every stage except the final flash passes a residue. */
export interface PipelineTopology {
  id: 'ten' | 'three-bit' | 'four-bit' | 'intro';
  label: string;
  bits: number[];
}

export const TOPOLOGIES: PipelineTopology[] = [
  { id: 'ten', label: '10 stages · 9×1 + 3 bits', bits: [1, 1, 1, 1, 1, 1, 1, 1, 1, 3] },
  { id: 'three-bit', label: '4 stages · 3 bits each', bits: [3, 3, 3, 3] },
  { id: 'four-bit', label: '3 stages · 4 bits each', bits: [4, 4, 4] },
  { id: 'intro', label: '3 stages · 2 bits each', bits: [2, 2, 2] },
];

export interface ConfigurableStage {
  /** Zero-based stage index. */
  index: number;
  bits: number;
  gain: number;
  input: number;
  digit: number;
  dac: number;
  /** The final stage's mathematical remainder is diagnostic, not a physical output. */
  residue: number;
  prefixCode: number;
  resolvedBits: number;
  /** Input-referred interval selected by every decision through this stage. */
  lower: number;
  upper: number;
}

export interface PipelineConversion {
  input: number;
  stages: ConfigurableStage[];
  code: number;
  levels: number;
  totalBits: number;
  estimate: number;
  error: number;
}

export interface ResidueRamp { x0: number; x1: number; y0: number; y1: number }
export interface TransferStep { x0: number; x1: number; y: number }

function validateBits(bits: readonly number[]): number {
  if (bits.length < 2 || bits.length > 12) {
    throw new RangeError('Use 2–12 stages with 1–4 bits per stage.');
  }
  let totalBits = 0;
  for (const bit of bits) {
    if (!Number.isInteger(bit) || bit < 1 || bit > 4) throw new RangeError('Use 2–12 stages with 1–4 bits per stage.');
    totalBits += bit;
  }
  if (totalBits > 16) throw new RangeError('Total resolution must not exceed 16 bits.');
  return totalBits;
}

function validateDomain(domain: readonly [number, number]): void {
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1]) || domain[0] < 0 || domain[1] > 1 || domain[0] >= domain[1]) {
    throw new RangeError('The input domain must satisfy 0 ≤ lower < upper ≤ 1.');
  }
}

/** Concatenate actual stage decisions; no analog remainder enters the final code. */
export function convertPipeline(input: number, bits: readonly number[]): PipelineConversion {
  const totalBits = validateBits(bits);
  if (!Number.isFinite(input) || input < 0 || input > 1) throw new RangeError('Input must be finite and in [0, 1] V.');
  let localInput = input, code = 0, resolvedBits = 0;
  const stages = bits.map((stageBits, index): ConfigurableStage => {
    const gain = 2 ** stageBits;
    const digit = Math.min(gain - 1, Math.floor(gain * localInput));
    const dac = digit / gain;
    const residue = gain * (localInput - dac);
    code = gain * code + digit;
    resolvedBits += stageBits;
    const prefixLevels = 2 ** resolvedBits;
    const stage = { index, bits: stageBits, gain, input: localInput, digit, dac, residue, prefixCode: code, resolvedBits, lower: code / prefixLevels, upper: (code + 1) / prefixLevels };
    localInput = residue;
    return stage;
  });
  const levels = 2 ** totalBits;
  const estimate = (code + 0.5) / levels;
  return { input, stages, code, levels, totalBits, estimate, error: estimate - input };
}

/** Zoom to the interval BEFORE a pair of adjacent actual residue stages. */
export function inspectionWindow(conversion: PipelineConversion, firstResidue: number): [number, number] {
  if (!Number.isInteger(firstResidue) || firstResidue < 0 || firstResidue > conversion.stages.length - 3) {
    throw new RangeError('Select two adjacent residue stages before the final flash.');
  }
  if (firstResidue === 0) return [0, 1];
  const previous = conversion.stages[firstResidue - 1];
  return [previous.lower, previous.upper];
}

/**
 * Piecewise residue versus ORIGINAL Vin. Cut intervals preserve their true
 * endpoint heights; a truncated ramp must not be stretched back to 0–1.
 * A y1=1 endpoint is a left-hand limit unless x1=1 (full-scale saturation).
 */
export function residueRamps(bits: readonly number[], stageIndex: number, domain: readonly [number, number]): ResidueRamp[] {
  validateBits(bits);
  validateDomain(domain);
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= bits.length - 1) {
    throw new RangeError('Residue curves are available only before the final flash.');
  }
  const resolvedBits = bits.slice(0, stageIndex + 1).reduce((sum, bit) => sum + bit, 0);
  const levels = 2 ** resolvedBits;
  const first = Math.floor(domain[0] * levels);
  const last = Math.min(levels - 1, Math.ceil(domain[1] * levels) - 1);
  return Array.from({ length: last - first + 1 }, (_, offset) => {
    const bin = first + offset, lower = bin / levels;
    const x0 = Math.max(domain[0], lower), x1 = Math.min(domain[1], (bin + 1) / levels);
    return { x0, x1, y0: (x0 - lower) * levels, y1: (x1 - lower) * levels };
  });
}

/** Complete ADC bin-centre staircase, clipped horizontally to the chosen input domain. */
export function transferSteps(bits: readonly number[], domain: readonly [number, number]): TransferStep[] {
  const totalBits = validateBits(bits);
  validateDomain(domain);
  const levels = 2 ** totalBits;
  const first = Math.floor(domain[0] * levels);
  const last = Math.min(levels - 1, Math.ceil(domain[1] * levels) - 1);
  return Array.from({ length: last - first + 1 }, (_, offset) => {
    const bin = first + offset;
    return { x0: Math.max(domain[0], bin / levels), x1: Math.min(domain[1], (bin + 1) / levels), y: (bin + 0.5) / levels };
  });
}
