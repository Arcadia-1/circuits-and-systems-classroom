import { describe, expect, it } from 'vitest';
import { alignPhase, type AveragedSpectrum } from '../src/lib/averaged-spectrum';
import { fft } from '../src/lib/fft';
import { coherentFrequency } from '../src/lib/frequency';
import { capture, CHECKPOINTS, curve, FS, N, phaseDeg, polarOf, RADIAL, read, spectrumOf, type Setting } from '../src/illustrations/polar/model';

interface Side {
  bin: number;
  refined: number;
  side: number;
  metrics: number[];
  spur: number;
  harmonicBins: number[];
  harmonics: number[];
  dbfs: number[];
  phases?: number[];
  magnitudes?: number[];
  others?: number[];
  percentile?: number;
}
interface Case {
  name: string;
  source: 'static' | 'memory';
  target: number;
  runs: number;
  params: (number | null)[];
  noise: number;
  fin: number;
  bin: number;
  power: Side;
  coherent: Side;
}

const setting = (c: Case): Setting =>
  c.source === 'static'
    ? { source: 'static', target: c.target, hd2: c.params[0], hd3: c.params[1], sign: c.params[2] as 1 | -1, memory: 0, noise: c.noise }
    : { source: 'memory', target: c.target, hd2: null, hd3: null, sign: 1, memory: c.params[0]!, noise: c.noise };

/** degrees apart, the short way round */
const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** np.percentile with its default linear interpolation */
function percentile(values: ArrayLike<number>, q: number): number {
  const s = Array.from(values).sort((a, b) => a - b), at = (q / 100) * (s.length - 1), lo = Math.floor(at);
  return s[lo] + (at - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]);
}

function expectSide(s: AveragedSpectrum, e: Side, bin: number) {
  expect([s.signal, s.sideBin, s.spur]).toEqual([e.bin, e.side, e.spur]);
  expect(s.refined).toBeCloseTo(e.refined, 5);
  [s.sigDbfs, s.sndr, s.snr, s.thd, s.sfdr].forEach((v, i) => expect(v).toBeCloseTo(e.metrics[i], 3));
  expect(s.harmonicBins).toEqual(e.harmonicBins);
  s.harmonics.forEach((v, i) => expect(v).toBeCloseTo(e.harmonics[i], 3));
  [1, 5, bin, e.harmonicBins[0], 100, 511, 512].forEach((k, i) => expect(s.dbfs[k]).toBeCloseTo(e.dbfs[i], 3));
}

