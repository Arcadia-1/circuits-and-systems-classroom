import { convert, RADIX } from './model';

export type ResolutionStages = 1 | 2 | 3;
export type ResidueStage = 1 | 2;

export interface Prefix {
  code: number;
  levels: number;
  lower: number;
  estimate: number;
  error: number;
}

export interface ResidueSegment {
  x0: number;
  x1: number;
  y0: 0;
  y1: 1;
}

export interface TransferSegment {
  x0: number;
  x1: number;
  y: number;
}

/** Input-referred interval resolved by the first one, two, or three stage digits. */
export function prefix(value: number, stages: ResolutionStages): Prefix {
  const conversion = convert(value);
  const code = conversion.stages.slice(0, stages).reduce((sum, stage) => RADIX * sum + stage.digit, 0);
  const levels = RADIX ** stages;
  const estimate = (code + 0.5) / levels;
  return { code, levels, lower: code / levels, estimate, error: estimate - value };
}

/**
 * Residue versus the ORIGINAL input Vin, not versus the local stage input.
 * Draw each ramp separately. Its right endpoint is excluded except at Vin = 1,
 * where saturation retains the final digit and the residue equals 1.
 */
export function residueSegments(stage: ResidueStage): ResidueSegment[] {
  const intervals = RADIX ** stage;
  return Array.from({ length: intervals }, (_, i) => ({ x0: i / intervals, x1: (i + 1) / intervals, y0: 0, y1: 1 }));
}

/** Separate horizontal intervals; centre selects code centres instead of lower edges. */
export function transferSegments(stages: ResolutionStages, centre: boolean): TransferSegment[] {
  const intervals = RADIX ** stages;
  return Array.from({ length: intervals }, (_, i) => {
    const result = prefix((i + 0.5) / intervals, stages);
    return { x0: i / intervals, x1: (i + 1) / intervals, y: centre ? result.estimate : result.lower };
  });
}
