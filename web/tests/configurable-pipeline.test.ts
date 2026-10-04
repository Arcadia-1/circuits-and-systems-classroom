import { describe, expect, it } from 'vitest';
import { convertPipeline, inspectionWindow, residueRamps, TOPOLOGIES, transferSteps } from '../src/illustrations/pipeline-intro/configurable';
import { convert } from '../src/illustrations/pipeline-intro/model';

const epsilon = 2 ** -24;

describe('configurable pipeline conversion', () => {
  it.each(TOPOLOGIES)('$id matches direct quantization at every threshold and on both sides', ({ bits }) => {
    const totalBits = bits.reduce((sum, bit) => sum + bit, 0), levels = 2 ** totalBits;
    for (let code = 1; code < levels; code++) {
      const threshold = code / levels;
      expect(convertPipeline(threshold - epsilon, bits).code).toBe(code - 1);
      expect(convertPipeline(threshold, bits).code).toBe(code);
      expect(convertPipeline(threshold + epsilon, bits).code).toBe(code);
    }
    for (let code = 0; code < levels; code++) {
      const centre = (code + 0.5) / levels;
      const result = convertPipeline(centre, bits);
      expect(result.code).toBe(code);
      expect(result.totalBits).toBe(totalBits);
      expect(result.levels).toBe(levels);
      expect(result.estimate).toBe(centre);
      expect(result.error).toBe(0);
    }
  });

  it.each(TOPOLOGIES)('$id saturates at full scale and retains half-LSB error bounds', ({ bits }) => {
    const levels = 2 ** bits.reduce((sum, bit) => sum + bit, 0);
    expect(convertPipeline(0, bits)).toMatchObject({ code: 0, estimate: 0.5 / levels, error: 0.5 / levels });
    const full = convertPipeline(1, bits);
    expect(full).toMatchObject({ code: levels - 1, estimate: 1 - 0.5 / levels, error: -0.5 / levels });
    expect(full.stages.every(stage => stage.digit === stage.gain - 1 && stage.residue === 1 && stage.upper === 1)).toBe(true);
    for (let i = 0; i <= 1000; i++) {
      const input = i / 1000, result = convertPipeline(input, bits);
      expect(result.code).toBe(Math.min(levels - 1, Math.floor(input * levels)));
      expect(Math.abs(result.error)).toBeLessThanOrEqual(0.5 / levels);
    }
  });

  it.each(TOPOLOGIES)('$id preserves the local recurrence and original-input prefix identity', ({ bits }) => {
    for (const input of [0, epsilon, 0.123456789, 0.25 - epsilon, 0.25, 0.5, 0.68, 0.75, 1 - epsilon, 1]) {
      const conversion = convertPipeline(input, bits);
      let prior = input, prefixCode = 0, resolvedBits = 0;
      conversion.stages.forEach((stage, index) => {
        resolvedBits += bits[index];
        const levels = 2 ** resolvedBits;
        expect(stage.index).toBe(index);
        expect(stage.bits).toBe(bits[index]);
        expect(stage.input).toBe(prior);
        expect(stage.gain).toBe(2 ** bits[index]);
        expect(stage.digit).toBeGreaterThanOrEqual(0);
        expect(stage.digit).toBeLessThan(stage.gain);
        expect(stage.dac).toBe(stage.digit / stage.gain);
        expect(stage.residue).toBe(stage.gain * (stage.input - stage.dac));
        expect(stage.residue).toBeGreaterThanOrEqual(0);
        expect(stage.residue).toBeLessThanOrEqual(1);
        prefixCode = prefixCode * stage.gain + stage.digit;
        expect(stage.prefixCode).toBe(prefixCode);
        expect(stage.resolvedBits).toBe(resolvedBits);
        expect(stage.lower).toBe(Math.min(levels - 1, Math.floor(input * levels)) / levels);
        expect(stage.upper - stage.lower).toBe(1 / levels);
        expect(stage.residue).toBeCloseTo(levels * (input - stage.lower), 10);
        expect(stage.lower + stage.residue / levels).toBeCloseTo(input, 14);
        prior = stage.residue;
      });
      expect(conversion.code).toBe(prefixCode);
    }
  });

  it('changing the stage allocation leaves every 12-bit code and estimate unchanged', () => {
    const architectures = TOPOLOGIES.filter(topology => topology.id !== 'intro');
    for (let i = 0; i <= 4096; i++) {
      const input = i / 4096;
      const conversions = architectures.map(topology => convertPipeline(input, topology.bits));
      expect(conversions.map(result => result.code)).toEqual(Array(3).fill(Math.min(i, 4095)));
      expect(conversions.map(result => result.estimate)).toEqual(Array(3).fill((Math.min(i, 4095) + 0.5) / 4096));
    }
  });

  it('retains the introductory 6-bit model and supports the allowed topology limits', () => {
    for (const input of [0, 0.18, 0.5, 0.68, 0.82, 1]) {
      const old = convert(input), current = convertPipeline(input, [2, 2, 2]);
      expect(current).toMatchObject({ code: old.code, estimate: old.estimate, error: old.error });
      expect(current.stages.map(stage => stage.residue)).toEqual(old.stages.map(stage => stage.residue));
    }
    expect(convertPipeline(0.68, [1, 1]).totalBits).toBe(2);
    expect(convertPipeline(0.68, Array(12).fill(1)).totalBits).toBe(12);
    expect(convertPipeline(1, [4, 4, 4, 4]).code).toBe(65535);
  });

  it('rejects out-of-range inputs and unsupported or malformed stage allocations', () => {
    for (const input of [-epsilon, 1 + epsilon, NaN, Infinity, -Infinity]) expect(() => convertPipeline(input, [2, 2, 2])).toThrow(RangeError);
    const invalid = [[], [2], Array(2), Array(13).fill(1), [0, 2], [-1, 2], [1.5, 2], [NaN, 2], [Infinity, 2], [5, 2], [4, 4, 4, 4, 1]];
    for (const bits of invalid) {
      expect(() => convertPipeline(0.5, bits)).toThrow(RangeError);
      expect(() => residueRamps(bits, 0, [0, 1])).toThrow(RangeError);
      expect(() => transferSteps(bits, [0, 1])).toThrow(RangeError);
    }
  });
});

