import { describe, expect, it } from 'vitest';
import {
  capture,
  fitSine,
  floorModel,
  ifilter,
  ntfperf,
  ntfTaps,
  noiseBudget,
  OSRS,
  perfosr,
  predictedSnr,
  read,
  rms,
  spectrumOf,
  TONE,
  whiteSnr,
} from '../src/illustrations/oversampling/model';
import { analyzeSpectrum, inbandBins } from '../src/lib/spectrum';

describe('oversampling and noise shaping', () => {
  // from python/adc_oversampling.py: 8192 samples at 100 MHz, a 0.4 V tone on a ±0.5 V range
  it('tests at exp_o03’s tone', () => {
    expect(TONE.bin).toBe(13);
    expect(TONE.fin / 1e3).toBeCloseTo(158.691, 3);
  });

  // ntfperf of (1 − z⁻¹)^order at OSR 1, 2, 4 … 256
  const gains = [
    [0, 3.01, 6.021, 9.031, 12.041, 15.052, 18.062, 21.072, 24.083],
    [-3.01, 4.396, 13.024, 21.954, 30.96, 39.985, 49.015, 58.045, 67.075],
    [-7.782, 3.434, 17.526, 32.338, 47.33, 62.367, 77.415, 92.465, 107.514],
    [-13.01, 1.785, 21.288, 41.969, 62.943, 83.991, 105.058, 126.127, 147.197],
  ];
  it('integrates the NTF over the band as ntfperf does', () => {
    gains.forEach((row, order) => OSRS.forEach((osr, i) => expect(ntfperf(order, osr)).toBeCloseTo(row[i], 3)));
  });

  // Stationary quantisation-noise model, checked by python/adc_oversampling.py with ADCToolbox:
  // [bits, order, SNDR and SFDR over the whole band, the same at OSR 32, perfosr's SNDR at each OSR,
  //  rms of the record, of ifilter's band to fs/64, and of what it leaves out]
  const cases: [number, number, number[], number[], number[], number[]][] = [
    [4, 0, [23.991, 50.975], [39.162, 52.828], [23.987, 27.001, 30.378, 33.105, 36.522, 39.397, 41.977, 45.144, 47.701], [2.833957e-1, 2.828493e-1, 1.759073e-2]],
    [4, 1, [20.982, 45.832], [64.256, 76.774], [20.934, 28.032, 37.469, 45.837, 55.659, 64.684, 72.467, 81.997, 87.992], [2.839692e-1, 2.828435e-1, 2.526079e-2]],
    [4, 2, [16.242, 39.974], [86.733, 97.539], [16.22, 26.889, 41.94, 56.212, 72.082, 87.117, 97.616, 100.7, 100.801], [2.861825e-1, 2.828427e-1, 4.359372e-2]],
    [4, 3, [11.037, 34.115], [108.462, 118.119], [11.044, 25.147, 45.637, 65.863, 85.733, 90.031, 90.085, 90.085, 90.087], [2.937687e-1, 2.828427e-1, 7.937278e-2]],
    [10, 0, [60.115, 87.099], [75.286, 88.952], [60.111, 63.125, 66.502, 69.229, 72.646, 75.521, 78.101, 81.268, 83.825], [2.828427e-1, 2.828426e-1, 2.748551e-4]],
    [10, 1, [57.105, 81.956], [100.38, 112.898], [57.058, 64.155, 73.592, 81.961, 91.782, 100.807, 108.59, 118.121, 124.115], [2.82843e-1, 2.828427e-1, 3.946999e-4]],
    [10, 2, [52.366, 76.097], [122.856, 133.663], [52.344, 63.013, 78.063, 92.336, 108.206, 123.24, 133.74, 136.824, 136.925], [2.828435e-1, 2.828427e-1, 6.811519e-4]],
    [10, 3, [47.161, 70.239], [144.585, 154.243], [47.167, 61.27, 81.76, 101.987, 121.856, 126.155, 126.208, 126.209, 126.21], [2.828454e-1, 2.828427e-1, 1.2402e-3]],
  ];
  it.each(cases)('matches ADCToolbox for a stationary %i-bit noise model shaped to order %i', (bits, order, full, band, sweep, levels) => {
    const data = capture(order, bits);
    for (const [osr, [sndr, sfdr]] of [[1, full], [32, band]] as const) {
      const s = spectrumOf(data, bits, osr);
      expect(s.sndr).toBeCloseTo(sndr, 2);
      expect(s.sfdr).toBeCloseTo(sfdr, 2);
    }
    perfosr(data, OSRS).forEach((v, i) => expect(v).toBeCloseTo(sweep[i], 2));
    const inband = ifilter(data, 0, 0.5 / 32);
    const [whole, kept, left] = [data, inband, data.map((v, i) => v - inband[i])].map(rms);
    expect(whole / levels[0]).toBeCloseTo(1, 5);
    expect(kept / levels[1]).toBeCloseTo(1, 5);
    expect(left / levels[2]).toBeCloseTo(1, 5);
  });

  // what the page is about: shaping makes the total noise worse and the in-band noise far better
  it('trades noise out of the band for noise in it', () => {
    const r = [0, 1, 2, 3].map((order) => read(order, 4, 32));
    for (let order = 1; order < 4; order++) {
      expect(r[order].full.sndr).toBeLessThan(r[0].full.sndr + 4);
      expect(r[order].band.sndr).toBeGreaterThan(r[order - 1].band.sndr + 20);
    }
    // and each doubling of OSR buys about 6 dB per order plus 3, once the band is narrow enough
    const slope = (order: number) => ntfperf(order, 64) - ntfperf(order, 32);
    [3.01, 9.03, 15.05, 21.07].forEach((db, order) => expect(slope(order)).toBeCloseTo(db, 1));
  });

  it('predicts the measured sweep from white noise and the NTF, where the error is noise-like', () => {
    // ten bits leave a clean tone's quantisation error busy enough to pass for white noise up to OSR 32
    for (const order of [0, 1, 2]) {
      const r = read(order, 10, 32);
      [1, 2, 4, 8, 16, 32].forEach((osr) => {
        const i = OSRS.indexOf(osr);
        expect(Math.abs(r.sweep[i] - r.theory[i])).toBeLessThan(2.5);
      });
    }
    // (0.4² / 2) / ((1/16)² / 12)
    expect(whiteSnr(4)).toBeCloseTo(10 * Math.log10(0.08 * 3072), 9);
  });

  it('adds the requested amount of independent unshaped white noise', () => {
    const bits = 6, amount = 0.25;
    const clean = capture(2, bits), noisy = capture(2, bits, amount);
    expect(rms(noisy.map((v, i) => v - clean[i]))).toBeCloseTo(amount / 2 ** bits, 12);
  });

  it('includes added white noise in the measured and predicted in-band SNDR', () => {
    const r = read(2, 4, 32, 0.2);
    const metrics = [[r.full.sndr, r.full.sfdr], [r.band.sndr, r.band.sfdr]];
    const expected = [[15.877, 39.109], [42.786, 56.847]];
    metrics.forEach((actual, i) => actual.forEach((v, j) => expect(v).toBeCloseTo(expected[i][j], 2)));
    [15.846, 25.192, 32.527, 36.202, 39.498, 42.571, 44.759, 47.287, 51.039]
      .forEach((v, i) => expect(r.sweep[i]).toBeCloseTo(v, 2));
    [1, 2, 4, 8, 16, 32].forEach((osr) => {
      const i = OSRS.indexOf(osr);
      expect(Math.abs(r.sweep[i] - r.theory[i])).toBeLessThan(1.5);
    });
    // Once unshaped white noise dominates, each doubling of OSR buys the usual 3 dB.
    expect(predictedSnr(10, 3, 64, 0.5) - predictedSnr(10, 3, 32, 0.5)).toBeCloseTo(3.01, 1);
  });

  it('draws the dashed floor where the measured noise sits', () => {
    // the mean power of a stretch of bins, against the model's value in its middle
    for (const order of [0, 1, 2]) {
      const s = spectrumOf(capture(order, 10), 10, 1);
      let power = 0;
      for (let k = 1500; k < 1700; k++) power += 10 ** (s.dbfs[k] / 10) / 200;
      expect(10 * Math.log10(power)).toBeCloseTo(floorModel(10, order)(1600), -0.5);
    }
  });

  it('keeps the NTF slope down to the low bins without a filter-startup floor', () => {
    const bits = 2, order = 1, s = spectrumOf(capture(order, bits), bits, 1), model = floorModel(bits, order);
    let relativePower = 0, bins = 0;
    for (let k = 2; k < 128; k++) {
      if (k === s.signal) continue;
      relativePower += 10 ** ((s.dbfs[k] - model(k)) / 10);
      bins++;
    }
    expect(10 * Math.log10(relativePower / bins)).toBeCloseTo(0, 0);
  });

  it('builds the NTF from the binomial coefficients', () => {
    expect([0, 1, 2, 3].map(ntfTaps)).toEqual([[1], [1, -1], [1, -2, 1], [1, -3, 3, -1]]);
  });

  it('accumulates shaped noise monotonically to the whole-band total', () => {
    const budget = noiseBudget(2, 4);
    expect(budget.ntfDb[0]).toBeLessThan(-100);
    expect(budget.ntfDb.at(-1)).toBeCloseTo(20 * Math.log10(4), 8);
    expect(budget.cumulativeDb.at(-1)).toBeCloseTo(0, 12);
    for (let i = 1; i < budget.cumulativeDb.length; i++) expect(budget.cumulativeDb[i]).toBeGreaterThanOrEqual(budget.cumulativeDb[i - 1]);
    expect(budget.cumulativeDb[127]).toBeLessThan(-70);
  });

  it('counts the in-band bins the way rfft_inband_bin_count does', () => {
    expect(OSRS.map((osr) => inbandBins(8192, osr))).toEqual([4097, 2049, 1025, 513, 257, 129, 65, 33, 17]);
    expect(inbandBins(12288, 3)).toBe(2049);
    // and an OSR of 1 reads the whole spectrum, as before
    const x = capture(0, 10);
    expect(analyzeSpectrum(x, 10, 'rectangular', 0, 1).sndr).toBe(analyzeSpectrum(x, 10).sndr);
  });

  it('fits the tone with fit_sine_4param’s frequency estimate and converges', () => {
    const fit = fitSine(capture(2, 6));
    expect(fit.frequency * 8192).toBeCloseTo(13, 4);
    expect(fit.amplitude).toBeCloseTo(0.4, 3);
  });

  it('keeps the band and its mirror and nothing else', () => {
    const x = Float64Array.from({ length: 64 }, (_, i) => Math.cos((2 * Math.PI * 3 * i) / 64) + Math.cos((2 * Math.PI * 20 * i) / 64));
    const y = ifilter(x, 0, 5 / 64);
    y.forEach((v, i) => expect(v).toBeCloseTo(Math.cos((2 * Math.PI * 3 * i) / 64), 12));
  });
});
