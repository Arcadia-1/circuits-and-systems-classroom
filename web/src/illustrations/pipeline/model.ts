/**
 * A normalized behavioural model of a 1.5-bit/stage pipeline ADC.
 *
 * Each stage makes a ternary decision, subtracts a coarse DAC level, and
 * doubles the remaining residue.  The ternary digits are deliberately kept
 * visible: the digital correction is the sum of those redundant digits, not
 * an opaque integer quantizer.
 */

export type Decision = -1 | 0 | 1;

export interface StageResult {
  index: number;
  input: number;
  decision: Decision;
  decisionLabel: string;
  dac: number;
  residue: number;
  contribution: number;
  low: number;
  high: number;
}

export interface PipelineResult {
  input: number;
  stages: StageResult[];
  finalResidue: number;
  digitalEstimate: number;
  residueCorrection: number;
  reconstructed: number;
  code: number;
  levels: number;
}

/** The 1.5-bit sub-ADC thresholds. The residue stays inside [-1, 1]. */
export const THRESHOLD = 0.25;

export function clampInput(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function decide(residue: number): Decision {
  if (residue < -THRESHOLD) return -1;
  if (residue > THRESHOLD) return 1;
  return 0;
}

export function decisionLabel(decision: Decision): string {
  return decision < 0 ? '−1' : decision > 0 ? '+1' : '0';
}

export function stage(input: number, index: number): StageResult {
  const decision = decide(input);
  const residue = 2 * input - decision;
  return {
    index,
    input,
    decision,
    decisionLabel: decisionLabel(decision),
    dac: decision,
    residue,
    contribution: decision / 2 ** index,
    low: -THRESHOLD,
    high: THRESHOLD,
  };
}

export function simulate(input: number, stageCount = 4): PipelineResult {
  if (!Number.isFinite(input) || !Number.isInteger(stageCount) || stageCount < 1 || stageCount > 8) {
    throw new RangeError('input must be finite and stageCount must be an integer from 1 to 8');
  }
  const clamped = clampInput(input);
  const stages: StageResult[] = [];
  let residue = clamped;
  let digitalEstimate = 0;
  for (let i = 1; i <= stageCount; i++) {
    const result = stage(residue, i);
    stages.push(result);
    digitalEstimate += result.contribution;
    residue = result.residue;
  }
  const residueCorrection = residue / 2 ** stageCount;
  const reconstructed = digitalEstimate + residueCorrection;
  const levels = 2 ** stageCount;
  const code = Math.max(0, Math.min(levels - 1, Math.floor(((reconstructed + 1) / 2) * levels)));
  return { input: clamped, stages, finalResidue: residue, digitalEstimate, residueCorrection, reconstructed, code, levels };
}

export function idealCode(input: number, stageCount: number): number {
  const levels = 2 ** stageCount;
  return Math.max(0, Math.min(levels - 1, Math.floor(((clampInput(input) + 1) / 2) * levels)));
}