describe('averaging and the polar spectrum', () => {
  // from python/adc_polar_averaging.py: 1024 samples at 100 MHz, a 0.499 V sine, the rectangular window
  // name, source, target, runs, [hd2, hd3, sign] or [memory], noise; then for power and coherent averaging: bin,
  // refined bin, side bins, [signal dBFS, SNDR, SNR, THD, SFDR], spur bin, harmonic bins, their dBc, and dBFS at bins
  // 1, 5, the tone, H2, 100, 511 and 512; for coherent averaging also the phase (deg) and |V| (dB) at the tone and
  // H2 … H5, |V| at bins 3, 77, 300 and 511, and the first percentile of |V| in dB
  const cases: Case[] = [
    {
      name: 's12 one run', source: 'static', target: 5e6, runs: 1, params: [-80, -73, 1], noise: 100e-6, fin: 4.980469, bin: 51,
      power: { bin: 51, refined: 51, side: 0, metrics: [-0.0037, 68.4233, 71.012, -72.0715, 72.7027], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-80.7983, -72.7027, -111.4838, -101.718], dbfs: [-106.5359, -98.7697, -0.0037, -80.802, -112.2834, -98.7498, -102.4995] },
      coherent: { bin: 51, refined: 51, side: 0, metrics: [-0.0037, 68.4233, 71.012, -72.0715, 72.7027], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-80.7983, -72.7027, -111.4838, -101.718], dbfs: [-106.5359, -98.7697, -0.0037, -80.802, -112.2834, -98.7498, -102.4995], phases: [0, 4.5114, -4.4796, 113.6209, 131.0013], magnitudes: [-0.0037, -80.802, -72.7064, -111.4875, -101.7217], others: [-97.0038, -94.0654, -105.6576, -98.7498], percentile: -120.0363 },
    },
    {
      name: 's12 ten runs', source: 'static', target: 5e6, runs: 10, params: [-80, -73, 1], noise: 100e-6, fin: 4.980469, bin: 51,
      power: { bin: 51, refined: 51, side: 0, metrics: [-0.0047, 68.5589, 70.9163, -72.3179, 73.1204], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-80.1515, -73.1204, -100.9832, -98.0627], dbfs: [-99.5856, -98.7593, -0.0047, -80.1562, -102.3111, -98.8172, -103.1223] },
      coherent: { bin: 51, refined: 51, side: 0, metrics: [-0.0047, 71.8101, 81.2456, -72.3523, 73.128], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-80.2294, -73.128, -110.0572, -106.8496], dbfs: [-117.0686, -107.3733, -0.0047, -80.2341, -110.0408, -102.3401, -111.5226], phases: [0, 3.1802, -1.1533, -168.837, 84.6198], magnitudes: [-0.0047, -80.2341, -73.1327, -110.0619, -106.8543], others: [-107.7843, -107.9599, -114.401, -102.3401], percentile: -129.6892 },
    },
    {
      name: 's12 hundred runs', source: 'static', target: 5e6, runs: 100, params: [-80, -73, 1], noise: 100e-6, fin: 4.980469, bin: 51,
      power: { bin: 51, refined: 51, side: 0, metrics: [-0.0065, 68.5451, 70.9541, -72.1878, 72.9745], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-80.1314, -72.9745, -97.9534, -98.2594], dbfs: [-98.2445, -98.1321, -0.0065, -80.1379, -98.7157, -98.3773, -100.1546] },
      coherent: { bin: 51, refined: 51, side: 0, metrics: [-0.0065, 72.1801, 91.0678, -72.2365, 72.9906], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-80.2131, -72.9906, -118.1397, -120.0246], dbfs: [-122.1872, -117.4913, -0.0065, -80.2195, -119.1501, -118.7773, -121.7208], phases: [0, 0.2772, -0.3701, -42.9045, -41.5236], magnitudes: [-0.0065, -80.2195, -72.997, -118.1461, -120.0311], others: [-135.6593, -154.1092, -128.1765, -118.7773], percentile: -140.3481 },
    },
    {
      name: 's11 k3 < 0', source: 'static', target: 13e6, runs: 10, params: [null, -66, -1], noise: 50e-6, fin: 12.988281, bin: 133,
      power: { bin: 133, refined: 133, side: 0, metrics: [0.0026, 65.65, 76.9235, -65.9849, 65.9876], spur: 399, harmonicBins: [266, 399, 492, 359], harmonics: [-104.0627, -65.9876, -102.1607, -102.5895], dbfs: [-105.58, -104.7538, 0.0026, -104.0602, -108.3055, -104.8116, -109.1167] },
      coherent: { bin: 133, refined: 133, side: 0, metrics: [0.0026, 65.9555, 87.4044, -65.9879, 65.9882], spur: 399, harmonicBins: [266, 399, 492, 359], harmonics: [-109.0342, -65.9882, -113.1942, -117.1797], dbfs: [-114.1714, -119.4166, 0.0026, -109.0316, -124.3086, -121.5016, -117.5154], phases: [0, 161.5617, -179.9254, 57.4608, 87.569], magnitudes: [0.0026, -109.0316, -65.9856, -113.1916, -117.1771], others: [-115.0106, -114.3566, -118.2862, -121.5016], percentile: -133.7462 },
    },
    {
      name: 's07 levels', source: 'static', target: 5e6, runs: 30, params: [-100, -90, 1], noise: 100e-6, fin: 4.980469, bin: 51,
      power: { bin: 51, refined: 51, side: 0, metrics: [-0.0046, 70.876, 70.9565, -87.595, 89.3526], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-95.7117, -89.3526, -97.2732, -99.0913], dbfs: [-100.0438, -97.5147, -0.0046, -95.7163, -99.645, -99.5047, -100.6843] },
      coherent: { bin: 51, refined: 51, side: 0, metrics: [-0.0046, 84.3699, 85.9227, -89.5899, 89.8704], spur: 153, harmonicBins: [102, 153, 204, 255], harmonics: [-102.9648, -89.8704, -108.114, -115.5636], dbfs: [-115.0948, -118.6604, -0.0046, -102.9694, -112.2761, -112.1076, -114.581], phases: [0, -1.1205, -6.7151, -148.1864, 41.8474], magnitudes: [-0.0046, -102.9694, -89.875, -108.1185, -115.5682], others: [-115.5092, -124.8318, -128.3773, -112.1076], percentile: -134.715 },
    },
    {
      name: 'memory 5 MHz', source: 'memory', target: 5e6, runs: 1, params: [0.02], noise: 50e-6, fin: 4.980469, bin: 51,
      power: { bin: 51, refined: 51, side: 0, metrics: [-0.001, 59.8243, 65.6295, -67.8818, 69.2682], spur: 349, harmonicBins: [102, 153, 204, 255], harmonics: [-105.1552, -70.7083, -116.8649, -71.0859], dbfs: [-97.9041, -102.8777, -0.001, -105.1562, -118.4031, -86.055, -108.8096] },
      coherent: { bin: 51, refined: 51, side: 0, metrics: [-0.001, 59.8243, 65.6295, -67.8818, 69.2682], spur: 349, harmonicBins: [102, 153, 204, 255], harmonics: [-105.1552, -70.7083, -116.8649, -71.0859], dbfs: [-97.9041, -102.8777, -0.001, -105.1562, -118.4031, -86.055, -108.8096], phases: [0, 142.2519, 127.7035, 115.4245, 93.2704], magnitudes: [-0.001, -105.1562, -70.7093, -116.8659, -71.0869], others: [-87.983, -97.5213, -111.4131, -86.055], percentile: -119.2678 },
    },
    {
      name: 'memory 20 MHz', source: 'memory', target: 20e6, runs: 10, params: [0.02], noise: 50e-6, fin: 20.019531, bin: 205,
      power: { bin: 205, refined: 205, side: 0, metrics: [-0.0018, 59.7401, 65.4511, -67.8644, 69.247], spur: 419, harmonicBins: [410, 409, 204, 1], harmonics: [-104.1974, -70.4556, -105.8393, -71.3424], dbfs: [-71.3443, -80.2675, -0.0018, -104.1992, -106.7151, -95.9186, -109.0414] },
      coherent: { bin: 205, refined: 205, side: 0, metrics: [-0.0018, 59.9595, 66.3573, -67.8698, 69.2495], spur: 419, harmonicBins: [410, 409, 204, 1], harmonics: [-111.2276, -70.4583, -121.4757, -71.3478], dbfs: [-71.3496, -80.302, -0.0018, -111.2295, -117.4685, -103.418, -119.5545], phases: [0, -52.4637, 32.543, -27.8922, -175.4838], magnitudes: [-0.0018, -111.2295, -70.4602, -121.4775, -71.3496], others: [-80.2932, -95.4177, -112.9291, -103.418], percentile: -129.8901 },
    },
    {
      name: 'memory 37 MHz', source: 'memory', target: 37e6, runs: 1, params: [0.05], noise: 200e-6, fin: 37.011719, bin: 379,
      power: { bin: 379, refined: 379, side: 0, metrics: [-0.0128, 51.1977, 56.6941, -59.3034, 60.8874], spur: 405, harmonicBins: [266, 113, 492, 153], harmonics: [-103.6038, -62.1402, -93.3518, -62.4983], dbfs: [-96.5905, -79.6658, -0.0128, -103.6166, -101.0355, -81.2159, -103.6891] },
      coherent: { bin: 379, refined: 379, side: 0, metrics: [-0.0128, 51.1977, 56.6941, -59.3034, 60.8874], spur: 405, harmonicBins: [266, 113, 492, 153], harmonics: [-103.6038, -62.1402, -93.3518, -62.4983], dbfs: [-96.5905, -79.6658, -0.0128, -103.6166, -101.0355, -81.2159, -103.6891], phases: [0, 150.0829, 147.1397, -125.8748, 113.796], magnitudes: [-0.0128, -103.6166, -62.153, -93.3646, -62.5111], others: [-84.527, -82.5158, -94.7322, -81.2159], percentile: -105.2182 },
    },
  ];

  // exp_s12's setting over 1 … 100 runs: runs, SNDR and SNR power-averaged, SNDR and SNR coherently averaged
  const levels = [
    [1, 68.4233, 71.012, 68.4233, 71.012],
    [2, 68.4634, 70.8997, 69.9573, 73.9812],
    [3, 68.6208, 71.0073, 70.7408, 75.8799],
    [5, 68.5828, 70.9601, 71.3096, 77.9895],
    [7, 68.5705, 70.9103, 71.6584, 79.7267],
    [10, 68.5589, 70.9163, 71.8101, 81.2456],
    [15, 68.5484, 70.9087, 71.9552, 82.8358],
    [20, 68.5883, 70.9473, 72.0601, 84.0628],
    [30, 68.5338, 70.9615, 72.0642, 85.9277],
    [50, 68.5298, 70.9576, 72.0957, 88.4079],
    [70, 68.5289, 70.9442, 72.125, 89.615],
    [100, 68.5451, 70.9541, 72.1801, 91.0678],
  ];

  it.each(cases.map((c) => [c.name, c] as const))('matches ADCToolbox for %s', (_, c) => {
    const { fin, bin, data } = capture(setting(c), c.runs);
    expect(fin / 1e6).toBeCloseTo(c.fin, 5);
    expect(bin).toBe(c.bin);
    expect(data).toHaveLength(c.runs);
    expectSide(spectrumOf(data, false), c.power, bin);
    const s = spectrumOf(data, true);
    expectSide(s, c.coherent, bin);
    const bins = [bin, ...s.harmonicBins];
    const mags = (k: number) => 20 * Math.log10(Math.hypot(s.re![k], s.im![k]) + 1e-20);
    bins.forEach((k, i) => {
      expect(mags(k)).toBeCloseTo(c.coherent.magnitudes![i], 3);
      // a phase is only as steady as the bin is above the noise
      expect(apart(phaseDeg(s, k), c.coherent.phases![i])).toBeLessThan(mags(k) > -110 ? 1e-3 : 0.05);
    });
    [3, 77, 300, 511].forEach((k, i) => expect(mags(k)).toBeCloseTo(c.coherent.others![i], 3));
    expect(percentile(Array.from(s.re!, (_, k) => mags(k)), 1)).toBeCloseTo(c.coherent.percentile!, 3);
  });

  it('averages the runs both ways as the reference does', () => {
    const c = curve(setting(cases[0]));
    expect(c.runs).toEqual(CHECKPOINTS);
    levels.forEach(([runs, ps, pn, cs, cn], i) => {
      expect(c.runs[i]).toBe(runs);
      expect(c.powerSndr[i]).toBeCloseTo(ps, 3);
      expect(c.powerSnr[i]).toBeCloseTo(pn, 3);
      expect(c.coherentSndr[i]).toBeCloseTo(cs, 3);
      expect(c.coherentSnr[i]).toBeCloseTo(cn, 3);
    });
  });

  it('gains 10 dB of SNR per decade of runs only when it averages coherently', () => {
    const at = (runs: number) => levels.find((l) => l[0] === runs)!;
    expect(at(100)[2] - at(1)[2]).toBeLessThan(0.5);
    expect(at(100)[4] - at(10)[4]).toBeCloseTo(10, 0);
    expect(at(10)[4] - at(1)[4]).toBeCloseTo(10, 0);
  });

  it('puts a static curve’s harmonics at 0°, or at 180° when the cubic term is negative', () => {
    const r = read({ source: 'static', target: 5e6, hd2: -60, hd3: -60, sign: 1, memory: 0, noise: 1e-6 }, 1);
    const [h2, h3] = r.coherent.harmonicBins;
    expect(apart(phaseDeg(r.coherent, h2), 0)).toBeLessThan(0.1);
    expect(apart(phaseDeg(r.coherent, h3), 0)).toBeLessThan(0.1);
    const flipped = read({ source: 'static', target: 5e6, hd2: -60, hd3: -60, sign: -1, memory: 0, noise: 1e-6 }, 1);
    expect(apart(phaseDeg(flipped.coherent, flipped.coherent.harmonicBins[1]), 180)).toBeLessThan(0.1);
  });

  it('draws the polar plot from the aligned spectrum, clamped to the radial range', () => {
    const r = read(setting(cases[1]), 10);
    const p = polarOf(r.coherent);
    expect(p.radius[r.bin]).toBeCloseTo(RADIAL + c1Magnitude(r.coherent, r.bin), 9);
    expect(p.phase[r.bin]).toBeCloseTo(0, 9);
    expect(Math.min(...p.radius)).toBeGreaterThanOrEqual(0);
    // DC is dropped by the alignment
    expect(p.radius[0]).toBe(0);
  });

  it('aligns a clean tone and its harmonics to zero phase, the odd zones conjugated', () => {
    // bin 300 of 1024: H2 lands at 424 from the second zone, H3 at 124 from the third
    const n = 1024, bin = 300;
    const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * bin * i) / n + 1) + 0.01 * Math.cos((2 * Math.PI * 2 * bin * i) / n + 2) + 0.01 * Math.cos((2 * Math.PI * 3 * bin * i) / n + 3));
    const im = new Float64Array(n);
    fft(re, im);
    alignPhase(re, im, bin, bin);
    expect(Math.atan2(im[bin], re[bin])).toBeCloseTo(0, 9);
    // cos(2θ + 2) after θ's phase of 1 is taken out twice is at 0; folded from the second zone it shows at bin 424
    expect(Math.atan2(im[424], re[424])).toBeCloseTo(0, 9);
    expect(Math.atan2(im[124], re[124])).toBeCloseTo(0, 9);
    expect([re[0], im[0]]).toEqual([0, 0]);
  });

  it('finds the coherent tones the reference uses', () => {
    expect(coherentFrequency(FS, 5e6, N).bin).toBe(51);
    expect(coherentFrequency(FS, 37e6, N).bin).toBe(379);
  });
});

function c1Magnitude(s: AveragedSpectrum, k: number): number {
  return 20 * Math.log10(Math.hypot(s.re![k], s.im![k]) + 1e-20);
}
