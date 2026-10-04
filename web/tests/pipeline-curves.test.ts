import { describe, expect, it } from 'vitest';
import { convert } from '../src/illustrations/pipeline-intro/model';
import { prefix, residueSegments, transferSegments } from '../src/illustrations/pipeline-intro/curves';

const resolutions = [1, 2, 3] as const;
const residueStages = [1, 2] as const;
const epsilon = 2 ** -24;

describe('pipeline transfer curves', () => {
  it.each(resolutions)('matches independent %i-stage quantization across the full range', (stages) => {
    const levels = 4 ** stages;
    for (let i = 0; i <= 4096; i++) {
      const input = i / 4096;
      const result = prefix(input, stages);
      const expectedCode = Math.min(levels - 1, Math.floor(input * levels));
      expect(result.code).toBe(expectedCode);
      expect(result.levels).toBe(levels);
      expect(result.lower).toBe(expectedCode / levels);
      expect(result.estimate).toBe((expectedCode + 0.5) / levels);
      expect(result.error).toBe(result.estimate - input);
      expect(Math.abs(result.error)).toBeLessThanOrEqual(0.5 / levels);
    }
  });

  it.each(resolutions)('takes the new code at every %i-stage threshold and saturates at full scale', (stages) => {
    const levels = 4 ** stages;
    for (let code = 1; code < levels; code++) {
      const threshold = code / levels;
      expect(prefix(threshold - epsilon, stages).code).toBe(code - 1);
      expect(prefix(threshold, stages).code).toBe(code);
      expect(prefix(threshold + epsilon, stages).code).toBe(code);
    }
    expect(prefix(0, stages)).toMatchObject({ code: 0, lower: 0, estimate: 0.5 / levels });
    expect(prefix(1, stages)).toMatchObject({ code: levels - 1, lower: 1 - 1 / levels, estimate: 1 - 0.5 / levels, error: -0.5 / levels });
  });

  it('keeps the selected example consistent across all three resolutions', () => {
    expect(resolutions.map(stages => prefix(0.68, stages).code)).toEqual([2, 10, 43]);
    expect(resolutions.map(stages => prefix(0.68, stages).estimate)).toEqual([0.625, 0.65625, 0.6796875]);
    expect(prefix(0.68, 3).code).toBe(convert(0.68).code);
  });

  it.each(resolutions)('plots complete %i-stage code intervals with distinct lower-edge and centre meanings', (stages) => {
    const levels = 4 ** stages;
    for (const centre of [false, true]) {
      const segments = transferSegments(stages, centre);
      expect(segments).toHaveLength(levels);
      expect(segments[0].x0).toBe(0);
      expect(segments.at(-1)!.x1).toBe(1);
      segments.forEach((segment, i) => {
        expect(segment.x1 - segment.x0).toBe(1 / levels);
        if (i > 0) expect(segment.x0).toBe(segments[i - 1].x1);
        for (const x of [segment.x0, (segment.x0 + segment.x1) / 2, segment.x1 - epsilon]) {
          const result = prefix(x, stages);
          expect(segment.y).toBe(centre ? result.estimate : result.lower);
        }
      });
      const fullScale = prefix(1, stages);
      expect(segments.at(-1)!.y).toBe(centre ? fullScale.estimate : fullScale.lower);
    }
  });
});

describe('pipeline residue curves against original Vin', () => {
  it.each(residueStages)('reconstructs original input from the %i-stage resolved interval and analog residue', (stage) => {
    for (let i = 0; i <= 4096; i++) {
      const input = i / 4096;
      const residue = convert(input).stages[stage - 1].residue;
      const resolved = prefix(input, stage);
      expect(residue).toBeCloseTo(4 ** stage * (input - resolved.lower), 12);
      expect(residue).toBeGreaterThanOrEqual(0);
      expect(residue).toBeLessThanOrEqual(1);
    }
  });

  it.each(residueStages)('draws the %i-stage ramps on the original-input axis without crossing discontinuities', (stage) => {
    const segments = residueSegments(stage);
    const gain = 4 ** stage;
    expect(segments).toHaveLength(gain);
    expect(segments[0].x0).toBe(0);
    expect(segments.at(-1)!.x1).toBe(1);
    segments.forEach((segment, i) => {
      expect(segment.y0).toBe(0);
      expect(segment.y1).toBe(1);
      expect(segment.x1 - segment.x0).toBe(1 / gain);
      for (const fraction of [0, 0.25, 0.5, 0.75]) {
        const input = segment.x0 + fraction * (segment.x1 - segment.x0);
        expect(convert(input).stages[stage - 1].residue).toBe(fraction);
      }
      if (i > 0) {
        expect(segment.x0).toBe(segments[i - 1].x1);
        expect(convert(segment.x0 - epsilon).stages[stage - 1].residue).toBeCloseTo(1 - gain * epsilon, 12);
        expect(convert(segment.x0).stages[stage - 1].residue).toBe(0);
        expect(convert(segment.x0 + epsilon).stages[stage - 1].residue).toBeCloseTo(gain * epsilon, 12);
      }
    });
    expect(convert(1).stages[stage - 1].residue).toBe(1);
  });
});
