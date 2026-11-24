import { describe, expect, it } from 'vitest';
import {
  activity,
  ARRAYS,
  capture,
  enobSweep,
  FS,
  nominalWeights,
  overflow,
  read,
  reconstruct,
  spectrumOf,
  TONE,
  weightRadix,
  type ArrayName,
  type Fault,
} from '../src/illustrations/bits/model';
import { calibrateWeightSine } from '../src/lib/calibration';
import { npSum, roundEven } from '../src/lib/numeric';
import { gaussians } from '../src/lib/rng';
import { analyzeSpectrum, type Window } from '../src/lib/spectrum';

interface Case {
  array: ArrayName;
  amp: number;
  dc: number;
  noise: number;
  fault: Fault;
  activity: number[];
  weight: number[];
  radix: number[];
  lo: number[];
  hi: number[];
  atZero: number[];
  atOne: number[];
  sweep: number[];
  sides: number[];
  offset: number;
  wgtsca: number;
  effres: number;
  uncalibrated: [number, number];
}

describe('reading the bits', () => {
  // from python/adc_reading_the_bits.py: 8192 samples at 1 GS/s, a tone at bin 2457, the examples' SAR loop
  // compute_spectrum with side_bin left to auto detection: cycles, window, side bins, ENOB
  const sides: [number, Window, number, number][] = [
    [101, 'rectangular', 0, 12.36293],
    [101, 'hann', 1, 12.36527],
    [101, 'hamming', 1, 12.36509],
    [101, 'blackmanharris', 3, 12.3703],
    [101, 'flattop', 4, 12.3757],
    [101.1, 'rectangular', 1, 2.85763],
    [101.1, 'hann', 30, 12.38682],
    [101.1, 'hamming', 3, 6.67056],
    [101.1, 'blackmanharris', 9, 12.37315],
    [101.1, 'flattop', 8, 12.34789],
    [101.37, 'rectangular', 1, 1.17559],
    [101.37, 'hann', 43, 12.40157],
    [101.37, 'hamming', 3, 5.10715],
    [101.37, 'blackmanharris', 14, 12.37463],
    [101.37, 'flattop', 6, 12.15048],
    [250.5, 'rectangular', 1, 0.99282],
    [250.5, 'hann', 44, 12.40559],
    [250.5, 'hamming', 3, 4.98293],
    [250.5, 'blackmanharris', 14, 12.38273],
    [250.5, 'flattop', 9, 12.12093],
  ];

  // array, amplitude, offset, noise, fault; then per bit: activity (%), calibrated weight, radix to the next,
  // overflow low and high and the share of samples at 0 and at 1 (%), ENOB with the first k bits and its side bins;
  // the offset calibrate_weight_sine fits, wgtsca and effres, and ENOB with the capacitors as weights
  const cases: Case[] = [
    {
      array: 'binary', amp: 0.49, dc: 0, noise: 200e-6, fault: 'none',
      activity: [50, 50, 50, 50.0366, 49.9878, 49.9756, 49.939, 49.8901, 49.9634, 49.7681, 49.3042, 49.8901],
      weight: [1.020414944, 0.5102016577, 0.2551053087, 0.1275569512, 0.063776045, 0.03188791689, 0.01593422652, 0.007977832092, 0.003992047647, 0.001986584914, 0.0009922854528, 0.0004988805417],
      radix: [2.000023, 1.999965, 1.999933, 2.000076, 2.000007, 2.001222, 1.997313, 1.998431, 2.009503, 2.00203, 1.989024],
      lo: [0.009766, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [0.990234, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [0, 0.0122, 0.0366, 0.1343, 0.354, 0.7568, 1.6602, 3.0518, 6.3599, 12.6465, 25.2808, 50.1099],
      atOne: [0, 0.0122, 0.0488, 0.1465, 0.293, 0.6836, 1.5625, 2.9541, 6.3354, 12.4146, 24.4751, 49.8901],
      sweep: [0.75638, 1.92913, 2.98475, 4.02177, 5.03678, 5.97582, 7.00055, 7.97515, 8.95026, 9.88647, 10.68621, 11.19599],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 1.02016147, wgtsca: 2007.026664, effres: 11.998169, uncalibrated: [1, 10.69028],
    },
    {
      array: 'binary', amp: 0.499, dc: 0.01, noise: 0, fault: 'none',
      activity: [50.3296, 50.4028, 50.5493, 50.7935, 51.1353, 51.7212, 52.6733, 53.2715, 53.2715, 51.6479, 50.9399, 52.063],
      weight: [1.002145534, 0.5011651713, 0.2506856165, 0.1254728291, 0.06288065064, 0.03160195838, 0.01597915326, 0.008165591261, 0.004258041609, 0.002265343488, 0.001284396044, 0.0008067906462],
      radix: [1.999631, 1.999178, 1.997928, 1.995412, 1.989771, 1.977699, 1.956889, 1.917687, 1.879645, 1.763742, 1.591982],
      lo: [0.006191, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [0, 0.0244, 0.0488, 0.1221, 0.2686, 0.5859, 1.3672, 2.9541, 5.9082, 12.4634, 24.7681, 47.937],
      atOne: [4.1626, 4.1626, 4.2114, 4.3091, 4.5044, 4.8706, 5.5786, 7.1655, 10.0708, 15.9058, 27.771, 52.063],
      sweep: [0.75614, 1.91737, 2.95115, 3.95911, 4.95374, 5.91957, 6.82273, 7.68842, 8.36647, 8.78922, 9.00009, 9.09803],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 1.01320744, wgtsca: 1239.478922, effres: 11.280931, uncalibrated: [1, 8.97129],
    },
    {
      array: 'binary', amp: 0.499, dc: -0.01, noise: 0, fault: 'none',
      activity: [49.6704, 49.5972, 49.4507, 49.2065, 48.8647, 48.2788, 47.3267, 46.7285, 46.7285, 48.3521, 49.0601, 47.937],
      weight: [1.002145534, 0.5011651713, 0.2506856165, 0.1254728291, 0.06288065064, 0.03160195838, 0.01597915326, 0.008165591261, 0.004258041609, 0.002265343488, 0.001284396044, 0.0008067906462],
      radix: [1.999631, 1.999178, 1.997928, 1.995412, 1.989771, 1.977699, 1.956889, 1.917687, 1.879645, 1.763742, 1.591982],
      lo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [0.993809, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [4.1626, 4.1626, 4.2114, 4.3091, 4.5044, 4.8706, 5.5786, 7.1655, 10.0708, 15.9058, 27.771, 52.063],
      atOne: [0, 0.0244, 0.0488, 0.1221, 0.2686, 0.5859, 1.3672, 2.9541, 5.9082, 12.4634, 24.7681, 47.937],
      sweep: [0.75614, 1.91737, 2.95115, 3.95911, 4.95374, 5.91957, 6.82273, 7.68842, 8.36647, 8.78922, 9.00009, 9.09803],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 0.9935036364, wgtsca: 1239.478922, effres: 11.280931, uncalibrated: [1, 8.97129],
    },
    {
      array: 'binary', amp: 0.499, dc: 0, noise: 0, fault: 'contact',
      activity: [49.9878, 50.0122, 50.0122, 50.0122, 50.0122, 50.0122, 50.0122, 50.0122, 50.0122, 50.0122, 44.8853, 50.0122],
      weight: [1.002001302, 0.50101507, 0.2505177588, 0.1252522739, 0.06262364314, 0.03130859109, 0.01565914573, 0.007836408157, 0.003907436343, 0.001950553516, 0.0008944257557, 0.0004847859916],
      radix: [1.999942, 1.999918, 2.000105, 2.00008, 2.000206, 1.999381, 1.998256, 2.005511, 2.003245, 2.180789, 1.844991],
      lo: [0.000974, 0.000484, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [0.999026, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [0, 0, 0.0244, 0.1099, 0.293, 0.7324, 1.6113, 3.2715, 6.7383, 13.6353, 27.771, 49.9878],
      atOne: [0, 0.0244, 0.0488, 0.1099, 0.2808, 0.6348, 1.3306, 2.7344, 5.5176, 11.0474, 22.6685, 50.0122],
      sweep: [0.75638, 1.91818, 2.95361, 3.96665, 4.97858, 5.99309, 7.00871, 8.01817, 9.00839, 9.99308, 10.6972, 11.18569],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 1.001679773, wgtsca: 2043.90952, effres: 12.013201, uncalibrated: [1, 10.68528],
    },
    {
      array: 'binary', amp: 0.499, dc: 0, noise: 200e-6, fault: 'lsb',
      activity: [50, 49.9878, 50.0244, 49.9878, 49.9268, 50.0244, 50.1953, 50.1953, 50.2197, 50.1099, 49.646, 49.1577],
      weight: [1.001998449, 0.5010098939, 0.2505044774, 0.1252594915, 0.0626302785, 0.0313303054, 0.01566108502, 0.007825266035, 0.003910972343, 0.00194799912, 0.0009857006339, 7.396966148e-06],
      radix: [1.999957, 2.000004, 1.999884, 1.999983, 1.999032, 2.000519, 2.001349, 2.000849, 2.007687, 1.976258, 133.257421],
      lo: [0.000492, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [0.999508, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [0, 0.0244, 0.0366, 0.0977, 0.2441, 0.4639, 1.0986, 2.8076, 6.0669, 12.7319, 26.062, 50.8423],
      atOne: [0, 0.0122, 0.0366, 0.1343, 0.3662, 0.6958, 1.416, 2.9663, 5.9326, 12.3291, 24.8657, 49.1577],
      sweep: [0.75638, 1.91779, 2.95315, 3.96604, 4.97788, 5.99281, 7.0071, 8.01226, 8.98249, 9.90532, 10.69896, 10.69894],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 1.001535198, wgtsca: 1021.95767, effres: 10.989481, uncalibrated: [1, 9.91409],
    },
    {
      array: 'binary', amp: 0.55, dc: 0, noise: 200e-6, fault: 'none',
      activity: [50, 50, 50.0122, 49.9878, 49.9756, 49.9634, 50.0366, 50.0732, 50.0244, 49.939, 49.9146, 50.293],
      weight: [0.9149649278, 0.4609262092, 0.2345126445, 0.1211622357, 0.06491613594, 0.03734445527, 0.02271506216, 0.01594948965, 0.01262039711, 0.01068827697, 0.009927776233, 0.009599325365],
      radix: [1.985057, 1.965464, 1.935526, 1.866443, 1.738307, 1.644039, 1.424187, 1.263787, 1.18077, 1.076603, 1.034216],
      lo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [13.7085, 13.7207, 13.7695, 13.8428, 14.0259, 14.2822, 14.7949, 15.8325, 18.2007, 22.6562, 31.5308, 49.707],
      atOne: [13.7085, 13.7207, 13.7573, 13.8184, 13.9648, 14.2822, 14.8315, 15.8325, 18.1152, 22.6562, 31.7383, 50.293],
      sweep: [0.75638, 1.84319, 2.72224, 3.43981, 3.96398, 4.30391, 4.5049, 4.62902, 4.7128, 4.77367, 4.81798, 4.85225],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 0.9576839777, wgtsca: 104.1739874, effres: 7.647654, uncalibrated: [1, 4.42831],
    },
    {
      array: 'redundant', amp: 0.49, dc: 0, noise: 200e-6, fault: 'none',
      activity: [50, 50, 50, 50.0244, 49.9634, 49.9634, 50, 50.1343, 49.7437, 50.1465, 50.1953, 49.3774, 50.8667],
      weight: [0.9070303992, 0.4535170066, 0.2267570015, 0.226762388, 0.1133827451, 0.05668483743, 0.02834051583, 0.0141710536, 0.007078523137, 0.003543208332, 0.001770274543, 0.0008836142176, 0.0004417884122],
      radix: [1.999992, 2.000013, 0.999976, 1.999973, 2.000231, 2.000134, 1.999888, 2.001979, 1.997772, 2.001502, 2.003447, 2.000085],
      lo: [0.009766, 0.017582, 0.029311, 0.043982, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [0.990234, 0.982418, 0.970689, 0.956018, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [0, 0, 0, 0, 0.1709, 0.3174, 0.6592, 1.5625, 3.125, 6.5552, 12.4634, 24.5239, 49.1333],
      atOne: [0, 0, 0, 0, 0.1099, 0.3052, 0.6592, 1.5015, 2.8931, 6.7383, 12.6953, 24.7681, 50.8667],
      sweep: [0.75638, 1.83846, 2.7044, 3.16159, 4.1965, 5.20359, 6.12605, 7.16688, 8.10806, 9.10328, 10.038, 10.78601, 11.22088],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 1.020182618, wgtsca: 2257.917708, effres: 12.173495, uncalibrated: [1, 10.77917],
    },
    {
      array: 'subradix', amp: 0.49, dc: 0, noise: 200e-6, fault: 'none',
      activity: [50, 50, 50.0122, 49.9756, 50.0488, 49.8657, 50.061, 49.939, 50.2441, 49.9756, 49.5972, 50.2441, 50.5859, 50.1221],
      weight: [0.9080812678, 0.5043120692, 0.2804359813, 0.155536162, 0.08640867164, 0.04791976693, 0.0267017541, 0.01414166242, 0.007850581517, 0.003931195313, 0.002347048988, 0.001575118194, 0.0007902371706, 0.0004023263289],
      radix: [1.800634, 1.798314, 1.803028, 1.800006, 1.803195, 1.79463, 1.888162, 1.801352, 1.996996, 1.674952, 1.490078, 1.993222, 1.96417],
      lo: [0.009629, 0.017351, 0.031285, 0.056524, 0.096144, 0.093016, 0.088739, 0.076208, 0.093222, 0.087358, 0.154502, 0.145366, 0, 0],
      hi: [0.990371, 0.982649, 0.968715, 0.943476, 0.903856, 0.906984, 0.911261, 0.923792, 0.906778, 0.912642, 0.845498, 0.854634, 1, 1],
      atZero: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 18.5669, 49.8779],
      atOne: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19.2749, 50.1221],
      sweep: [0.75638, 1.85343, 2.80928, 3.72684, 4.66342, 5.56033, 6.34132, 7.28049, 8.1098, 9.05506, 9.77637, 10.28445, 10.87072, 11.27758],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 1.020216413, wgtsca: 2546.027632, effres: 12.308507, uncalibrated: [1, 10.90183],
    },
    {
      array: 'subradix', amp: 0.52, dc: 0.005, noise: 500e-6, fault: 'contact',
      activity: [50.1587, 50.1709, 50.1953, 50.3784, 50.3296, 50.354, 50.5737, 50.5493, 50.4883, 49.9634, 51.0864, 50.2808, 45.166, 51.2329],
      weight: [0.8559013291, 0.4755704189, 0.2651001342, 0.1479186684, 0.08358939628, 0.04805826807, 0.02903759066, 0.01742422031, 0.01201360613, 0.007586413622, 0.006904550816, 0.008312277574, 0.006333798111, 0.003907636769],
      radix: [1.799736, 1.793927, 1.792202, 1.769587, 1.739334, 1.655036, 1.666507, 1.450374, 1.583569, 1.098756, 0.830645, 1.312369, 1.620877],
      lo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      hi: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      atZero: [8.374, 8.374, 8.374, 8.374, 8.374, 8.374, 8.374, 8.374, 8.374, 8.5938, 8.9478, 9.9243, 26.3794, 48.7671],
      atOne: [8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 8.5205, 22.7783, 51.2329],
      sweep: [0.75632, 1.80415, 2.67067, 3.44335, 4.15672, 4.76543, 5.25618, 5.62447, 5.88391, 6.06759, 6.1842, 6.2765, 6.39799, 6.45386],
      sides: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      offset: 0.9876818405, wgtsca: 255.9091489, effres: 8.97883, uncalibrated: [1, 5.82285],
    },
  ];

  // analyze_weight_radix on exp_d13's nominal weights, and on a list with a negative and a trim weight
  const radixes: [string, number[], number, number][] = [
    ['exp_d13 binary', [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], 2, 12],
    ['exp_d13 redundant', [2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2], 2, 12.169925],
    ['exp_d13 subradix', [1.800623, 1.798319, 1.80303, 1.8, 1.803279, 1.794118, 1.888889, 1.8, 2, 1.666667, 1.5, 2, 2], 2, 12.343186],
    ['trimmed', [1.969231, 2.047244, 1.984375, 1.939394, 2.129032, 1.9375, 1.95122, 2.05, 2, 5], 0.96875, 10.005063],
  ];

  it('tests at the examples’ tone', () => {
    expect(TONE.bin).toBe(2457);
    expect(TONE.fin / 1e6).toBeCloseTo(299.926758, 5);
  });

  it('picks the side bins as analyze_spectrum does when it is not told how many', () => {
    const noise = gaussians(4096, 3);
    for (const [cycles, kind, sideBin, enob] of sides) {
      const x = Float64Array.from({ length: 4096 }, (_, i) => 0.9 * Math.sin((2 * Math.PI * cycles * i) / 4096 + 0.3) + noise[i] * 1e-4);
      const s = analyzeSpectrum(x, 1, kind, 'auto');
      expect([cycles, kind, s.sideBin]).toEqual([cycles, kind, sideBin]);
      expect(s.enob).toBeCloseTo(enob, 4);
    }
  });

  it.each(cases.map((c) => [c.array, c.amp, c.dc, c.fault, c] as const))('matches ADCToolbox for the %s array at %s, offset %s, fault %s', (array, amp, dc, fault, c) => {
    const caps = ARRAYS[array], m = caps.length;
    const bits = capture(caps, amp, dc, c.noise, fault);
    activity(bits, m).forEach((v, j) => expect(v).toBeCloseTo(c.activity[j], 3));

    const fit = calibrateWeightSine(bits, m, TONE.fin / FS);
    fit.weight.forEach((w, j) => expect(w / c.weight[j]).toBeCloseTo(1, 6));
    expect(fit.offset / c.offset).toBeCloseTo(1, 6);

    const r = weightRadix(fit.weight);
    r.radix.forEach((v, j) => expect(v).toBeCloseTo(c.radix[j], 5));
    expect(r.wgtsca / c.wgtsca).toBeCloseTo(1, 7);
    expect(r.effres).toBeCloseTo(c.effres, 5);

    const o = overflow(bits, m, fit.weight);
    o.lo.forEach((v, j) => expect(v).toBeCloseTo(c.lo[j], 5));
    o.hi.forEach((v, j) => expect(v).toBeCloseTo(c.hi[j], 5));
    o.atZero.forEach((v, j) => expect(v).toBeCloseTo(c.atZero[j], 3));
    o.atOne.forEach((v, j) => expect(v).toBeCloseTo(c.atOne[j], 3));

    enobSweep(bits, m, fit.weight).forEach((v, j) => expect(v).toBeCloseTo(c.sweep[j], 4));
    c.sides.forEach((sb, k) => expect(spectrumOf(reconstruct(bits, m, fit.weight, k + 1)).sideBin).toBe(sb));
    const nominal = spectrumOf(reconstruct(bits, m, caps));
    expect(nominal.sideBin).toBe(c.uncalibrated[0]);
    expect(nominal.enob).toBeCloseTo(c.uncalibrated[1], 4);
  });

  it('reads exp_d13’s nominal weights as analyze_weight_radix does', () => {
    const lists: Record<string, number[]> = {
      'exp_d13 binary': nominalWeights(ARRAYS.binary),
      'exp_d13 redundant': nominalWeights(ARRAYS.redundant),
      'exp_d13 subradix': nominalWeights(ARRAYS.subradix),
      trimmed: [512, 260, -127, 64, 33, 15.5, 8, 4.1, 2, 1, 0.2],
    };
    for (const [name, radix, wgtsca, effres] of radixes) {
      const r = weightRadix(lists[name]);
      r.radix.forEach((v, j) => expect(v).toBeCloseTo(radix[j], 5));
      expect(r.wgtsca).toBeCloseTo(wgtsca, 8);
      expect(r.effres).toBeCloseTo(effres, 5);
    }
    // the trim weight is three times smaller than the one before it, so it is not counted
    expect(weightRadix(lists.trimmed).significant).toBe(10);
  });

  it('reads the whole page in one call', () => {
    const c = cases[0];
    const r = read(c.array, c.amp, c.dc, c.noise, c.fault);
    expect(r.sweep!.at(-1)).toBeCloseTo(c.sweep.at(-1)!, 4);
    expect(read(c.array, c.amp, c.dc, c.noise, c.fault, false).sweep).toBeNull();
    expect(r.uncalibrated).toBeCloseTo(c.uncalibrated[1], 4);
    expect(r.nominal.effres).toBeCloseTo(12, 9);
    expect(r.overflow.share).toHaveLength(12);
  });

  it('adds as numpy adds, and rounds halves to even', () => {
    // 1e16 swallows a 1 added to it alone, but not a 2
    const a = [1e16, 1, 1, 1, 1, 1, 1, 1, 1, -1e16];
    let plain = 0;
    for (const v of a) plain += v;
    expect(plain).toBe(0);
    // numpy: r[0] = 1e16 + 1 (lost), …, ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7)) + 1 − 1e16
    expect(npSum(a)).toBe(8);
    expect(npSum(Array.from({ length: 300 }, (_, i) => i))).toBe(44850);
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(roundEven)).toEqual([0, 2, 2, -0, -2, 2, 3]);
  });
});
