import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FN, NF, NFPRE, OS, PRE, Prbs13, adcResponseDb, analyzeLink, berOf, lineResponses, metrics, pulse, responseDb, stage, type LinkSettings,
} from '../src/illustrations/serdes/model';
import { CHANNELS } from '../src/illustrations/serdes/channels';
import { EyeStream, Receiver, SymbolStream, plainPam4Eye } from '../src/illustrations/serdes/streams';

const reference = readFileSync(new URL('../python/expected/serdes_112g_link.txt', import.meta.url), 'utf8').trim().split('\n');
const rows = reference.slice(1).filter((line) => /^\d/.test(line)).map((line) => line.split(/\s+/).map(Number));
const linearRows = reference.filter((line) => line.startsWith('ffe ')).map((line) => line.slice(4).split(/\s+/).map(Number));
const echoRows = reference.filter((line) => line.startsWith('echo-')).map((line) => ({ dfe: line.startsWith('echo-dfe'), row: line.split(/\s+/).slice(1).map(Number) }));
const settings = (row: number[]): LinkSettings => ({
  lossDb: row[0], xtV: row[1] * 1e-3, rxNoiseV: row[2] * 1e-3, txFfe: row[3] === 1, autoCtle: row[4] === 1, gdc: -12, gdc2: -3, dsp: row[5] === 1,
});
const DEFAULT: LinkSettings = { lossDb: 28, xtV: 1.5e-3, rxNoiseV: 0.8e-3, txFfe: true, autoCtle: true, gdc: -9, gdc2: -3, dsp: true };

