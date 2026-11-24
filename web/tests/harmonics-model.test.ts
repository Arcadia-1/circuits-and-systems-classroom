import { describe, expect, it } from 'vitest';
import {
  CASES,
  capture,
  decompose,
  estimateFrequency,
  fitStaticNonlin,
  hdToK,
  read,
  spectrumOf,
  TONE,
} from '../src/illustrations/harmonics/model';

interface Sheet {
  /** k2 and k3 as asked for, then as fit_static_nonlin got them back */
  k: [number, number, number, number];
  magnitudes: number[];
  db: number[];
  phases: number[];
  residualRms: number;
  noiseDb: number;
  frequency: number;
  /** the fundamental, the harmonics and what is left, at samples 0, 1, 2 and 100 */
  parts: [number[], number[], number[]];
  /** SNDR and SFDR, then harmonics 2 … 5 in dBc, as analyze_spectrum reports them */
  spectrum: [number, number, number[]];
  samples: number[];
}

describe('pulling the harmonics out', () => {
  // every number below is printed by python/adc_harmonics.py, which runs ADCToolbox on the same samples
  it('puts the tone on a coherent bin, with five harmonics under Nyquist', () => {
    expect(TONE.bin).toBe(397);
    expect(TONE.fin * 5).toBeLessThan(500e6);
  });

  const sheets: Record<string, Sheet> = {
    clean: {
      k: [0, 0.000002111, 0, -0.000030675],
      magnitudes: [0.899999615, 0.000000654, 0.000001407, 0.000001297, 0.000000851],
      db: [-0.0002, -122.7692, -116.119, -116.8232, -120.4858],
      phases: [0, 0.858681, -3.026113, -0.196891, -0.121544],
      residualRms: 0.000019912,
      noiseDb: -84.072,
      frequency: 0.096923828,
      parts: [
        [0.499971129, 0.757388623, 0.922251705, 0.079137021],
        [0.000000452, 0.000000504, -0.000000246, 0.000000824],
        [0.000028419, -0.000003873, -0.000010248, -0.000036282],
      ],
      spectrum: [84.0633, 107.7721, [-122.758, -116.1126, -116.816, -120.4863]],
      samples: [0.5, 0.757385254, 0.922241211, 0.935302734, 0.079101562, 0.757385254],
    },
    second: {
      k: [0.004444444, 0.004442715, 0, 0.000014247],
      magnitudes: [0.899998537, 0.000899643, 0.000001124, 0.000001683, 0.000001233],
      db: [-0.0002, -60.0037, -118.0692, -114.5638, -117.2625],
      phases: [0, -0.000718, -0.955176, -0.80022, -2.660784],
      residualRms: 0.000020172,
      noiseDb: -83.9591,
      frequency: 0.096923828,
      parts: [
        [0.500420025, 0.757837484, 0.922701091, 0.079588459],
        [-0.000449062, -0.000155989, 0.000341277, 0.000336638],
        [0.000029037, 0.000008934, -0.0000077, -0.000030078],
      ],
      spectrum: [59.986, 60.0034, [-60.0034, -118.0696, -114.5652, -117.2611]],
      samples: [0.5, 0.75769043, 0.923034668, 0.936157227, 0.07989502, 0.75769043],
    },
    third: {
      k: [0, 0.000003985, 0.019753086, 0.019906264],
      magnitudes: [0.900001059, 0.000001017, 0.000898854, 0.000000235, 0.000001287],
      db: [-0.0091, -118.9466, -60.0201, -131.6775, -116.9027],
      phases: [0, -0.662094, -0.000423, -2.206671, 3.133169],
      residualRms: 0.000020085,
      noiseDb: -84.0054,
      frequency: 0.096923828,
      parts: [
        [0.49996935, 0.757387532, 0.922251602, 0.079136607],
        [-0.000000275, -0.000435194, 0.000220282, -0.00020942],
        [0.000030924, 0.00000567, 0.000013467, -0.000008729],
      ],
      spectrum: [59.9937, 60.0111, [-118.9288, -60.0111, -131.6635, -116.8935]],
      samples: [0.5, 0.756958008, 0.922485352, 0.93560791, 0.078918457, 0.756958008],
    },
    both: {
      k: [0.007903464, 0.00793218, 0.011107977, 0.011157027],
      magnitudes: [0.900000882, 0.001600859, 0.000505777, 0.000001806, 0.000001219],
      db: [-0.0049, -55.0027, -65.0106, -113.9571, -117.3671],
      phases: [0, -0.001087, 0.000483, 0.53723, -1.602169],
      residualRms: 0.000020087,
      noiseDb: -84.0006,
      frequency: 0.096923828,
      parts: [
        [0.500768243, 0.75818668, 0.923051526, 0.079937868],
        [-0.000800382, -0.000522296, 0.000732781, 0.000482245],
        [0.000032139, -0.00003499, -0.000017217, -0.000036812],
      ],
      spectrum: [54.5796, 54.9978, [-54.9978, -65.0057, -113.9573, -117.3505]],
      samples: [0.5, 0.757629395, 0.92376709, 0.936950684, 0.080383301, 0.75769043],
    },
    buried: {
      k: [0.001405457, 0.001481239, 0.003512651, 0.003262583],
      magnitudes: [0.900002591, 0.000300117, 0.000148675, 0.000006317, 0.000010522],
      db: [-0.009, -69.5481, -75.6492, -103.0841, -98.6519],
      phases: [0, -0.055457, -0.057117, 2.804534, -2.214183],
      residualRms: 0.000200528,
      noiseDb: -64.0195,
      frequency: 0.096923826,
      parts: [
        [0.500127535, 0.757543669, 0.922401472, 0.079275641],
        [-0.000152782, -0.000126959, 0.000138384, 0.000079917],
        [0.000086282, -0.000153526, 0.000128601, -0.000253995],
      ],
      spectrum: [62.7073, 69.5395, [-69.5395, -75.6408, -103.0951, -98.6513]],
      samples: [0.500061035, 0.757263184, 0.922668457, 0.935668945, 0.079101562, 0.757568359],
    },
  };

  for (const [name, sheet] of Object.entries(sheets)) {
    it(`decomposes the ${name} capture as ADCToolbox does`, () => {
      const c = CASES[name];
      const x = capture(c);
      sheet.samples.forEach((v, k) => expect(x[[0, 1, 2, 3, 100, 2047][k]], `sample ${k}`).toBeCloseTo(v, 9));

      const d = decompose(x, 5);
      expect(d.frequency).toBeCloseTo(sheet.frequency, 9);
      sheet.magnitudes.forEach((v, h) => expect(d.magnitudes[h], `harmonic ${h + 1}`).toBeCloseTo(v, 9));
      sheet.db.forEach((v, h) => expect(d.db[h], `harmonic ${h + 1} in dB`).toBeCloseTo(v, 4));
      sheet.phases.forEach((v, h) => expect(d.phases[h], `phase ${h + 1}`).toBeCloseTo(v, 6));
      expect(d.residualRms).toBeCloseTo(sheet.residualRms, 9);
      expect(d.noiseDb).toBeCloseTo(sheet.noiseDb, 4);
      [0, 1, 2, 100].forEach((i, k) => {
        expect(d.fundamental[i], `fundamental at ${i}`).toBeCloseTo(sheet.parts[0][k], 9);
        expect(d.harmonic[i], `harmonics at ${i}`).toBeCloseTo(sheet.parts[1][k], 9);
        expect(d.residual[i], `residual at ${i}`).toBeCloseTo(sheet.parts[2][k], 9);
      });
      // the three parts add back up to the capture itself, which is what makes the split worth looking at
      [0, 7, 513, 4095].forEach((i) =>
        expect(d.fundamental[i] + d.harmonic[i] + d.residual[i], `the parts at ${i}`).toBeCloseTo(x[i], 9),
      );

      const s = fitStaticNonlin(x, 3);
      expect(hdToK(c.hd2, 2)).toBeCloseTo(sheet.k[0], 9);
      expect(s.k2).toBeCloseTo(sheet.k[1], 9);
      expect(hdToK(c.hd3, 3)).toBeCloseTo(sheet.k[2], 9);
      expect(s.k3).toBeCloseTo(sheet.k[3], 9);

      const spec = spectrumOf(x);
      expect(spec.sndr).toBeCloseTo(sheet.spectrum[0], 4);
      expect(spec.sfdr).toBeCloseTo(sheet.spectrum[1], 4);
      sheet.spectrum[2].forEach((v, h) =>
        expect(spec.dbfs[spec.harmonics[h]] - spec.dbfs[spec.signal], `spectrum harmonic ${h + 2}`).toBeCloseTo(v, 4),
      );
    });
  }

  it('finds the fundamental without being told where it is', () => {
    // the FFT estimate lands within a thousandth of a bin of the coherent frequency
    const x = capture(CASES.both);
    expect(estimateFrequency(x) * 4096).toBeCloseTo(397, 2);
    // and read() carries the same decomposition, static fit and spectrum as calling them one at a time
    const r = read(CASES.both);
    expect(r.decomposition.db[1]).toBeCloseTo(-55.0027, 4);
    expect(r.statik.k2).toBeCloseTo(0.00793218, 9);
    expect(r.k2).toBeCloseTo(0.007903464, 9);
    expect(r.spectrum.sndr).toBeCloseTo(54.5796, 4);
  });
});
