import { describe, expect, it } from 'vitest';
import { TOPOLOGIES } from '../src/illustrations/pipeline-intro/configurable';
import { linearityDomain } from '../src/illustrations/pipeline-intro/display';
import { analyzeLinearity } from '../src/illustrations/pipeline-intro/errors';

describe('pipeline linearity display contract', () => {
  it.each([[], [0], [-1e-12, 1e-12], [-0.17, 0.31], [-0.5, 0.5]].map(values => ({ values })))('keeps small errors on the same ±0.5 LSB scale: $values', ({ values }) => {
    expect(linearityDomain(values)).toEqual([-0.5, 0.5]);
  });

  it('expands beyond the half-LSB boundary with visible headroom', () => {
    expect(linearityDomain([0.500001])).toEqual([-0.6, 0.6]);
    expect(linearityDomain([-0.500001])).toEqual([-0.6, 0.6]);
    expect(linearityDomain([-1, 0.04])).toEqual([-1.1, 1.1]);
    expect(linearityDomain([-0.3, 2.1])).toEqual([-2.4, 2.4]);
  });

  it.each(TOPOLOGIES)('$id keeps ideal and small multi-stage errors visually comparable', ({ bits }) => {
    const ideal = analyzeLinearity(bits);
    const small = analyzeLinearity(bits, bits.slice(0, -1).map((_, stage) => ({ stage, gainError: stage % 2 ? -0.0001 : 0.0001, nonlinearity: 0.0001 })));
    for (const analysis of [ideal, small]) {
      expect(linearityDomain(analysis.nominalDnl)).toEqual([-0.5, 0.5]);
      expect(linearityDomain(analysis.endpointInl.filter((value): value is number => value !== null))).toEqual([-0.5, 0.5]);
    }
  });

  it('shows large physical DNL/INL without clipping or changing the measurement arrays', () => {
    const analysis = analyzeLinearity([3, 3, 3, 3], [{ stage: 0, gainError: -2, nonlinearity: 1 }, { stage: 2, gainError: 1, nonlinearity: -0.5 }]);
    for (const values of [analysis.nominalDnl, analysis.endpointInl.filter((value): value is number => value !== null)]) {
      const before = [...values], [low, high] = linearityDomain(values);
      expect(low).toBe(-high);
      expect(high).toBeGreaterThan(0.5);
      for (const value of values) {
        expect(value).toBeGreaterThan(low);
        expect(value).toBeLessThan(high);
      }
      expect(values).toEqual(before);
    }
  });
});
