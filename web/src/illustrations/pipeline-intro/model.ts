import { convertPipeline } from './configurable';

/** Ideal unipolar, three-stage, 2 bits/stage pipeline. Each stage has one clock of latency.
 * The final flash ADC supplies the final two bits; no analog residue is added to the digital output. */
export const STAGES = 3, RADIX = 4, LEVELS = 64;
export interface Stage { input: number; digit: number; dac: number; residue: number }
/** The introductory 6-bit preset shares the configurable conversion engine. */
export function convert(value: number) { return convertPipeline(value, [2, 2, 2]); }
export function samples(first: number): number[] { return [first, 0.18, 0.82, 0.37, 0.56, 0.94, 0.07, 0.71]; }
/** Contents just after a rising edge. First sample launches at clock 0; stage 1 completes at clock 1 and its full code at clock 3. */
export function pipelineAt(clock: number, input: number[]) {
  const slots = Array.from({ length: STAGES }, (_, stage) => {
    const sample = clock - 1 - stage;
    return sample >= 0 && sample < input.length ? { sample, stage: convert(input[sample]).stages[stage] } : null;
  });
  const sample = clock - STAGES;
  return { slots, output: sample >= 0 && sample < input.length ? { sample, ...convert(input[sample]) } : null };
}