describe('112G PAM4 link model', () => {
  it.each([...rows.map((row) => [row.slice(0, 6).join(' '), row, true, false] as const), ...linearRows.map((row) => [`FFE ${row.slice(0, 6).join(' ')}`, row, false, false] as const), ...echoRows.map(({row, dfe}) => [`matched echo DSP=${row[5]} DFE=${dfe}`, row, dfe, true] as const)])('matches the NumPy reference for %s', (_, row, dfe, matchedEcho) => {
    const a = analyzeLink({ ...settings(row), dfe, echo: matchedEcho ? 0.85 : 0, sharedFrontEnd: matchedEcho });
    const [, , , , , , gdc, gdc2, phase, vga, hm1, h0, h1, padMv, snrDb, log10Ber, b1, w0] = row;
    expect(a.gdc).toBe(gdc);
    expect(a.gdc2).toBe(gdc2);
    expect(a.phaseUi).toBeCloseTo(phase, 6);
    expect(a.vga).toBeCloseTo(vga, 5);
    expect(a.h[PRE - 1]).toBeCloseTo(hm1, 5);
    expect(a.h[PRE]).toBeCloseTo(h0, 5);
    expect(a.h[PRE + 1]).toBeCloseTo(h1, 5);
    expect(a.padH0 * 1e3).toBeCloseTo(padMv, 3);
    expect(10 * Math.log10(a.snr)).toBeCloseTo(snrDb, 4);
    expect(Math.log10(berOf(a.snr))).toBeCloseTo(log10Ber, 3);
    expect(metrics(a.h, a.weights, a.noise, a.dfe).b1).toBeCloseTo(b1, 5);
    expect(a.weights[NFPRE]).toBeCloseTo(w0, 5);
  });

  it('sets the bump-to-bump loss at 28 GHz exactly and keeps the DC gain at 0 dB', () => {
    for (const loss of [8, 20, 28, 44]) {
      const st = [stage.skin(0.35 * loss), stage.diel(0.65 * loss)];
      expect(responseDb(st, FN)).toBeCloseTo(-loss, 9);
      expect(responseDb(st, 0)).toBeCloseTo(0, 12);
    }
  });

  it('gives a causal pulse response with unit area', () => {
    for (const loss of [8, 28, 44]) {
      const p = pulse([stage.poles(50e9, 2), stage.skin(0.35 * loss), stage.diel(0.65 * loss)]);
      const peak = Math.max(...p), pre = p.subarray(0, 6 * OS);
      expect(p.reduce((s, v) => s + v, 0) / OS).toBeCloseTo(1, 9);
      // Before the onset only the flat, wrapped-around end of the heavy tail remains.
      expect(Math.max(...pre) - Math.min(...pre)).toBeLessThan(1e-4 * peak);
      expect(Math.abs(pre[0])).toBeLessThan(5e-3 * peak);
    }
  });

  it('makes the adjustable echo passive and causal with the stated 1-UI delay and Nyquist notch', () => {
    for (const ratio of [0, 0.5, 0.85, 0.9]) {
      const echo = stage.postcursorEcho(ratio);
      expect(responseDb([echo], 0)).toBeCloseTo(0, 12);
      expect(responseDb([echo], FN)).toBeCloseTo(20 * Math.log10((1 - ratio) / (1 + ratio)), 9);
      for (let f = 0; f <= 112e9; f += 1e9) expect(responseDb([echo], f)).toBeLessThanOrEqual(1e-10);
      const direct = pulse([stage.poles(50e9, 2)]), reflected = pulse([stage.poles(50e9, 2), echo]);
      for (let i = 0; i < direct.length; i++) expect(reflected[i]).toBeCloseTo((direct[i] + ratio * direct[(i - OS + direct.length) % direct.length]) / (1 + ratio), 9);
    }
  });

  it('keeps the ADC waveform, noise and clock identical across the matched DSP comparison', () => {
    const common = { ...DEFAULT, ...CHANNELS[2], sharedFrontEnd: true };
    const modes = [analyzeLink({...common, dsp: false}), analyzeLink({...common, dfe: false}), analyzeLink({...common, dfe: true})];
    for (const a of modes.slice(1)) {
      expect(a.h).toEqual(modes[0].h);
      expect(a.adc).toEqual(modes[0].adc);
      expect(a.noise).toEqual(modes[0].noise);
      expect([a.gdc, a.gdc2, a.vga, a.tsOff]).toEqual([modes[0].gdc, modes[0].gdc2, modes[0].vga, modes[0].tsOff]);
      expect(a.channelLossDb).toBeCloseTo(-responseDb(a.stages.channel.slice(1), FN), 10);
    }
    expect(10 * Math.log10(modes[2].snr / modes[1].snr)).toBeGreaterThan(5);
  });

  it.each(CHANNELS)('uses the same channel at the end of the 3-D line and in the $id receiver eye', (channel) => {
    const a = analyzeLink({...DEFAULT, ...channel});
    const line = lineResponses(channel.lossDb, true, channel.echo);
    for (let i = 0; i < a.pad.length; i++) expect(line[15][i] * 0.5).toBeCloseTo(a.pad[i], 7);
    expect(Math.max(...line[0])).toBeGreaterThan(0.65);
  });

  it('uses the COM CTLE form: DC gain g_DC + g_DC2 and a high-frequency roll-off', () => {
    for (const [g, g2] of [[0, 0], [-9, -3], [-20, -6]]) {
      expect(responseDb([stage.ctle(g, g2)], 0)).toBeCloseTo(g + g2, 9);
      expect(responseDb([stage.ctle(g, g2)], 10 * 56e9)).toBeLessThan(responseDb([stage.ctle(g, g2)], FN));
    }
  });

  it.each([false, true])('finds an MMSE optimum with DFE=%s: no single-tap nudge raises the SNR', (dfe) => {
    const a = analyzeLink({ ...DEFAULT, dfe });
    const best = metrics(a.h, a.weights, a.noise, dfe).snr;
    expect(best).toBeCloseTo(a.snr, 9);
    for (let i = 0; i < NF; i++) for (const d of [-1e-3, 1e-3]) {
      const w = Float64Array.from(a.weights);
      w[i] += d;
      expect(metrics(a.h, w, a.noise, dfe).snr).toBeLessThanOrEqual(best * (1 + 1e-9));
    }
  });

  it('loses SNR steadily as the channel loss grows', () => {
    const snr = rows.slice(0, 5).map((row) => row[14]);
    for (let i = 1; i < snr.length; i++) expect(snr[i]).toBeLessThan(snr[i - 1]);
  });

  it('computes the Gray-coded PAM4 BER from the Gaussian tail', () => {
    expect(berOf(5 * 9)).toBeCloseTo(0.75 * 0.0013498980316301, 9);
  });

  it('includes the VGA and TX FFE in the displayed ADC response', () => {
    for (const txFfe of [false, true]) {
      const a = analyzeLink({ ...DEFAULT, txFfe });
      const analog = a.stages.channel.concat(a.stages.rx);
      // The preset sums to 0.5 at DC and has unit gain at Nyquist.
      expect(adcResponseDb(a, 0) - responseDb(analog, 0)).toBeCloseTo(20 * Math.log10(a.vga * (txFfe ? 0.5 : 1)), 9);
      expect(adcResponseDb(a, FN) - responseDb(analog, FN)).toBeCloseTo(20 * Math.log10(a.vga), 9);
      // Doubling VGA must move the entire response up by 6.02 dB.
      for (const f of [0, 7e9, 14e9, FN, 56e9]) {
        expect(adcResponseDb({ ...a, vga: a.vga * 2 }, f) - adcResponseDb(a, f)).toBeCloseTo(20 * Math.log10(2), 9);
      }
    }
  });

  it('generates PRBS13Q with period 8191 and the reference level counts', () => {
    const prbs = new Prbs13(0x1d3), seq = Array.from({ length: 2 * 8191 }, () => prbs.symbol());
    const counts = [0, 1, 2, 3].map((v) => seq.slice(0, 8191).filter((s) => s === v).length);
    expect(seq.slice(0, 8191)).toEqual(seq.slice(8191));
    expect(`prbs13q period 8191 counts ${counts.join(' ')}`).toBe(reference.find((l) => l.includes('counts')));
    expect(`prbs13q first ${seq.slice(0, 24).join(' ')}`).toBe(reference.find((l) => l.includes('first')));
  });

  it('starts the travelling waveform at the transmitter and ends it at the receiver pad', () => {
    const line = lineResponses(28, false);
    expect(line).toHaveLength(16);
    const a = analyzeLink({ ...DEFAULT, txFfe: false });
    const peak = (q: Float32Array) => q.reduce((m, v) => Math.max(m, v), 0);
    expect(peak(line[0])).toBeGreaterThan(0.9);
    expect(peak(line[15]) * 0.5).toBeCloseTo(a.padH0, 1);
  });
});

