import { describe, expect, it } from 'vitest';
import { TOPOLOGIES } from '../src/illustrations/pipeline-intro/configurable';
import { convertWithErrors, DEFAULT_ERRORS, evaluateStage, type ErrorSettings } from '../src/illustrations/pipeline-intro/errors';
import { localStageCurves } from '../src/illustrations/pipeline-intro/stage-curves';

describe('local transfer characteristics of every pipeline stage', () => {
  it.each(TOPOLOGIES)('$id displays all local stages and the final flash in its own units', ({ bits }) => {
    const curves = localStageCurves(bits, DEFAULT_ERRORS);
    expect(curves).toHaveLength(bits.length);
    curves.forEach((curve, index) => {
      const gain = 2 ** bits[index];
      expect(curve).toMatchObject({ stage: index, bits: bits[index], gain, flash: index === bits.length - 1, xDomain: [0, 1], inputRange: [0, 1] });
      expect(curve.actual).toEqual(curve.ideal);
      // A local b-bit stage always has 2^b branches, not 2^(all preceding bits).
      expect(curve.actual).toHaveLength(gain);
      expect(curve.yDomain).toEqual(curve.flash ? [0, gain - 1] : [0, 1]);
      curve.actual.forEach((branch, digit) => {
        expect(branch[0].x).toBe(digit / gain);
        expect(branch.at(-1)!.x).toBe((digit + 1) / gain);
        if (curve.flash) {
          expect(branch.every(point => point.y === digit)).toBe(true);
        } else {
          expect(branch[0].y).toBe(0);
          expect(branch.at(-1)!.y).toBe(1);
        }
      });
    });
  });

  it('has exact one-sided reset endpoints while normal conversion takes the new digit', () => {
    const bits = [2, 2, 2], s: ErrorSettings = { stage: 0, gainError: 2, nonlinearity: 3 };
    const first = localStageCurves(bits, s)[0];
    for (let digit = 0; digit < 3; digit++) {
      const leftLimit = first.actual[digit].at(-1)!;
      const rightValue = first.actual[digit + 1][0];
      expect(leftLimit.x).toBe(rightValue.x);
      expect(leftLimit.y).toBe(1.02);
      expect(rightValue.y).toBe(0);
      expect(convertWithErrors(leftLimit.x, bits, s).stages[0].residue).toBe(0);
    }
    expect(first.actual.at(-1)!.at(-1)!).toEqual({ x: 1, y: 1.02 });
    expect(convertWithErrors(1, bits, s).stages[0].residue).toBe(1.02);
  });

  it('shares the injected cubic law with conversion and leaves other local characteristics ideal', () => {
    const bits = [3, 3, 3, 3], s: ErrorSettings = { stage: 1, gainError: -1, nonlinearity: 4 };
    const curves = localStageCurves(bits, s);
    expect(curves[1].actual).not.toEqual(curves[1].ideal);
    for (const index of [0, 2, 3]) expect(curves[index].actual).toEqual(curves[index].ideal);
    for (const branch of curves[1].actual) {
      for (const point of branch.slice(1, -1)) {
        // Earlier stages are ideal, so first-prefix Vin=u/8 reaches local u.
        const trace = convertWithErrors(point.x / 8, bits, s);
        expect(trace.stages[1].input).toBe(point.x);
        expect(trace.stages[1].residue).toBe(point.y);
      }
    }
  });

  it('propagates reachable overrange without clipping analog stage inputs or outputs', () => {
    const bits = TOPOLOGIES[0].bits, s: ErrorSettings = { stage: 0, gainError: 5, nonlinearity: 0 };
    const curves = localStageCurves(bits, s), fullScale = convertWithErrors(1, bits, s);
    expect(curves[0].outputRange[1]).toBe(1.05);
    expect(curves[1].inputRange[1]).toBe(1.05);
    expect(curves[1].outputRange[1]).toBeCloseTo(1.1, 12);
    expect(curves[8].outputRange[1]).toBeCloseTo(13.8, 10);
    expect(curves[9].xDomain[1]).toBeCloseTo(13.8, 10);
    expect(curves[9].yDomain).toEqual([0, 7]);
    curves.forEach((curve, index) => {
      expect(curve.xDomain[1]).toBe(fullScale.stages[index].input);
      const value = curve.flash ? fullScale.stages[index].digit : fullScale.stages[index].residue;
      expect(curve.outputRange[1]).toBe(value);
      expect(curve.yDomain[1]).toBeGreaterThanOrEqual(value);
      expect(curve.actual.at(-1)!.at(-1)!).toEqual({ x: curve.xDomain[1], y: value });
    });
  });

  it('draws the full nominal local law after under-gain without mistaking one input sample for the reachable maximum', () => {
    const bits = [1, 1, 1, 3], s: ErrorSettings = { stage: 0, gainError: -5, nonlinearity: 0 };
    const curves = localStageCurves(bits, s);
    expect(curves[0].outputRange).toEqual([0, 0.95]);
    expect(curves[1].inputRange).toEqual([0, 0.95]);
    expect(curves[1].xDomain).toEqual([0, 1]);
    expect(curves[1].outputRange).toEqual([0, 1]);
    expect(convertWithErrors(1, bits, s).stages[1].residue).toBeCloseTo(0.9, 12);
    const inputNearLowerReset = (0.5 - 1e-9) / 0.95 / 2;
    expect(convertWithErrors(inputNearLowerReset, bits, s).stages[1].residue).toBeGreaterThan(0.999999);
    expect(curves[1].actual).toEqual(curves[1].ideal);
  });

  it.each(TOPOLOGIES)('$id keeps every moving marker inside both reachable envelopes and displayed domains', ({ bits }) => {
    for (const stage of [0, bits.length - 2]) for (const gainError of [-5, 0, 5]) {
      const s: ErrorSettings = { stage, gainError, nonlinearity: gainError < 0 ? 5 : -5 };
      const curves = localStageCurves(bits, s);
      for (let i = 0; i <= 1024; i++) {
        const conversion = convertWithErrors(i / 1024, bits, s);
        curves.forEach((curve, index) => {
          const local = conversion.stages[index], output = curve.flash ? local.digit : local.residue;
          expect(local.input).toBeGreaterThanOrEqual(curve.inputRange[0]);
          expect(local.input).toBeLessThanOrEqual(curve.inputRange[1]);
          expect(local.input).toBeLessThanOrEqual(curve.xDomain[1]);
          expect(output).toBeGreaterThanOrEqual(curve.outputRange[0]);
          expect(output).toBeLessThanOrEqual(curve.outputRange[1]);
          expect(output).toBeLessThanOrEqual(curve.yDomain[1]);
        });
      }
    }
  });

  it('the shared stage law saturates only digital decisions, including the flash upper endpoint', () => {
    expect(evaluateStage(1, 3)).toMatchObject({ digit: 7, dac: 0.875, residue: 1 });
    expect(evaluateStage(1.2, 3)).toMatchObject({ digit: 7, dac: 0.875 });
    expect(evaluateStage(1.2, 3).residue).toBeGreaterThan(1);
    expect(evaluateStage(-0.1, 3).digit).toBe(0);
    expect(evaluateStage(-0.1, 3).residue).toBeLessThan(0);
  });

  it('uses the same topology and coefficient validation as conversion', () => {
    expect(() => localStageCurves([0, 2, 2])).toThrow(RangeError);
    expect(() => localStageCurves([2, 2, 2], { stage: 2, gainError: 0, nonlinearity: 0 })).toThrow(RangeError);
    expect(() => localStageCurves([2, 2, 2], { stage: 0, gainError: 6, nonlinearity: 0 })).toThrow(RangeError);
  });

  it.each(TOPOLOGIES)('$id envelopes every reachable stage when errors accumulate through all amplifiers', ({ bits }) => {
    for (const sign of [-1, 1]) {
      const errors = bits.slice(0, -1).map((_, stage) => ({ stage, gainError: sign * 5, nonlinearity: stage % 2 ? -5 : 5 }));
      const curves = localStageCurves(bits, errors);
      for (let sample = 0; sample <= 512; sample++) {
        const trace = convertWithErrors(sample / 512, bits, errors);
        curves.forEach((curve, stage) => {
          const local = trace.stages[stage], output = curve.flash ? local.digit : local.residue;
          expect(local.input).toBeGreaterThanOrEqual(curve.inputRange[0]);
          expect(local.input).toBeLessThanOrEqual(curve.inputRange[1]);
          expect(output).toBeGreaterThanOrEqual(curve.outputRange[0]);
          expect(output).toBeLessThanOrEqual(curve.outputRange[1]);
          expect(output).toBeLessThanOrEqual(curve.yDomain[1]);
        });
      }
    }
  });
});
