import { beforeAll, describe, expect, it } from 'vitest';
import { EA, LEVELS, NFPRE, OS, analyzeLink, berOf, type LinkSettings } from '../src/illustrations/serdes/model';
import { EyeStream, MASK, Receiver } from '../src/illustrations/serdes/streams';

const BASE: LinkSettings = { lossDb: 28, xtV: 1.5e-3, rxNoiseV: 0.8e-3, txFfe: true, autoCtle: true, gdc: -9, gdc2: -3, dsp: true };
const db = (power: number) => 10 * Math.log10(power);
const gray = [0b00, 0b01, 0b11, 0b10];

/** Measure actual slicer inputs, including wrong-decision feedback, independently of the analytic noise budget. */
function audit(settings: LinkSettings) {
  const a = analyzeLink(settings), rx = new Receiver(a, settings.dsp), eyes = new EyeStream(11);
  const sums = [0, 0, 0, 0], squares = [0, 0, 0, 0], counts = [0, 0, 0, 0];
  const padSums = [0, 0, 0, 0], padSquares = [0, 0, 0, 0];
  let error2 = 0, padError2 = 0, bitErrors = 0, total = 0;
  eyes.run(200, rx);
  for (let batch = 0; batch < 200; batch++) {
    const first = eyes.n - NFPRE;
    eyes.run(100, rx);
    // Consume before the 1,024-symbol ring wraps. The FFE has NFPRE symbols of look-ahead.
    for (let n = first; n < eyes.n - NFPRE; n++) {
      const symbol = eyes.symbolAt(n), value = eyes.centre[n & MASK], pad = eyes.padCentre[n & MASK] / a.padH0;
      const wrong = gray[eyes.decision[n & MASK]] ^ gray[symbol];
      sums[symbol] += value; squares[symbol] += value * value; counts[symbol]++;
      padSums[symbol] += pad; padSquares[symbol] += pad * pad;
      error2 += (value - LEVELS[symbol]) ** 2;
      padError2 += (pad - LEVELS[symbol]) ** 2;
      bitErrors += (wrong & 1) + ((wrong >> 1) & 1);
      total++;
    }
  }
  const means = sums.map((sum, i) => sum / counts[i]);
  const margins = (sum: number[], square: number[]) => {
    const mean = sum.map((s, i) => s / counts[i]);
    const sigma = square.map((s, i) => Math.sqrt(Math.max(0, s / counts[i] - mean[i] ** 2)));
    // Three vertical eye openings at the decision phase, with 3 sigma clearance on each adjacent level.
    return [0, 1, 2].map((i) => mean[i + 1] - mean[i] - 3 * (sigma[i] + sigma[i + 1]));
  };
  return { a, rx, eyes, means, margins: margins(sums, squares), padMargins: margins(padSums, padSquares), snr: db(EA * total / error2), padSnr: db(EA * total / padError2), ber: bitErrors / (2 * total), bitErrors, bits: 2 * total };
}

describe('same-channel PAM4 eye comparison', () => {
  let normal: ReturnType<typeof audit>, feedback: ReturnType<typeof audit>, bypass: ReturnType<typeof audit>, stress: ReturnType<typeof audit>;
  beforeAll(() => {
    normal = audit({ ...BASE, dfe: false });
    feedback = audit(BASE);
    bypass = audit({ ...BASE, dsp: false });
    stress = audit({ ...BASE, lossDb: 42, xtV: 2.1e-3, rxNoiseV: 0.6e-3, txFfe: false });
  }, 60000);

  it('opens all three eyes after equalization of the default closed-eye channel', () => {
    expect(normal.bits).toBe(40000);
    for (const margin of normal.padMargins) expect(margin).toBeLessThan(0);
    for (const margin of normal.margins) expect(margin).toBeGreaterThan(0.2);
    expect(normal.snr - normal.padSnr).toBeGreaterThan(19);
    normal.means.forEach((mean, i) => expect(mean).toBeCloseTo(LEVELS[i], 2));
    // This asserts the finite experiment, not an extrapolated zero BER.
    expect(normal.bitErrors).toBe(0);
  });

  it('matches the independent link budget when decisions are correct', () => {
    expect(Math.abs(normal.snr - db(normal.a.snr))).toBeLessThan(0.2);
    expect(Math.abs(normal.padSnr - db(normal.a.padSnr))).toBeLessThan(0.3);
  });

  it('closes the eyes and produces errors when the receiver DSP is bypassed', () => {
    for (const margin of bypass.margins) expect(margin).toBeLessThan(0);
    expect(normal.snr - bypass.snr).toBeGreaterThan(9);
    expect(bypass.ber).toBeGreaterThan(0.03);
  });

  it('retains real DFE error propagation in the high-loss case', () => {
    expect(stress.ber).toBeGreaterThan(0.009);
    expect(stress.ber).toBeLessThan(0.025);
    expect(stress.ber).toBeGreaterThan(2 * berOf(stress.a.snr));
    expect(db(stress.a.snr) - stress.snr).toBeGreaterThan(1);
    for (const margin of stress.margins) expect(margin).toBeLessThan(0);
  });

  it('opens all three eyes at each repeated sampling phase across the displayed 2 UI', () => {
    const eye = normal.eyes.eyes[2];
    for (const x of [2, Math.floor(eye.width / 2), eye.width - 3]) {
      const density = (v: number) => {
        const y = Math.round((1.6 - v) / 3.2 * (eye.height - 1));
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) sum += eye.buf[(y + dy) * eye.width + x];
        return sum;
      };
      const rails = LEVELS.map(density);
      for (const rail of rails) expect(rail).toBeGreaterThan(100);
      for (const threshold of [-2 / 3, 0, 2 / 3]) expect(density(threshold)).toBeLessThan(0.01 * Math.min(...rails));
    }
  });

  it('applies DFE to the actual decision sample and reports its measured amplitude distribution', () => {
    for (const { eyes, rx } of [normal, feedback, bypass, stress]) {
      const n = eyes.n - NFPRE - 1;
      const correction = rx.live.b1 * LEVELS[eyes.decision[(n - 1) & MASK]];
      expect(eyes.centre[n & MASK]).toBeCloseTo(eyes.ffeTrace[OS] - correction, 6);
      const m = eyes.measurements();
      expect(m.histogram.counts.reduce((sum, count) => sum + count, 0)).toBe(m.bits / 2);
      expect(m.histogram.range).toBeGreaterThan(1);
    }
    expect(normal.rx.live.b1).toBe(0);
    expect(feedback.rx.live.b1).toBeGreaterThan(0.3);
  });

  it('reports observed bits and SNR from the same decision stream', () => {
    for (const run of [normal, feedback, bypass, stress]) {
      const measured = run.eyes.measurements();
      expect(measured.bits).toBe(8192);
      expect(Math.abs(db(measured.snr) - run.snr)).toBeLessThan(0.6);
      expect(Math.abs(measured.bitErrors / measured.bits - run.ber)).toBeLessThan(0.005);
    }
  });
});