describe('receiver streams', () => {
  it('decides every symbol correctly at 28 dB with the equalizer on', () => {
    const rx = new Receiver(analyzeLink(DEFAULT), true), s = new SymbolStream(7);
    s.start(480, rx);
    for (let t = 480; t < 20480; t += 1) s.advance(t, rx);
    expect(s.decisions).toBeGreaterThan(19000);
    expect(s.errors).toBe(0);
  });

  it('fails at 28 dB with the DSP bypassed', () => {
    const rx = new Receiver(analyzeLink({ ...DEFAULT, dsp: false }), false), s = new SymbolStream(7);
    s.start(480, rx);
    for (let t = 480; t < 10480; t += 1) s.advance(t, rx);
    expect(s.errors / s.decisions).toBeGreaterThan(0.02);
  });

  it('recovers the PAM4 levels with symbol-rate decision feedback', () => {
    const rx = new Receiver(analyzeLink(DEFAULT), true), eyes = new EyeStream(11);
    eyes.run(900, rx);
    for (let n = eyes.n - 700; n < eyes.n - 10; n++) {
      const level = [-1, -1 / 3, 1 / 3, 1][eyes.symbolAt(n)];
      expect(Math.abs(eyes.centre[n & 1023] - level)).toBeLessThan(0.3);
    }
  });

  it('keeps DFE feedback out of the continuous FFE eye', () => {
    const a = analyzeLink(DEFAULT), withDfe = new Receiver(a, true), withoutDfe = new Receiver(a, true);
    withoutDfe.live = { ...withoutDfe.live, b1: 0 };
    const x = new EyeStream(11), y = new EyeStream(11);
    x.run(120, withDfe);
    y.run(120, withoutDfe);
    expect(withDfe.live.b1).toBeGreaterThan(0.3);
    expect(x.ffeTrace).toEqual(y.ffeTrace);
    expect(x.eyes[2].buf).toEqual(y.eyes[2].buf);
    const n = x.n - NFPRE - 1;
    expect(x.centre[n & 1023]).not.toBeCloseTo(y.centre[n & 1023], 2);
  });

  it('reuses the same noisy waveform in overlapping eye windows', () => {
    const rx = new Receiver(analyzeLink(DEFAULT), true), eyes = new EyeStream(11);
    eyes.run(120, rx);
    const previous = eyes.ffeTrace.slice(OS);
    eyes.run(1, rx);
    expect(eyes.ffeTrace.slice(0, OS + 1)).toEqual(previous);
  });

  it('produces the same eyes for a large initial fill and smaller playback batches', () => {
    const rx = new Receiver(analyzeLink(DEFAULT), true), whole = new EyeStream(11), chunks = new EyeStream(11);
    whole.run(1500, rx);
    for (let n = 0; n < 15; n++) chunks.run(100, rx);
    expect(whole.centre).toEqual(chunks.centre);
    for (let i = 0; i < 3; i++) expect(whole.eyes[i].buf).toEqual(chunks.eyes[i].buf);
  });

  it('shows four levels and three open eyes in the plain TX reference', () => {
    const eye = plainPam4Eye(), x = Math.floor(eye.width / 2);
    const near = (v: number) => {
      const row = Math.round((0.6 - v) / 1.2 * (eye.height - 1)), radius = Math.ceil(0.04 / 1.2 * eye.height);
      let total = 0;
      for (let dy = -radius; dy <= radius; dy++) total += eye.buf[(row + dy) * eye.width + x];
      return total;
    };
    for (const level of [-0.5, -1 / 6, 1 / 6, 0.5]) expect(near(level)).toBeGreaterThan(1);
    for (const threshold of [-1 / 3, 0, 1 / 3]) expect(near(threshold)).toBe(0);
  });

  it('adapts the taps from the unequalized state to the MMSE solution', () => {
    const a = analyzeLink(DEFAULT), rx = new Receiver(analyzeLink({ ...DEFAULT, dsp: false }), false);
    rx.retarget(a, true);
    let moving = true;
    for (let i = 0; i < 400 && moving; i++) moving = rx.adapt(1 / 60);
    expect(moving).toBe(false);
    expect(10 * Math.log10(rx.live.snr)).toBeCloseTo(10 * Math.log10(a.snr), 1);
  });
});

describe('112G SerDes lesson registration', () => {
  it('publishes the lesson in its own SerDes category with its own thumbnail', async () => {
    const { featuredLessons } = await import('../src/data/illustrations');
    const { isLessonPath, isPublicLessonPath } = await import('../src/data/publication');
    const path = '/serdes/112g-pam4-link/';
    expect(isLessonPath(path)).toBe(true);
    expect(isPublicLessonPath(path)).toBe(true);
    expect(featuredLessons.find((x) => x.href === path)).toMatchObject({ category: 'SerDes', thumb: 'serdes' });
  });
});
