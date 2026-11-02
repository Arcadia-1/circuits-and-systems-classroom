import { describe, expect, it } from 'vitest';
import {
  capture,
  coherentOddBin,
  LENGTHS,
  nearNyquist,
  nearNyquistBin,
  noiseFor,
  quantise,
  read,
  SHORT,
  shortCapture,
  spectrumOf,
  sweep,
} from '../src/illustrations/record/model';

describe('how long a record', () => {
  // every number below is printed by python/adc_record_length.py, which runs ADCToolbox on the same samples
  it('sets the noise the example asks for', () => {
    expect(noiseFor() * 1e6).toBeCloseTo(475.682785, 6);
    // an ideal SAR of four bits is a plain floor quantiser, which is why the lesson uses one
    expect(quantise(0.5, 4)).toBeCloseTo(0.5, 12);
    expect(quantise(0.99999, 4)).toBeCloseTo(0.9375, 12);
    expect(quantise(1, 4)).toBeCloseTo(0.9375, 12);
    expect(quantise(-0.2, 4)).toBe(0);
  });

  it('sweeps the record length as exp_s13 does', () => {
    // N, bin, then SFDR mean, sigma, min and max, then SNDR the same way
    const rows: [number, number, number[], number[]][] = [
      [16, 3, [60.665, 3.014, 54.9482, 65.5361], [59.2301, 2.7512, 53.4341, 63.785]],
      [32, 5, [61.3604, 1.6297, 58.5894, 64.361], [57.5846, 1.4427, 54.457, 59.4171]],
      [64, 9, [62.6654, 1.4859, 59.5306, 65.1726], [56.3954, 0.8899, 55.0194, 57.7737]],
      [128, 17, [65.2722, 1.4304, 63.2383, 68.5092], [56.4975, 0.936, 54.4515, 57.987]],
      [256, 31, [66.9119, 1.0121, 65.3704, 69.1868], [56.0771, 0.6312, 54.9613, 56.9026]],
      [512, 63, [69.7357, 0.9877, 67.9431, 71.697], [55.9183, 0.4684, 54.8319, 56.3851]],
      [1024, 127, [71.4872, 1.2221, 69.4309, 73.9406], [55.873, 0.2262, 55.533, 56.3838]],
      [2048, 253, [74.6793, 1.161, 71.9899, 76.5537], [55.9925, 0.1514, 55.6646, 56.2982]],
      [4096, 505, [76.9746, 0.7209, 75.7438, 78.1462], [55.9208, 0.1207, 55.7008, 56.1048]],
      [8192, 1009, [78.9451, 1.3272, 76.3077, 80.8861], [55.9368, 0.075, 55.8317, 56.0987]],
      [16384, 2015, [80.1105, 1.5351, 77.788, 83.6742], [55.8996, 0.0691, 55.7591, 55.9955]],
    ];
    expect(LENGTHS).toEqual(rows.map((r) => r[0]));
    const swept = sweep();
    rows.forEach(([n, bin, sfdr, sndr], i) => {
      expect(coherentOddBin(n), `bin at ${n}`).toBe(bin);
      expect(swept[i].n).toBe(n);
      expect(swept[i].sndrRuns).toHaveLength(16);
      expect(swept[i].sfdrRuns).toHaveLength(16);
      ([['sfdr', sfdr], ['sndr', sndr]] as const).forEach(([which, want]) => {
        const got = swept[i][which];
        expect(got.mean, `${which} mean at ${n}`).toBeCloseTo(want[0], 4);
        expect(got.sigma, `${which} sigma at ${n}`).toBeCloseTo(want[1], 4);
        expect(got.min, `${which} min at ${n}`).toBeCloseTo(want[2], 4);
        expect(got.max, `${which} max at ${n}`).toBeCloseTo(want[3], 4);
      });
    });
  });

  it('reads one 4096-point capture the way the page draws it', () => {
    const r = read(4096);
    expect(r.spectrum.sndr).toBeCloseTo(56.0274, 4);
    expect(r.spectrum.sfdr).toBeCloseTo(77.1611, 4);
    expect(r.spectrum.enob).toBeCloseTo(9.0145, 4);
    [0.5, 0.842773438, 0.989257812, 0.856445312, 0.930664062, 0.842773438].forEach((v, k) =>
      expect(r.data[[0, 1, 2, 3, 100, 2047][k]], `sample ${k}`).toBeCloseTo(v, 8),
    );
    expect(spectrumOf(capture(4096, 0, noiseFor())).sndr).toBeCloseTo(56.0274, 4);
  });

  it('measures the same tone just below Nyquist as exp_s09 does', () => {
    // N, bin, SNDR, SFDR, ENOB
    const rows: [number, number, number, number, number][] = [
      [4, 1, 26.5321, 26.5321, 4.115],
      [5, 2, 30.8289, 30.8289, 4.8287],
      [8, 3, 34.8021, 34.7951, 5.4887],
      [9, 4, 24.8918, 26.9033, 3.8425],
      [16, 7, 24.8742, 27.4189, 3.8396],
      [17, 8, 25.6823, 29.531, 3.9738],
      [32, 15, 26.5472, 32.0969, 4.1175],
      [33, 16, 26.3274, 33.4191, 4.081],
      [64, 31, 25.5224, 31.0015, 3.9472],
      [65, 32, 25.9922, 34.6763, 4.0253],
      [128, 63, 25.7892, 33.3805, 3.9916],
      [129, 64, 25.949, 34.5913, 4.0181],
      [256, 127, 25.9033, 35.5305, 4.0105],
      [257, 128, 25.985, 35.0628, 4.0241],
    ];
    expect(SHORT).toEqual(rows.map((r) => r[0]));
    const got = nearNyquist();
    rows.forEach(([n, bin, sndr, sfdr, enob], i) => {
      expect(nearNyquistBin(n), `bin at ${n}`).toBe(bin);
      expect(got[i].sndr, `SNDR at ${n}`).toBeCloseTo(sndr, 4);
      expect(got[i].sfdr, `SFDR at ${n}`).toBeCloseTo(sfdr, 4);
      expect(got[i].enob, `ENOB at ${n}`).toBeCloseTo(enob, 4);
    });
    const capture = shortCapture(16);
    expect(capture.bin).toBe(7);
    expect(capture.data).toHaveLength(16);
    expect(Array.from(capture.counts).reduce((sum, count) => sum + count, 0)).toBe(16);
    expect(capture.spectrum.sndr).toBeCloseTo(got[4].sndr, 10);
  });
});
