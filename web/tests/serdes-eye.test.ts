import { beforeAll, describe, expect, it } from 'vitest';
import { EA, LEVELS, NF, NFPRE, OS, analyzeLink, berOf, type LinkSettings } from '../src/illustrations/serdes/model';
import { EyeStream, MASK, Receiver, SamplingEye } from '../src/illustrations/serdes/streams';
import { CHANNELS } from '../src/illustrations/serdes/channels';

const BASE: LinkSettings = { lossDb: 28, xtV: 1.5e-3, rxNoiseV: 0.8e-3, txFfe: true, autoCtle: true, gdc: -9, gdc2: -3, dsp: true };
const db = (power: number) => 10 * Math.log10(power);
const gray = [0b00, 0b01, 0b11, 0b10];

/** Measure actual slicer inputs, including wrong-decision feedback, independently of the analytic noise budget. */
function audit(settings: LinkSettings) {
  const a = analyzeLink(settings), rx = new Receiver(a, settings.dsp), eyes = new EyeStream(11);
  const sums = [0, 0, 0, 0], squares = [0, 0, 0, 0], counts = [0, 0, 0, 0];
  const padSums = [0, 0, 0, 0], padSquares = [0, 0, 0, 0];
  const lastSamples = new Float32Array(4096), lastResiduals = new Float64Array(4096);
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
      lastSamples[total % 4096] = value;
      lastResiduals[total % 4096] = (value - LEVELS[symbol]) ** 2;
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
  return { a, rx, eyes, means, lastSamples, windowSnr: db(EA * 4096 / lastResiduals.reduce((sum, x) => sum + x, 0)), margins: margins(sums, squares), padMargins: margins(padSums, padSquares), snr: db(EA * total / error2), padSnr: db(EA * total / padError2), ber: bitErrors / (2 * total), bitErrors, bits: 2 * total };
}

describe('same-channel PAM4 eye comparison', () => {
  let normal: ReturnType<typeof audit>, feedback: ReturnType<typeof audit>, bypass: ReturnType<typeof audit>, stress: ReturnType<typeof audit>;
  let echoFfe: ReturnType<typeof audit>, echoDfe: ReturnType<typeof audit>;
  beforeAll(() => {
    normal = audit({ ...BASE, dfe: false });
    feedback = audit(BASE);
    bypass = audit({ ...BASE, dsp: false });
    stress = audit({ ...BASE, lossDb: 42, xtV: 2.1e-3, rxNoiseV: 0.6e-3, txFfe: false });
    echoFfe = audit({ ...BASE, ...CHANNELS[2], sharedFrontEnd: true, dfe: false });
    echoDfe = audit({ ...BASE, ...CHANNELS[2], sharedFrontEnd: true, dfe: true });
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

  it('shows the DFE advantage on the strong-echo channel with the exact same received samples', () => {
    expect(echoFfe.a.adc).toEqual(echoDfe.a.adc);
    expect(echoFfe.eyes.padCentre).toEqual(echoDfe.eyes.padCentre);
    expect(echoFfe.snr).toBeGreaterThan(15.8);
    expect(echoFfe.snr).toBeLessThan(16.5);
    expect(echoDfe.snr - echoFfe.snr).toBeGreaterThan(4.8);
    expect(echoFfe.bitErrors).toBeGreaterThan(10);
    expect(echoDfe.bitErrors).toBe(0);
    for (const margin of echoFfe.margins) expect(margin).toBeLessThan(0.05);
    for (const margin of echoDfe.margins) expect(margin).toBeGreaterThan(0.25);
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
    for (const run of [normal, feedback, bypass, stress, echoFfe, echoDfe]) {
      const measured = run.eyes.measurements();
      expect(measured.bits).toBe(8192);
      expect(Math.abs(db(measured.snr) - run.snr)).toBeLessThan(0.6);
      expect(Math.abs(measured.bitErrors / measured.bits - run.ber)).toBeLessThan(0.005);
    }
  });

  it('matches the eye centre, histogram and SNR to the independently recorded decision samples in every mode', () => {
    for (const run of [normal, feedback, bypass, stress, echoFfe, echoDfe]) {
      const m = run.eyes.measurements(), { width, height, buf } = m.samplingEye;
      const bins = new Uint16Array(height);
      for (const sample of run.lastSamples) bins[Math.floor((sample / m.histogram.range + 1) * 0.5 * height)]++;
      expect(m.histogram.counts).toEqual(bins);
      expect(db(m.snr)).toBeCloseTo(run.windowSnr, 8);
      for (let bin = 0; bin < height; bin++) {
        for (const phase of [0, OS, 2 * OS]) expect(buf[(height - 1 - bin) * width + phase]).toBe(bins[bin]);
      }
      for (let phase = 0; phase < width; phase++) {
        let total = 0;
        for (let row = 0; row < height; row++) {
          const count = buf[row * width + phase];
          expect(count).toBeGreaterThanOrEqual(0);
          total += count;
        }
        expect(total).toBe(m.bits / 2);
      }
    }
  });

  it('opens all three post-DFE eyes in the same centre slice that produces the four peaks', () => {
    const { counts, range } = feedback.eyes.measurements().histogram;
    const near = (value: number) => {
      const bin = Math.floor((value / range + 1) * 0.5 * counts.length);
      return counts.slice(bin - 1, bin + 2).reduce((sum, x) => sum + x, 0);
    };
    for (const level of LEVELS) expect(near(level)).toBeGreaterThan(200);
    for (const threshold of [-2 / 3, 0, 2 / 3]) expect(near(threshold)).toBe(0);
  });

  it('sweeps each clock phase with its own prior decisions instead of extending the nominal correction', () => {
    const eyes = new EyeStream(17), rx = feedback.rx, previous = new Uint8Array(OS);
    let differentHistories = 0;
    eyes.run(NF - 1, rx);
    for (let i = 0; i < 600; i++) {
      eyes.run(1, rx);
      const n = eyes.n - NFPRE - 1;
      expect(eyes.phaseSamples[0]).toBe(eyes.centre[n & MASK]);
      for (let phase = 0; phase < OS; phase++) {
        const input = eyes.ffeTrace[OS + phase] - rx.live.b1 * LEVELS[previous[phase]];
        expect(eyes.phaseSamples[phase]).toBeCloseTo(input, 6);
        if (previous[phase] !== eyes.decision[(n - 1) & MASK]) differentHistories++;
        previous[phase] = input < -2 / 3 ? 0 : input < 0 ? 1 : input < 2 / 3 ? 2 : 3;
      }
    }
    expect(differentHistories).toBeGreaterThan(1000);
  });
});

it('removes expired samples and outliers from every clock-phase histogram together', () => {
  const eye = new SamplingEye(), phases = new Float32Array(OS).fill(5);
  eye.add(phases);
  const early = eye.snapshot();
  expect(early.histogram.range).toBeGreaterThan(5);
  for (let n = 0; n < 4096; n++) {
    for (let phase = 0; phase < OS; phase++) phases[phase] = LEVELS[(n + phase) % 4];
    eye.add(phases);
  }
  const last = eye.snapshot();
  expect(last.histogram.range).toBe(1.6);
  expect(Array.from(last.histogram.counts).filter(Boolean)).toEqual([1024, 1024, 1024, 1024]);
  expect(early.histogram.counts.reduce((sum, x) => sum + x, 0)).toBe(1);
  expect(last.samplingEye.buf.every((x) => x === 0 || x === 1024)).toBe(true);
});
