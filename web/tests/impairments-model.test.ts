import { describe, expect, it } from 'vitest';
import {
  capture,
  FS,
  jitterFrom,
  limitOf,
  read,
  splitError,
  SWEEPS,
  sweep,
  TONE,
  type Kind,
} from '../src/illustrations/impairments/model';
import { coherentFrequency } from '../src/lib/frequency';

/** snr_to_enob */
const bits = (snr: number): number => (snr - 1.76) / 6.02;

describe('what sets the floor', () => {
  // every number below is printed by python/adc_impairments.py, which runs ADCToolbox on the same samples
  it('puts the tone on a coherent bin', () => {
    expect(TONE.bin).toBe(397);
    expect(TONE.fin / 1e6).toBeCloseTo(96.923828, 6);
  });

  // kind: strength, then SNDR, SNR, SFDR, ENOB, and the SNR the impairment alone would allow
  const sweeps: Record<Kind, [number, number, number, number, number, number | null][]> = {
    thermal: [
      [1e-6, 85.2692, 85.2865, 105.0277, 13.872, 110.054],
      [2e-6, 85.2194, 85.2319, 105.7132, 13.8637, 104.0334],
      [5e-6, 84.9379, 84.9452, 107.5532, 13.8169, 96.0746],
      [1e-5, 84.0633, 84.0699, 107.7721, 13.6717, 90.054],
      [2e-5, 81.536, 81.5446, 105.1839, 13.2518, 84.0334],
      [5e-5, 75.541, 75.552, 99.3478, 12.256, 76.0746],
      [1e-4, 69.9283, 69.9407, 93.5114, 11.3236, 70.054],
      [2e-4, 63.9937, 64.005, 88.3647, 10.3378, 64.0334],
      [5e-4, 56.0737, 56.0854, 80.3448, 9.0222, 56.0746],
      [1e-3, 50.0533, 50.0648, 74.2943, 8.0221, 50.054],
    ],
    quantiser: [
      [4, 24.5846, 24.7921, 34.018, 3.7915, 24.9282],
      [6, 37.1767, 37.2135, 50.9962, 5.8832, 36.9694],
      [8, 48.8923, 48.902, 66.95, 7.8293, 49.0106],
      [10, 61.1435, 61.1476, 80.9188, 9.8644, 61.0518],
      [11, 67.2328, 67.2347, 85.2668, 10.8759, 67.0724],
      [12, 73.0337, 73.0376, 93.8802, 11.8395, 73.093],
      [13, 78.9239, 78.9291, 100.5172, 12.8179, 79.1136],
      [14, 84.0633, 84.0699, 107.7721, 13.6717, 85.1342],
      [15, 87.5246, 87.5291, 111.7949, 14.2466, 91.1548],
      [16, 89.2709, 89.2801, 114.4728, 14.5367, 97.1754],
    ],
    jitter: [
      [1e-15, 84.0499, 84.056, 107.5458, 13.6694, 124.3078],
      [2e-15, 84.0199, 84.0258, 107.5367, 13.6644, 118.2872],
      [5e-15, 83.994, 83.9998, 107.3343, 13.6601, 110.3284],
      [1e-14, 83.9765, 83.9825, 107.6682, 13.6572, 104.3078],
      [2e-14, 83.8618, 83.8694, 107.3793, 13.6382, 98.2872],
      [5e-14, 83.0218, 83.0246, 107.3359, 13.4986, 90.3284],
      [1e-13, 81.0248, 81.0313, 105.2814, 13.1669, 84.3078],
      [2e-13, 76.9276, 76.9324, 100.7393, 12.4863, 78.2872],
      [5e-13, 69.8013, 69.8032, 93.7005, 11.3025, 70.3284],
      [1e-12, 63.9266, 63.9288, 87.8396, 10.3267, 64.3078],
    ],
    settling: [
      [0, 79.3428, 79.3473, 105.162, 12.8875, null],
      [0.02, 79.1465, 79.3591, 92.4366, 12.8549, null],
      [0.05, 78.4279, 79.3681, 85.5451, 12.7355, null],
      [0.1, 76.3661, 79.3441, 79.4132, 12.393, null],
      [0.15, 74.2017, 79.3553, 75.7861, 12.0335, null],
      [0.2, 72.2955, 79.4131, 73.2352, 11.7169, null],
      [0.3, 69.0706, 79.3401, 69.5012, 11.1812, null],
      [0.5, 64.5808, 79.3182, 64.7341, 10.4353, null],
    ],
    memory: [
      [0, 83.8791, 83.8895, 107.624, 13.641, null],
      [0.0005, 82.9527, 83.0051, 100.1181, 13.4872, null],
      [0.001, 81.1516, 81.2783, 93.7115, 13.188, null],
      [0.002, 77.2842, 77.4584, 88.1724, 12.5455, null],
      [0.005, 70.3713, 70.5776, 80.186, 11.3972, null],
      [0.009, 65.4285, 65.6317, 74.8904, 10.5762, null],
      [0.02, 58.6375, 58.8474, 68.0142, 9.4481, null],
    ],
    interferer: [
      [0, 84.0633, 84.0699, 107.7721, 13.6717, null],
      [0.0001, 80.491, 80.4941, 86.1427, 13.0782, null],
      [0.0003, 73.1382, 73.1391, 76.5114, 11.8568, null],
      [0.001, 62.9669, 62.967, 66.0039, 10.1673, null],
      [0.003, 53.4667, 53.4667, 56.4733, 8.5892, null],
      [0.01, 43.0089, 43.0089, 46.0189, 6.852, null],
      [0.03, 33.4677, 33.4677, 36.4775, 5.2671, null],
    ],
  };

  // kind: samples 0 … 3, 100 and 2047 at the strength the lesson opens at, then am, pm (V and rad) and base
  const opening: Record<Kind, { samples: number[]; am: number; pm: number; rad: number; base: number }> = {
    thermal: {
      samples: [0.5, 0.757324219, 0.922302246, 0.935302734, 0.079101562, 0.757446289],
      am: 0, pm: 0.000004321, rad: 0.000009603, base: 0.000052284,
    },
    quantiser: {
      samples: [0.5, 0.757324219, 0.922119141, 0.935302734, 0.079101562, 0.757324219],
      am: 0.000004536, pm: 0, rad: 0, base: 0.000070459,
    },
    jitter: {
      samples: [0.5, 0.757324219, 0.922241211, 0.935302734, 0.079162598, 0.757385254],
      am: 0, pm: 0.000026636, rad: 0.000059191, base: 0.000020544,
    },
    settling: {
      samples: [0.5, 0.755554199, 0.920959473, 0.935180664, 0.080444336, 0.758544922],
      am: 0, pm: 0.000054657, rad: 0.000121626, base: 0,
    },
    memory: {
      samples: [0.500915527, 0.759887695, 0.926025391, 0.93963623, 0.080078125, 0.761779785],
      am: 0, pm: 0.000042116, rad: 0.000093206, base: 0.000061353,
    },
    interferer: {
      samples: [0.5, 0.757446289, 0.922424316, 0.935546875, 0.079101562, 0.757446289],
      am: 0.000954011, pm: 0, rad: 0, base: 0.000013971,
    },
  };

  for (const kind of Object.keys(sweeps) as Kind[]) {
    it(`reads ${kind} as ADCToolbox does`, () => {
      const rows = sweeps[kind], s = sweep(kind);
      expect(s.strengths).toEqual(rows.map((r) => r[0]));
      rows.forEach(([strength, sndr, snr, sfdr, enob, allowed], i) => {
        expect(s.sndr[i], `SNDR at ${strength}`).toBeCloseTo(sndr, 4);
        expect(s.snr[i], `SNR at ${strength}`).toBeCloseTo(snr, 4);
        expect(s.sfdr[i], `SFDR at ${strength}`).toBeCloseTo(sfdr, 4);
        expect(bits(s.sndr[i]), `ENOB at ${strength}`).toBeCloseTo(enob, 4);
        if (allowed === null) expect(s.limit[i]).toBeNull();
        else expect(s.limit[i]!, `the limit at ${strength}`).toBeCloseTo(allowed, 4);
      });
    });

    it(`captures and splits ${kind} at the strength the lesson opens at`, () => {
      const { samples, am, pm, rad, base } = opening[kind];
      const r = read(kind, SWEEPS[kind].start);
      [0, 1, 2, 3, 100, 2047].forEach((i, k) => expect(r.data[i], `sample ${i}`).toBeCloseTo(samples[k], 9));
      expect(r.split.am).toBeCloseTo(am, 9);
      expect(r.split.pm).toBeCloseTo(pm, 9);
      expect(r.split.radians).toBeCloseTo(rad, 9);
      expect(r.split.base).toBeCloseTo(base, 9);
      // the spectrum of that same capture, and the bits its SNR is worth
      const row = sweeps[kind].find((x) => x[0] === SWEEPS[kind].start)!;
      expect(r.spectrum.sndr).toBeCloseTo(row[1], 4);
      expect(r.spectrum.enob).toBeCloseTo(row[4], 4);
      expect(bits(r.snr)).toBeCloseTo(bits(row[2]), 4);
    });
  }

  it('reads a clock back out of the error once its jitter shows above the noise', () => {
    // set fs, then the fs measured back from the pm part; below ~20 fs the noise floor hides it
    const recovered: [number, number][] = [
      [1, 0], [2, 0], [5, 0], [10, 0], [20, 14.3993],
      [50, 49.2305], [100, 97.1949], [200, 204.0124], [500, 512.6265], [1000, 1021.0192],
    ];
    recovered.forEach(([set, out]) => {
      const { split } = splitError(capture('jitter', set * 1e-15));
      expect(jitterFrom(split) * 1e15, `${set} fs`).toBeCloseTo(out, 4);
    });
    expect(sweep('jitter').recovered!.map((v) => v * 1e15)[6]).toBeCloseTo(97.1949, 4);
  });

  it('moves the clock limit with frequency and leaves the other two where they are', () => {
    // fin MHz, then the limits for 100 fs of jitter, 50 uV of noise and 12 bits
    const rows: [number, number, number, number][] = [
      [10.009766, 104.0279, 76.0746, 73.093],
      [30.029297, 94.4855, 76.0746, 73.093],
      [96.923828, 84.3078, 76.0746, 73.093],
      [199.951172, 78.0179, 76.0746, 73.093],
      [400.146484, 71.992, 76.0746, 73.093],
    ];
    rows.forEach(([mhz, clock, noise, quantiser], i) => {
      const { fin } = coherentFrequency(FS, [10e6, 30e6, 97e6, 200e6, 400e6][i], 4096);
      expect(fin / 1e6).toBeCloseTo(mhz, 6);
      expect(limitOf('jitter', 1e-13, fin)!).toBeCloseTo(clock, 4);
      expect(limitOf('thermal', 5e-5, fin)!).toBeCloseTo(noise, 4);
      expect(limitOf('quantiser', 12, fin)!).toBeCloseTo(quantiser, 4);
    });
  });
});