describe('pipeline inspection curves', () => {
  it.each(TOPOLOGIES)('$id selects a prefix before two adjacent physical residue stages', ({ bits }) => {
    for (const input of [0, 0.68, 1]) {
      const conversion = convertPipeline(input, bits);
      for (let first = 0; first <= bits.length - 3; first++) {
        const domain = inspectionWindow(conversion, first);
        const beforeBits = bits.slice(0, first).reduce((sum, bit) => sum + bit, 0);
        expect(domain[1] - domain[0]).toBe(2 ** -beforeBits);
        expect(input).toBeGreaterThanOrEqual(domain[0]);
        expect(input).toBeLessThanOrEqual(domain[1]);
        expect(domain).toEqual(first === 0 ? [0, 1] : [conversion.stages[first - 1].lower, conversion.stages[first - 1].upper]);
        const firstRamps = residueRamps(bits, first, domain), nextRamps = residueRamps(bits, first + 1, domain);
        expect(firstRamps).toHaveLength(2 ** bits[first]);
        expect(nextRamps).toHaveLength(2 ** (bits[first] + bits[first + 1]));
        expect([...firstRamps, ...nextRamps].every(ramp => ramp.y0 === 0 && ramp.y1 === 1)).toBe(true);
        expect(transferSteps(bits, domain)).toHaveLength(2 ** (conversion.totalBits - beforeBits));
      }
    }
  });

  it.each(TOPOLOGIES)('$id curve segments agree with conversions, including every residue reset', ({ bits }) => {
    for (let stageIndex = 0; stageIndex < bits.length - 1; stageIndex++) {
      const ramps = residueRamps(bits, stageIndex, [0, 1]);
      ramps.forEach((ramp, index) => {
        const width = ramp.x1 - ramp.x0;
        expect(ramp.y0).toBe(0);
        expect(ramp.y1).toBe(1);
        expect(convertPipeline(ramp.x0, bits).stages[stageIndex].residue).toBe(0);
        expect(convertPipeline(ramp.x0 + width / 2, bits).stages[stageIndex].residue).toBe(0.5);
        expect(convertPipeline(ramp.x1 - epsilon, bits).stages[stageIndex].residue).toBeCloseTo(1 - epsilon / width, 10);
        if (index < ramps.length - 1) expect(convertPipeline(ramp.x1, bits).stages[stageIndex].residue).toBe(0);
        else expect(convertPipeline(ramp.x1, bits).stages[stageIndex].residue).toBe(1);
      });
    }
    const steps = transferSteps(bits, [0, 1]);
    steps.forEach(step => {
      expect(convertPipeline(step.x0, bits).estimate).toBe(step.y);
      expect(convertPipeline((step.x0 + step.x1) / 2, bits).estimate).toBe(step.y);
      expect(convertPipeline(step.x1 - epsilon, bits).estimate).toBe(step.y);
    });
    expect(steps.at(-1)!.y).toBe(convertPipeline(1, bits).estimate);
  });

  it('clips arbitrary zoom windows without changing residue slope or staircase levels', () => {
    const bits = [2, 2, 2];
    const ramps = residueRamps(bits, 0, [0.1, 0.4]);
    expect(ramps).toHaveLength(2);
    expect(ramps[0]).toMatchObject({ x0: 0.1, x1: 0.25, y1: 1 });
    expect(ramps[0].y0).toBeCloseTo(0.4, 14);
    expect(ramps[1]).toMatchObject({ x0: 0.25, x1: 0.4, y0: 0 });
    expect(ramps[1].y1).toBeCloseTo(0.6, 14);
    for (const ramp of ramps) {
      expect((ramp.y1 - ramp.y0) / (ramp.x1 - ramp.x0)).toBeCloseTo(4, 14);
      expect(ramp.y0).toBeCloseTo(convertPipeline(ramp.x0, bits).stages[0].residue, 14);
    }
    const steps = transferSteps(bits, [0.1, 0.4]);
    expect(steps[0].x0).toBe(0.1);
    expect(steps.at(-1)!.x1).toBe(0.4);
    expect(steps[0].y).toBe(convertPipeline(0.1, bits).estimate);
    expect(steps.at(-1)!.y).toBe(convertPipeline(0.4, bits).estimate);
    expect(transferSteps(bits, [0.25, 0.5])).toHaveLength(16);
    expect(residueRamps(bits, 0, [0.25, 0.5])).toEqual([{ x0: 0.25, x1: 0.5, y0: 0, y1: 1 }]);
  });

  it('rejects a final-flash residue, invalid adjacent pairs, and invalid domains', () => {
    const bits = [2, 2, 2], result = convertPipeline(0.68, bits);
    for (const index of [-1, 0.5, 2, 3, NaN]) expect(() => residueRamps(bits, index, [0, 1])).toThrow(RangeError);
    for (const index of [-1, 0.5, 1, 2, NaN]) expect(() => inspectionWindow(result, index)).toThrow(RangeError);
    expect(() => inspectionWindow(convertPipeline(0.5, [2, 2]), 0)).toThrow(RangeError);
    const invalid: [number, number][] = [[0, 0], [1, 1], [0.5, 0.25], [-0.1, 1], [0, 1.1], [NaN, 1], [0, Infinity]];
    for (const domain of invalid) {
      expect(() => residueRamps(bits, 0, domain)).toThrow(RangeError);
      expect(() => transferSteps(bits, domain)).toThrow(RangeError);
    }
  });
});
