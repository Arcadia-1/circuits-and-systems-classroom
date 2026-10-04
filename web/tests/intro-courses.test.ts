import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULTS as PLL, simulate, gains, canLock, DT, KICK_AT, type PllSettings } from '../src/illustrations/pll-intro/model';
import { convert, pipelineAt, samples, LEVELS } from '../src/illustrations/pipeline-intro/model';
import { DEFAULTS as ADC, TRAINING, adc, fitInverse, validate, minimumSlope, correct, type Device, type Training } from '../src/illustrations/nonlinear-calibration/model';

const rows = (file: string) => readFileSync(new URL(`../python/expected/${file}.txt`, import.meta.url), 'utf8').trim().split('\n').slice(1).map(s => s.split(/\s+/));

describe('PLL introduction', () => {
  const cases: Record<string, Partial<PllSettings>> = { lock: {}, p_only: { integral: false }, ringing: { damping: .2 }, phase_step: { kick: true }, unreachable: { divider: 6 }, open: { closed: false } };
  it.each(rows('pll_introduction'))('agrees with fine-step NumPy integration: %s', (name, frequency, error, control) => {
    const point = simulate({ ...PLL, ...cases[name] }).at(-1)!;
    expect(point.frequency).toBeCloseTo(Number(frequency), 5);
    expect(point.error).toBeCloseTo(Number(error), name === 'unreachable' ? 2 : 5);
    expect(point.control).toBeCloseTo(Number(control), 5);
  });
  it('integral control removes steady phase error while P-only retains its analytical offset', () => {
    const end = simulate(PLL).at(-1)!;
    expect(Math.abs(end.error)).toBeLessThan(1e-5);
    expect(end.control).toBeCloseTo((PLL.refMHz * PLL.divider - PLL.freeMHz) / PLL.kvco, 6);
    const pOnly = simulate({ ...PLL, integral: false }).at(-1)!;
    expect(pOnly.error).toBeCloseTo((PLL.refMHz * PLL.divider - PLL.freeMHz) / (PLL.kvco * gains(PLL).kp), 8);
  });
  it('cannot tune beyond the VCO control range', () => {
    const s = { ...PLL, divider: 6 };
    expect(canLock(s)).toBe(false);
    const data = simulate(s);
    expect(data.every(p => Math.abs(p.control) <= 1)).toBe(true);
    expect(data.at(-1)!.frequency).toBe(48);
    expect(data.at(-1)!.error).toBeGreaterThan(100);
  });
  it('a reference phase step changes error without an instantaneous VCO phase jump', () => {
    const a = simulate(PLL), b = simulate({ ...PLL, kick: true }), i = Math.round(KICK_AT / DT);
    expect(b[i].error - a[i].error).toBeCloseTo(Math.PI / 4, 10);
    expect(b[i].feedbackPhase).toBeCloseTo(a[i].feedbackPhase, 10);
    expect(Math.abs(b.at(-1)!.error)).toBeLessThan(.001);
  });
});

describe('pipeline introduction', () => {
  it.each(rows('pipeline_introduction'))('matches direct quantization: input %s', (x, code, digits, estimate, error) => {
    const r = convert(Number(x));
    expect(r.code).toBe(Number(code));
    expect(r.stages.map(s => s.digit).join('')).toBe(digits);
    expect(r.estimate).toBeCloseTo(Number(estimate), 9);
    expect(r.error * LEVELS).toBeCloseTo(Number(error), 6);
  });
  it('all inputs retain bounded residues and a half-LSB reconstruction error', () => {
    for (let i = 0; i <= 4096; i++) {
      const x = i / 4096, r = convert(x);
      expect(r.code).toBe(Math.min(63, Math.floor(x * 64)));
      expect(r.stages.every(s => s.residue >= 0 && s.residue <= 1)).toBe(true);
      expect(Math.abs(r.error)).toBeLessThanOrEqual(.5 / 64);
      expect(r.stages.reduce((sum, s, j) => sum + s.digit / 4 ** (j + 1), 0) + r.stages[2].residue / 64).toBeCloseTo(x, 12);
    }
  });
  it('delays each sample by three clocks then delivers one correctly aligned code each clock', () => {
    const inputs = samples(.68);
    expect(pipelineAt(0, inputs).slots.every(s => s === null)).toBe(true);
    expect(pipelineAt(2, inputs).output).toBe(null);
    for (let i = 0; i < inputs.length; i++) {
      const frame = pipelineAt(i + 3, inputs);
      expect(frame.output?.sample).toBe(i);
      expect(frame.output?.code).toBe(Math.min(63, Math.floor(inputs[i] * 64)));
      expect(frame.slots[2]?.sample).toBe(i);
    }
    expect(pipelineAt(inputs.length + 3, inputs).output).toBe(null);
  });
});

