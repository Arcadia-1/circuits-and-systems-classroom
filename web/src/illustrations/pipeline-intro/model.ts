/** Ideal unipolar, three-stage, 2 bits/stage pipeline. Each stage has one clock of latency.
 * The final flash ADC supplies the final two bits; no analog residue is added to the digital output. */
export const STAGES = 3, RADIX = 4, LEVELS = 64;
export interface Stage { input: number; digit: number; dac: number; residue: number }
export function convert(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Input must be in [0, 1] V.');
  let residue = value, code = 0;
  const stages: Stage[] = [];
  for (let j = 0; j < STAGES; j++) {
    const digit = Math.min(3, Math.floor(RADIX * residue)), dac = digit / RADIX;
    stages.push({ input: residue, digit, dac, residue: RADIX * (residue - dac) });
    residue = RADIX * (residue - dac);
    code = RADIX * code + digit;
  }
  return { input: value, stages, code, estimate: (code + 0.5) / LEVELS, error: (code + 0.5) / LEVELS - value };
}
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
