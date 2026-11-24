import { describe, expect, it } from 'vitest';
import {
  ARRAYS,
  BINARY,
  chipOf,
  LENGTHS,
  read,
  REDUNDANT,
  sarReconstruct,
  sweep,
  trainBin,
  uncalibrated,
  type ArrayName,
} from '../src/illustrations/training/model';

describe('how much training a calibration needs', () => {
  // every number below is printed by python/adc_training_length.py, which runs ADCToolbox on the same chips
  it('builds the two arrays and the chips they become', () => {
    [0.444442749, 0.246917725, 0.137176514, 0.076217651, 0.04234314, 0.023529053].forEach((v, j) =>
      expect(REDUNDANT[j], `redundant weight ${j}`).toBeCloseTo(v, 9),
    );
    [0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625].forEach((v, j) => expect(BINARY[j]).toBeCloseTo(v, 9));
    [0.444492296, 0.24695178, 0.137151403, 0.076206293, 0.04233609, 0.023522667].forEach((v, j) =>
      expect(chipOf(REDUNDANT, 0)[j], `chip 0 weight ${j}`).toBeCloseTo(v, 9),
    );
    expect(LENGTHS.map(trainBin)).toEqual([3, 5, 5, 7, 9, 17, 31, 63, 125, 249]);
  });

  // array: uncalibrated min/median/max, then per length the same for the test capture and the training capture
  const sheets: Record<ArrayName, { raw: number[]; rows: [number, number[], number[]][] }> = {
    redundant: {
      raw: [13.7701, 14.6729, 14.9383],
      rows: [
        [32, [15.1672, 15.517, 15.6594], [16.1179, 16.5709, 17.0714]],
        [48, [15.5408, 15.7249, 15.7964], [16.1545, 16.3814, 16.4719]],
        [64, [15.6671, 15.7352, 15.8684], [16.2286, 16.3386, 16.5385]],
        [96, [15.849, 15.8789, 15.9121], [16.0369, 16.1632, 16.2663]],
        [128, [15.8169, 15.8802, 15.9067], [16.0192, 16.0509, 16.1434]],
        [256, [15.9022, 15.9354, 15.9755], [16.041, 16.063, 16.1597]],
        [512, [15.9338, 15.9781, 15.9827], [16.0029, 16.0321, 16.1095]],
        [1024, [15.9647, 15.9882, 15.9984], [15.9924, 16.0216, 16.07]],
        [2048, [15.9721, 15.9878, 15.9984], [15.9877, 16.0055, 16.02]],
        [4096, [15.981, 15.9924, 16.0002], [15.9844, 16.0005, 16.0166]],
      ],
    },
    binary: {
      raw: [13.7746, 14.6131, 15.0026],
      rows: [
        [32, [13.5862, 15.2576, 15.5399], [16.2876, 16.9467, 49.1839]],
        [48, [15.4426, 15.6164, 15.764], [16.1225, 16.2383, 16.7475]],
        [64, [15.5147, 15.8218, 15.8889], [16.0135, 16.1678, 16.3316]],
        [96, [15.7109, 15.8704, 15.9181], [16.0177, 16.1146, 16.1887]],
        [128, [15.8224, 15.9284, 15.9824], [15.9549, 16.0628, 16.12]],
        [256, [15.8566, 15.956, 16.0091], [16.0256, 16.0884, 16.2064]],
        [512, [15.9601, 15.9763, 16.0184], [16.0161, 16.0358, 16.0728]],
        [1024, [15.965, 15.9844, 16.0335], [15.9794, 16.0033, 16.018]],
        [2048, [15.9856, 15.9911, 16.0376], [15.862, 16.007, 16.0256]],
        [4096, [15.9813, 15.9928, 16.0356], [15.9867, 15.9961, 16.0111]],
      ],
    },
  };

  for (const name of Object.keys(sheets) as ArrayName[]) {
    it(`sweeps the ${name} array as exp_d18 does`, () => {
      const { raw, rows } = sheets[name];
      uncalibrated(name).forEach((v, k) => expect(v, `uncalibrated ${k}`).toBeCloseTo(raw[k], 4));
      const swept = sweep(name);
      rows.forEach(([n, test, own], i) => {
        expect(swept[i].n).toBe(n);
        test.forEach((v, k) => expect(swept[i].test[k], `${name} test ${k} at ${n}`).toBeCloseTo(v, 4));
        // a fit that has swallowed its own training capture leaves a residual at the numerical floor, where
        // Cholesky normal equations and numpy SVD differ by a couple bits at ~1e-29 residual power
        own.forEach((v, k) => {
          if (v > 20) expect(swept[i].own[k], `${name} own ${k} at ${n}`).toBeGreaterThan(45);
          else expect(swept[i].own[k], `${name} own ${k} at ${n}`).toBeCloseTo(v, 4);
        });
      });
    });
  }

  it('calibrates chip 0 out of its mismatch', () => {
    const r = read('redundant', 0, 128);
    expect(r.before.sndr).toBeCloseTo(84.656, 3);
    expect(r.before.sfdr).toBeCloseTo(90.3945, 3);
    expect(r.before.enob).toBeCloseTo(13.7701, 4);
    expect(r.after.sndr).toBeCloseTo(97.4663, 3);
    expect(r.after.sfdr).toBeCloseTo(118.0137, 3);
    expect(r.after.enob).toBeCloseTo(15.8981, 4);
    // the array as built, and what the calibration made of it, both as a share of nominal
    [1.000111481, 1.000137922, 0.999816947, 0.999850974, 0.999833519, 0.999728617, 1.000386346, 0.999700258].forEach(
      (v, j) => expect(r.built[j], `built ${j}`).toBeCloseTo(v, 9),
    );
    [1.000069612, 1.00010211, 0.999780848, 0.999791507, 0.999798979, 0.999762709, 1.000373593, 0.999797361].forEach(
      (v, j) => expect(r.recovered[j], `recovered ${j}`).toBeCloseTo(v, 6),
    );
    [0.213394165, 0.535202026, 0.841293335, 0.994430542].forEach((v, i) =>
      expect(sarReconstruct(r.chip.bits, ARRAYS.redundant)[i], `trace ${i}`).toBeCloseTo(v, 9),
    );
  });
});