describe('nonlinear calibration', () => {
  const cases: Record<string, { device?: Partial<Device>; training?: Partial<Training> }> = { smooth: {}, linear_only: { training: { degree: 1 } }, narrow: { training: { amplitude: .35 } }, clipping: { device: { quadratic: .08, cubic: .35 } }, noise: { device: { noiseMv: 3 } } };
  it.each(rows('nonlinear_calibration'))('agrees with NumPy least squares and FFT: %s', (name, before, rmsBefore, after, rmsAfter, clipped) => {
    const s = { ...ADC, ...cases[name].device }, t = { ...TRAINING, ...cases[name].training };
    const r = validate(s, fitInverse(s, t), .85);
    expect(r.before.sndr).toBeCloseTo(Number(before), 5);
    expect(r.after.sndr).toBeCloseTo(Number(after), 5);
    expect(1000 * r.rmsBefore).toBeCloseTo(Number(rmsBefore), 5);
    expect(1000 * r.rmsAfter).toBeCloseTo(Number(rmsAfter), 5);
    expect(r.clipped).toBe(Number(clipped));
  });
  it('learns a useful inverse without using validation data', () => {
    const fit = fitInverse(ADC, TRAINING), saved = fit.coefficients.slice();
    const r = validate(ADC, fit, .85);
    expect(r.after.sndr - r.before.sndr).toBeGreaterThan(25);
    expect(r.rmsAfter).toBeLessThan(.03 * r.rmsBefore);
    validate(ADC, fit, .45);
    expect(fit.coefficients).toEqual(saved);
    expect(fit.x.length).toBe(512);
    expect(r.input.length).toBe(2048);
  });
  it('does not pretend a linear gain correction removes distortion or clipping', () => {
    const r = validate(ADC, fitInverse(ADC, { ...TRAINING, degree: 1 }), .85);
    expect(r.after.sndr).toBeCloseTo(r.before.sndr, 9);
    const clip = { ...ADC, quadratic: .08, cubic: .35 };
    const fit = fitInverse(clip, TRAINING), c = validate(clip, fit, .85);
    expect(c.clipped).toBeGreaterThan(300);
    expect(c.after.sndr).toBeLessThan(35);
    expect(adc(.9, clip)).toBe(adc(.98, clip));
    expect(correct(adc(.9, clip), fit)).toBe(correct(adc(.98, clip), fit));
    expect(minimumSlope({ ...ADC, cubic: -.35 }, .98)).toBeLessThan(0);
  });
});

it('publishes PLL, calibration and one canonical Pipeline ADC course', async () => {
  const { featuredLessons } = await import('../src/data/illustrations');
  const { isPublicLessonPath } = await import('../src/data/publication');
  for (const href of ['/pll/introduction/', '/adc/pipeline-adc/', '/adc/nonlinear-calibration/']) expect(featuredLessons.some(x => x.href === href)).toBe(true);
  expect(featuredLessons.filter(x => x.href.includes('/pipeline-'))).toHaveLength(1);
  expect(isPublicLessonPath('/adc/pipeline-adc/')).toBe(true);
  expect(isPublicLessonPath('/adc/pipeline-introduction/')).toBe(false);
});
