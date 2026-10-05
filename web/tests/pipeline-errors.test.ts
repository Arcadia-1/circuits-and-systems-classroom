import { describe, expect, it } from 'vitest';
import { convertPipeline, TOPOLOGIES } from '../src/illustrations/pipeline-intro/configurable';
import { actualResidueCurves, analyzeLinearity, convertWithErrors, DEFAULT_ERRORS, evaluateStage, normalizeErrorSettings, type ErrorSettings, type PipelineErrorSettings } from '../src/illustrations/pipeline-intro/errors';

const settings = (gainError = 0, nonlinearity = 0, stage = 0): ErrorSettings => ({ stage, gainError, nonlinearity });

/** Search the complete forward converter: independent of threshold back-propagation. */
function crossing(bits: readonly number[], errors: PipelineErrorSettings, code: number): number {
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 46; iteration++) {
    const middle = (low + high) / 2;
    if (convertWithErrors(middle, bits, errors).code < code) low = middle;
    else high = middle;
  }
  return high;
}

describe('actual pipeline amplifier errors', () => {
  it.each(TOPOLOGIES)('$id reduces exactly to the ideal converter and uniform transitions with errors off', ({ bits }) => {
    const a = analyzeLinearity(bits, DEFAULT_ERRORS);
    expect(a.thresholds).toEqual(Array.from({ length: a.levels + 1 }, (_, k) => k / a.levels));
    expect(a.nominalDnl.every(value => value === 0)).toBe(true);
    expect(a.nominalInl.every(value => value === null || value === 0)).toBe(true);
    expect(a.endpointInl.every(value => value === null || value === 0)).toBe(true);
    expect(a.missingCodes).toEqual([]);
    expect(a.monotonic).toBe(true);
    for (const input of [0, 0.123456789, 0.25, 0.68, 0.9, 1]) {
      const ideal = convertPipeline(input, bits), actual = convertWithErrors(input, bits, DEFAULT_ERRORS);
      expect(actual).toMatchObject({ code: ideal.code, estimate: ideal.estimate, error: ideal.error });
      expect(actual.stages.map(stage => stage.residue)).toEqual(ideal.stages.map(stage => stage.residue));
    }
  });

  it('applies the stated gain and cubic terms only to the selected amplifier', () => {
    const s = settings(0.5, 2, 1), r = convertWithErrors(0.68, [2, 2, 2], s);
    expect(r.stages[0].residue).toBeCloseTo(0.72, 12);
    expect(r.stages[1].idealResidue).toBeCloseTo(0.88, 12);
    const x = r.stages[1].idealResidue;
    expect(r.stages[1].residue).toBeCloseTo(1.005 * x + 0.08 * x * (1 - x) * (2 * x - 1), 12);
    expect(r.stages.map(stage => stage.injected)).toEqual([false, true, false]);
    const overrange = convertWithErrors(1, [1, 1, 3], settings(5));
    expect(overrange.stages[0].residue).toBe(1.05);
    expect(overrange.stages[1].residue).toBeCloseTo(1.1, 12);
    expect(overrange.stages[2].digit).toBe(7);
    expect(overrange.stages[2].residue).toBeGreaterThan(1);
  });

  it('has an independent analytical gain-only transition solution', () => {
    const bits = [1, 1, 1, 1, 1, 1, 1, 1, 1, 3], a = analyzeLinearity(bits, settings(0.5));
    const suffix = 2048, prefix = 2;
    for (let k = 1; k < a.levels; k++) {
      const expected = (Math.floor(k / suffix) + (k % suffix) / (suffix * 1.005)) / prefix;
      expect(a.thresholds[k]).toBeCloseTo(expected, 14);
    }
    expect(a.nominalDnl[0]).toBeCloseTo(1 / 1.005 - 1, 12);
    expect(a.nominalDnl[suffix - 1]).toBeGreaterThan(10);
    expect(a.missingCodes).toEqual([]);
  });

  it.each([settings(0.5, 0), settings(-0.5, 0), settings(0, 5), settings(0, -5), settings(-5, 5), settings(5, -5)])('solves crossings of the actual converter for %j', s => {
    const bits = [3, 3, 3, 3], a = analyzeLinearity(bits, s);
    const highest = convertWithErrors(1, bits, s).code;
    // Independent binary search on the complete converter, not the amplifier inverse.
    for (let code = 1; code < a.levels; code += 13) {
      let low = 0, high = 1;
      for (let iteration = 0; iteration < 46; iteration++) {
        const middle = (low + high) / 2;
        if (convertWithErrors(middle, bits, s).code < code) low = middle;
        else high = middle;
      }
      expect(a.thresholds[code]).toBeCloseTo(high, 11);
      expect(a.transitionValid[code]).toBe(code <= highest);
    }
    expect(a.widths.every(width => width >= 0)).toBe(true);
    expect(a.widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(1, 14);
    expect(a.minimumDerivative).toBeGreaterThanOrEqual(0.75);
    expect(a.monotonic).toBe(true);
  });

  it('missing codes have zero width, DNL −1, and are skipped without any reversal', () => {
    const bits = [1, 1, 1, 1, 1, 1, 1, 1, 1, 3], s = settings(-0.5), a = analyzeLinearity(bits, s);
    expect(a.missingCodes.length).toBeGreaterThan(0);
    for (const code of a.missingCodes) {
      expect(a.widths[code]).toBe(0);
      expect(a.nominalDnl[code]).toBe(-1);
    }
    let previous = -1;
    for (let i = 0; i <= 16384; i++) {
      const code = convertWithErrors(i / 16384, bits, s).code;
      expect(code).toBeGreaterThanOrEqual(previous);
      previous = code;
    }
    expect(a.transitionValid[4095]).toBe(false);
    expect(a.nominalInl[4095]).toBe(null);
    expect(a.endpointInl[4095]).toBe(null);
    expect(a.endpointCodes?.[1]).toBe(convertWithErrors(1, bits, s).code);
    expect(a.endpointValid).toBe(true);
  });

  it('fits measured-range endpoint INL through actual observed code indices', () => {
    const a = analyzeLinearity([3, 3, 3, 3], settings(-2, 3));
    const [first, last] = a.endpointCodes!;
    expect(a.fittedLsb).toBe((a.thresholds[last] - a.thresholds[first]) / (last - first));
    expect(a.endpointInl[first]).toBeCloseTo(0, 12);
    expect(a.endpointInl[last]).toBeCloseTo(0, 12);
    expect(a.endpointDnl[0]).toBe(null);
    expect(a.endpointDnl.at(-1)).toBe(null);
    for (let k = first; k < last; k++) {
      expect(a.endpointDnl[k]).toBeCloseTo(a.endpointInl[k + 1]! - a.endpointInl[k]!, 8);
    }
  });

  it('agrees with an independent uniform-input code histogram', () => {
    const bits = [2, 2, 2], s = settings(-3, 4), a = analyzeLinearity(bits, s), count = 65536;
    const histogram = Array(64).fill(0) as number[];
    for (let i = 0; i < count; i++) histogram[convertWithErrors((i + 0.5) / count, bits, s).code]++;
    a.widths.forEach((width, code) => expect(Math.abs(histogram[code] / count - width)).toBeLessThanOrEqual(1 / count));
  });

  it('changes local ripple when the injection stage changes while keeping ideal upstream stages intact', () => {
    const bits = [3, 3, 3, 3], early = analyzeLinearity(bits, settings(1, 2, 0)), late = analyzeLinearity(bits, settings(1, 2, 2));
    expect(early.nominalDnl).not.toEqual(late.nominalDnl);
    for (const input of [0.123, 0.68, 0.999]) {
      const actual = convertWithErrors(input, bits, settings(1, 2, 2)), ideal = convertPipeline(input, bits);
      expect(actual.stages.slice(0, 2).map(stage => stage.residue)).toEqual(ideal.stages.slice(0, 2).map(stage => stage.residue));
    }
  });
});

describe('independent simultaneous errors in every pipeline amplifier', () => {
  it('normalizes sparse, unordered settings without mutating them or changing the legacy single-stage result', () => {
    const bits = [3, 3, 3, 3], sparse = [settings(-0.1, 0.2, 2), settings(0.25, -0.15, 0)];
    const saved = structuredClone(sparse);
    expect(normalizeErrorSettings(bits, sparse)).toEqual([sparse[1], settings(0, 0, 1), sparse[0]]);
    expect(sparse).toEqual(saved);
    const legacy = settings(-0.5, 2, 1);
    expect(analyzeLinearity(bits, [legacy])).toEqual(analyzeLinearity(bits, legacy));
    expect(convertWithErrors(0.68, bits, [legacy])).toEqual(convertWithErrors(0.68, bits, legacy));
    const ideal = analyzeLinearity(bits, []);
    expect(ideal.nominalDnl.every(value => value === 0)).toBe(true);
    expect(ideal.endpointInl.every(value => value === null || value === 0)).toBe(true);
    expect(() => analyzeLinearity(bits, [legacy, legacy])).toThrow(RangeError);
    expect(() => analyzeLinearity(bits, [legacy, settings(0, 0, 3)])).toThrow(RangeError);
  });

  it('propagates the first amplifier error into the separately distorted second amplifier', () => {
    const errors = [settings(0.25, -0.2), settings(-0.1, 0.15, 1)];
    const trace = convertWithErrors(0.68, [2, 2, 2], errors);
    const r0 = 0.72, y0 = 1.0025 * r0 - 0.008 * r0 * (1 - r0) * (2 * r0 - 1);
    const r1 = 4 * y0 - 2, y1 = 0.999 * r1 + 0.006 * r1 * (1 - r1) * (2 * r1 - 1);
    expect(trace.stages[0].residue).toBeCloseTo(y0, 14);
    expect(trace.stages[1].input).toBeCloseTo(y0, 14);
    expect(trace.stages[1].residue).toBeCloseTo(y1, 14);
    expect(trace.stages.map(stage => stage.injected)).toEqual([true, true, false]);
  });

  it.each(TOPOLOGIES)('$id solves cumulative crossings independently for mixed UI errors and full supported coefficients', ({ bits }) => {
    for (const [gain, cubic] of [[0.25, -0.2], [-0.25, 0.25], [5, 5], [-5, -5]]) {
      const errors = bits.slice(0, -1).map((_, stage) => settings(stage % 2 ? -gain : gain, stage % 3 ? -cubic : cubic, stage));
      const a = analyzeLinearity(bits, errors), highest = convertWithErrors(1, bits, errors).code;
      const stride = Math.max(1, Math.floor(a.levels / 97));
      const codes = new Set([1, a.levels - 1, ...Array.from({ length: Math.ceil((a.levels - 1) / stride) }, (_, index) => 1 + index * stride)]);
      for (const code of codes) {
        expect(a.thresholds[code]).toBeCloseTo(crossing(bits, errors, code), 11);
        expect(a.transitionValid[code]).toBe(code <= highest);
      }
      expect(a.monotonic).toBe(true);
      expect(a.minimumDerivative).toBeGreaterThanOrEqual(0.75);
      expect(a.widths.every(width => width >= 0)).toBe(true);
      expect(a.widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(1, 14);
      for (const code of a.missingCodes) expect(a.nominalDnl[code]).toBe(-1);
    }
  });

  it('retains a suffix crossing above 1 V that an upstream over-gain amplifier can reach', () => {
    const bits = [1, 1, 1, 4], errors = [settings(5), settings(-5, 0, 1)];
    const a = analyzeLinearity(bits, errors);
    const downstreamCrossing = (1 + (31 / 32) / 0.95) / 2;
    expect(downstreamCrossing).toBeGreaterThan(1);
    const expected = downstreamCrossing / (2 * 1.05);
    expect(a.thresholds[63]).toBeCloseTo(expected, 14);
    expect(convertWithErrors(expected - 1e-10, bits, errors).code).toBe(62);
    expect(convertWithErrors(expected + 1e-10, bits, errors).code).toBe(63);
  });

  it('keeps the overrange amplifier law continuous, with matching positive endpoint slopes and no clipping', () => {
    const errors = settings(-5, 5), h = 1e-7;
    const f = (r: number) => evaluateStage(r / 2, 1, errors, 0).residue;
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(0.95);
    for (const endpoint of [0, 1]) {
      expect((f(endpoint) - f(endpoint - h)) / h).toBeCloseTo(0.75, 6);
      expect((f(endpoint + h) - f(endpoint)) / h).toBeCloseTo(0.75, 6);
    }
    expect(f(100)).toBeCloseTo(0.95 + 0.75 * 99, 12);
    expect(f(-1)).toBe(-0.75);
    const bits = TOPOLOGIES[0].bits;
    const all = bits.slice(0, -1).map((_, stage) => settings(5, 5, stage));
    const overrange = convertWithErrors(1, bits, all);
    expect(overrange.stages[8].residue).toBeGreaterThan(1);
    let previous = -1;
    for (let i = 0; i <= 8192; i++) {
      const code = convertWithErrors(i / 8192, bits, all).code;
      expect(code).toBeGreaterThanOrEqual(previous);
      previous = code;
    }
  });

  it('agrees with an independent uniform-input histogram when two nonlinear amplifiers act together', () => {
    const bits = [2, 2, 2], errors = [settings(4, -3), settings(-5, 4, 1)], count = 65536;
    const a = analyzeLinearity(bits, errors), histogram = Array(64).fill(0) as number[];
    for (let i = 0; i < count; i++) histogram[convertWithErrors((i + 0.5) / count, bits, errors).code]++;
    a.widths.forEach((width, code) => expect(Math.abs(histogram[code] / count - width)).toBeLessThanOrEqual(1 / count));
  });

  it('uses all stages when drawing residue branches and checking stale analysis', () => {
    const bits = [2, 2, 2], errors = [settings(0.25, -0.1), settings(-0.2, 0.25, 1)];
    const a = analyzeLinearity(bits, errors), curves = actualResidueCurves(bits, [...errors].reverse(), a, 1, [0, 1]);
    for (const curve of curves) for (const point of curve.slice(1, -1)) {
      expect(point.y).toBe(convertWithErrors(point.x, bits, errors).stages[1].residue);
    }
    expect(() => actualResidueCurves(bits, [errors[0]], a, 1, [0, 1])).toThrow(RangeError);
  });
});

describe('actual residue plotting branches', () => {
  it('separates resets at actual transitions and retains overrange analog values', () => {
    const bits = [2, 2, 2], s = settings(5, 2), a = analyzeLinearity(bits, s);
    const curves = actualResidueCurves(bits, s, a, 1, [0, 1]);
    expect(curves).toHaveLength(16);
    for (const curve of curves) {
      expect(curve).toHaveLength(17);
      for (const point of curve.slice(1, -1)) expect(point.y).toBe(convertWithErrors(point.x, bits, s).stages[1].residue);
    }
    expect(curves.some(curve => curve.at(-1)!.y > 1.1)).toBe(true);
    expect(curves.at(-1)!.at(-1)!.y).toBe(convertWithErrors(1, bits, s).stages[1].residue);
    expect(curves[0].at(-1)!.x).toBe(a.thresholds[4]);
    expect(curves[1][0].x).toBe(a.thresholds[4]);
    expect(curves[0].at(-1)!.y).toBeGreaterThan(0.99);
    expect(curves[1][0].y).toBeLessThan(0.01);
  });

  it('clips plots to arbitrary domains without inserting artificial resets', () => {
    const bits = [2, 2, 2], s = settings(2, -3), a = analyzeLinearity(bits, s);
    const curves = actualResidueCurves(bits, s, a, 0, [0.1, 0.4]);
    expect(curves).toHaveLength(2);
    expect(curves[0][0]).toEqual({ x: 0.1, y: convertWithErrors(0.1, bits, s).stages[0].residue });
    expect(curves.at(-1)!.at(-1)!).toEqual({ x: 0.4, y: convertWithErrors(0.4, bits, s).stages[0].residue });
  });

  it('rejects stale analyses, final-flash error injection, and unsupported coefficients', () => {
    const bits = [2, 2, 2], s = settings(), a = analyzeLinearity(bits, s);
    for (const invalid of [settings(5.1), settings(0, -5.1), settings(NaN), settings(0, Infinity), settings(0, 0, 2), settings(0, 0, -1)]) {
      expect(() => analyzeLinearity(bits, invalid)).toThrow(RangeError);
      expect(() => convertWithErrors(0.5, bits, invalid)).toThrow(RangeError);
    }
    expect(() => actualResidueCurves(bits, settings(1), a, 0, [0, 1])).toThrow(RangeError);
    expect(() => actualResidueCurves(bits, s, a, 2, [0, 1])).toThrow(RangeError);
    expect(() => actualResidueCurves(bits, s, a, 0, [0.5, 0.5])).toThrow(RangeError);
  });
});
