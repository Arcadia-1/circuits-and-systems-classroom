import { describe, expect, it } from 'vitest';
import { floorOf, FS, KEEP, keepEvery, read, twins, zoneOf } from '../src/illustrations/aliasing/model';
import { fft, fftAny } from '../src/lib/fft';
import { coherentFrequency, foldBin, foldFrequency, residual } from '../src/lib/frequency';

describe('aliasing and the Nyquist zones', () => {
  // from python/adc_aliasing.py, after exp_c01: fs 1100 MHz and a 123 MHz tone
  it('lands one input from each of six zones on the same frequency, as exp_c01 draws it', () => {
    const fs = 1100e6, inputs = twins(123e6, fs, 3.3e9);
    expect(inputs.map((f) => f / 1e6)).toEqual([123, 977, 1223, 2077, 2323, 3177]);
    for (const f of inputs) expect(foldFrequency(f, fs)).toBe(123e6);
  });

  it('folds frequencies and bins the way ADCToolbox does', () => {
    const at = [0, 250e6, 500e6, 750e6, 1e9, 1230e6, 2770e6, 2999e6];
    expect(at.map((f) => foldFrequency(f, FS) / 1e6)).toEqual([0, 250, 500, 250, 0, 230, 230, 1]);
    expect([100, 2048, 3000, 4096, 5000, -100, 12345].map((b) => foldBin(b, 4096))).toEqual([100, 2048, 1096, 0, 904, 100, 57]);
  });

  it('lands odd zones directly and even zones mirrored', () => {
    const gs = [0.2, 0.7, 1.2, 1.7, 2.2, 2.7];
    expect(gs.map((g) => zoneOf(g * FS, FS))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(gs.map((g) => Math.sign(residual(g * FS, FS)))).toEqual([1, -1, 1, -1, 1, -1]);
  });

  // from python/adc_aliasing.py: 12 bits at 1 GS/s, a −1 dBFS tone, HD2 −70 dBc, HD3 −60 dBc, 0.3 LSB of noise
  // [target MHz, keep, bin, fin MHz, where the tone, H2 and H3 land in MHz, bin kept, ENOB and SFDR at fs, and kept]
  const table: number[][] = [
    [70, 1, 287, 70.068, 70.068, 140.137, 210.205, 287, 9.54, 60.0, 9.54, 60.0],
    [70, 2, 573, 69.946, 69.946, 139.893, 209.839, 573, 9.541, 60.01, 9.542, 60.02],
    [70, 3, 859, 69.906, 69.906, 139.811, 123.617, 859, 9.542, 60.01, 9.544, 60.04],
    [70, 4, 1147, 70.007, 70.007, 109.985, 39.978, 1147, 9.54, 59.99, 9.531, 59.92],
    [140, 1, 573, 139.893, 139.893, 279.785, 419.678, 573, 9.541, 60.0, 9.541, 60.0],
    [140, 2, 1147, 140.015, 140.015, 219.971, 79.956, 1147, 9.534, 59.96, 9.534, 59.95],
    [140, 3, 1721, 140.055, 140.055, 53.223, 86.833, 1721, 9.543, 60.01, 9.545, 60.02],
    [140, 4, 2293, 139.954, 110.046, 29.907, 80.139, 1803, 9.54, 60.0, 9.541, 60.02],
    [770, 1, 3153, 769.775, 230.225, 460.449, 309.326, 943, 9.535, 59.96, 9.535, 59.96],
    [770, 2, 6307, 769.897, 230.103, 39.795, 190.308, 1885, 9.54, 60.02, 9.547, 60.07],
    [770, 3, 9461, 769.938, 103.271, 126.79, 23.519, 1269, 9.536, 59.97, 9.54, 60.01],
    [770, 4, 12615, 769.958, 19.958, 39.917, 59.875, 327, 9.542, 60.01, 9.551, 60.05],
    [1230, 1, 5039, 1230.225, 230.225, 460.449, 309.326, 943, 9.538, 59.97, 9.538, 59.97],
    [1230, 2, 10077, 1230.103, 230.103, 39.795, 190.308, 1885, 9.533, 59.94, 9.53, 59.91],
    [1230, 3, 15115, 1230.062, 103.271, 126.79, 23.519, 1269, 9.54, 60.0, 9.531, 59.92],
    [1230, 4, 20153, 1230.042, 19.958, 39.917, 59.875, 327, 9.539, 59.99, 9.548, 60.03],
    [2770, 1, 11345, 2769.775, 230.225, 460.449, 309.326, 943, 9.535, 59.96, 9.535, 59.96],
    [2770, 2, 22691, 2769.897, 230.103, 39.795, 190.308, 1885, 9.54, 60.02, 9.547, 60.07],
    [2770, 3, 34037, 2769.938, 103.271, 126.79, 23.519, 1269, 9.536, 59.97, 9.54, 60.01],
    [2770, 4, 45383, 2769.958, 19.958, 39.917, 59.875, 327, 9.542, 60.01, 9.551, 60.05],
  ];
  it.each(table)('matches ADCToolbox at %i MHz, keeping every %i-th sample', (...row) => {
    const [target, keep, bin, fin, lands, h2, h3, kept, enobIn, sfdrIn, enobOut, sfdrOut] = row;
    const r = read(target * 1e6, keep, -70, -60);
    expect(r.bin).toBe(bin);
    expect(r.fin / 1e6).toBeCloseTo(fin, 3);
    expect(r.landings.map((l) => l.lands / 1e6)).toEqual([lands, h2, h3].map((v) => expect.closeTo(v, 3)));
    expect(r.after.signal).toBe(kept);
    expect(r.before.enob).toBeCloseTo(enobIn, 2);
    expect(r.before.sfdr).toBeCloseTo(sfdrIn, 1);
    expect(r.after.enob).toBeCloseTo(enobOut, 2);
    expect(r.after.sfdr).toBeCloseTo(sfdrOut, 1);
  });

  // exp_d00's point: a subsample-only rate adapter moves the spurs but not their height, and keeps the noise as well
  it('keeps spur heights and ENOB, and piles the same noise into a narrower band', () => {
    for (const keep of [2, 3, 4]) {
      const r = read(1230e6, keep, -70, -60);
      expect(Math.abs(r.after.sfdr - r.before.sfdr)).toBeLessThan(0.2);
      expect(Math.abs(r.after.enob - r.before.enob)).toBeLessThan(0.05);
      expect(floorOf(r.after) - floorOf(r.before)).toBeCloseTo(10 * Math.log10(keep), 0);
    }
  });

  it('finds each folded harmonic in the kept spectrum where the fold puts it', () => {
    const r = read(1230e6, 2, -70, -60);
    for (const l of r.landings.slice(1)) {
      const bin = Math.round((l.lands / r.fsOut) * 4096);
      expect(r.after.harmonics).toContain(bin);
      expect(r.after.dbfs[bin]).toBeGreaterThan(floorOf(r.after) + 20);
    }
  });

  it('tells a harmonic that folds from one that stays put', () => {
    // 333 MS/s kept: H2 at 140 MHz is below the 167 MHz Nyquist, H3 at 210 MHz is not
    expect(read(70e6, 3, -70, -60).landings.map((l) => l.folded)).toEqual([false, false, true]);
  });

  it('keeps samples keep − 1, 2·keep − 1, … as exp_d00 counts them', () => {
    const record = Float64Array.from({ length: 12 }, (_, i) => i);
    expect([...keepEvery(record, 3)]).toEqual([2, 5, 8, 11]);
    expect([...keepEvery(record, 1)]).toEqual([...record]);
  });

  it('picks an odd coprime bin, so neither harmonic can land on the tone', () => {
    for (const keep of KEEP) {
      for (const target of [10e6, 333e6, 1500e6, 2999e6]) {
        const { bin } = coherentFrequency(FS, target, keep * 4096);
        expect(bin % 2).toBe(1);
        if (keep === 3) expect(bin % 3).not.toBe(0);
        for (const h of [2, 3]) expect(foldBin(h * bin, 4096)).not.toBe(foldBin(bin, 4096));
      }
    }
  });

  it('transforms a record of any length as the definition does', () => {
    for (const n of [12, 27, 100]) {
      const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.1 * i);
      const re = x.slice(), im = new Float64Array(n);
      fftAny(re, im);
      for (let k = 0; k < n; k++) {
        let sr = 0, si = 0;
        for (let j = 0; j < n; j++) {
          sr += x[j] * Math.cos((2 * Math.PI * j * k) / n);
          si -= x[j] * Math.sin((2 * Math.PI * j * k) / n);
        }
        expect(re[k]).toBeCloseTo(sr, 9);
        expect(im[k]).toBeCloseTo(si, 9);
      }
    }
    // and a radix-2 record goes through the radix-2 transform untouched
    const a = Float64Array.from({ length: 64 }, (_, i) => Math.cos(i)), b = a.slice();
    const ai = new Float64Array(64), bi = new Float64Array(64);
    fft(a, ai);
    fftAny(b, bi);
    expect([...b]).toEqual([...a]);
    expect([...bi]).toEqual([...ai]);
  });
});
