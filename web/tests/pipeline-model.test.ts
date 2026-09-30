import { describe, expect, it } from 'vitest';
import { decide, idealCode, simulate, THRESHOLD } from '../src/illustrations/pipeline/model';
import { featuredLessons } from '../src/data/illustrations';
import { isPublicLessonPath } from '../src/data/publication';

describe('1.5-bit pipeline ADC model', () => {
  it('uses the three sub-ADC regions and keeps each residue bounded', () => {
    expect(decide(-THRESHOLD - 1e-6)).toBe(-1);
    expect(decide(-THRESHOLD)).toBe(0);
    expect(decide(0)).toBe(0);
    expect(decide(THRESHOLD)).toBe(0);
    expect(decide(THRESHOLD + 1e-6)).toBe(1);
    for (const input of [-1, -.91, -.25, 0, .24, .8, 1]) {
      const r = simulate(input, 5);
      expect(r.reconstructed).toBeCloseTo(input, 12);
      expect(r.stages.every((s) => s.residue >= -1 && s.residue <= 1)).toBe(true);
    }
  });

  it('adds redundant ternary contributions and the final fine residue', () => {
    const r = simulate(0.37, 4);
    const sum = r.stages.reduce((total, s) => total + s.contribution, 0);
    expect(r.digitalEstimate).toBeCloseTo(sum, 14);
    expect(r.digitalEstimate + r.residueCorrection).toBeCloseTo(r.reconstructed, 14);
    expect(r.code).toBe(10);
    expect(r.levels).toBe(16);
  });

  it('is monotonic in the input and is published as an ADC lesson', () => {
    for (const stages of [3, 4, 5]) {
      let previous = -1;
      for (let i = 0; i <= 100; i++) {
        const code = idealCode(-1 + 2 * i / 100, stages);
        expect(code).toBeGreaterThanOrEqual(previous);
        previous = code;
      }
    }
    const path = '/adc/pipeline-adc/';
    expect(isPublicLessonPath(path)).toBe(true);
    expect(featuredLessons.find((lesson) => lesson.href === path)).toMatchObject({ category: 'ADC', thumb: 'pipeline' });
  });
});

