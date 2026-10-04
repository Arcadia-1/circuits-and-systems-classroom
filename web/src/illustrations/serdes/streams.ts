/**
 * Symbol streams driven by a LinkAnalysis: a slow-motion stream for the 3-D view (one T/H sample and one slicer
 * decision per symbol) and a fast statistical stream that fills the eye diagrams. No DOM here.
 */
import { mulberry32 } from '../../lib/rng';
import { BAUD, EA, LEVELS, NF, NFLY, NFPRE, OS, PLEN, POST, PRE, PS, Prbs13, STX2, T0, VPK, metrics, pulse, stage, waveAt, type LinkAnalysis, type Metrics } from './model';

export const RING = 1024;
export const MASK = RING - 1;

/** Box–Muller normals from a seeded uniform generator. */
export function normals(seed: number): () => number {
  const rnd = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u = rnd() || 1e-12, th = 2 * Math.PI * rnd(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

/** The receiver as it runs: the analysis plus FFE taps that adapt toward the MMSE target. */
export class Receiver {
  a: LinkAnalysis;
  dsp: boolean;
  taps: Float64Array;
  live: Metrics;
  constructor(a: LinkAnalysis, dsp: boolean) {
    this.a = a;
    this.dsp = dsp;
    this.taps = Float64Array.from(a.weights);
    this.live = metrics(a.h, this.taps, a.noise, dsp && a.dfe);
  }
  /** Take a new analysis; the taps keep their values and adapt from there. */
  retarget(a: LinkAnalysis, dsp: boolean): void {
    this.a = a;
    this.dsp = dsp;
    this.live = metrics(a.h, this.taps, a.noise, dsp && a.dfe);
  }
  /** Move the taps toward the MMSE solution with time constant tau; returns true while they are still moving. */
  adapt(dt: number, tau = 0.5): boolean {
    const k = 1 - Math.exp(-dt / tau), target = this.a.weights;
    let moved = 0;
    for (let i = 0; i < NF; i++) {
      const e = target[i] - this.taps[i];
      this.taps[i] += e * k;
      moved += Math.abs(e);
    }
    this.live = metrics(this.a.h, this.taps, this.a.noise, this.dsp && this.a.dfe);
    return moved > 0.02 * (Math.abs(target[NFPRE]) || 1);
  }
  /** Slow-motion time at which the ADC samples symbol n (symbol n leaves the driver at t ≈ n). */
  get tSample(): number {
    return NFLY + (PS + this.a.tsOff) / OS - T0;
  }
}

/** Slow-motion stream: symbols, ADC samples at the CDR phase, FFE + DFE decisions and the errors among them. */
export class SymbolStream {
  readonly sym = new Uint8Array(RING);
  readonly level = new Float32Array(RING);
  readonly sample = new Float32Array(RING);
  readonly decision = new Uint8Array(RING);
  readonly error = new Uint8Array(RING);
  generated = 0;
  sampled = 0;
  decided = 0;
  errors = 0;
  decisions = 0;
  private readonly prbs: Prbs13;
  private readonly gauss: () => number;
  constructor(seed = 0x1d3) {
    this.prbs = new Prbs13(seed);
    this.gauss = normals(seed * 7919 + 1);
  }
  generate(upto: number): void {
    while (this.generated <= upto) {
      const s = this.prbs.symbol();
      this.sym[this.generated & MASK] = s;
      this.level[this.generated & MASK] = LEVELS[s];
      this.generated++;
    }
  }
  /** Fill the pipeline so that time t already has history behind it. */
  start(t: number, rx: Receiver): void {
    this.generate(Math.floor(t) + 64);
    this.sampled = this.decided = Math.floor(t - rx.tSample) - 80;
    this.advance(t, rx);
    this.errors = this.decisions = 0;
  }
  /** Sample and decide every symbol whose time has come; onSample reports each new ADC sample. */
  advance(t: number, rx: Receiver, onSample?: (n: number, v: number) => void): void {
    this.generate(Math.floor(t) + 64);
    const ts = rx.tSample, h = rx.a.h, sigma = rx.a.sigSample;
    while (this.sampled + ts <= t) {
      const n = this.sampled++;
      let v = 0;
      for (let k = -PRE; k <= POST; k++) v += this.level[(n - k) & MASK] * h[k + PRE];
      v = Math.max(-1, Math.min(1, v + this.gauss() * sigma));
      this.sample[n & MASK] = v;
      onSample?.(n, v);
    }
    while (this.decided + NFPRE + ts + 2 <= t && this.decided + NFPRE < this.sampled) this.decide(this.decided++, rx);
  }
  private decide(n: number, rx: Receiver): void {
    let z = 0;
    for (let a = 0; a < NF; a++) z += rx.taps[a] * this.sample[(n - a + NFPRE) & MASK];
    z = z / (rx.live.f0 || 1) - rx.live.b1 * LEVELS[this.decision[(n - 1) & MASK]];
    const d = z < -2 / 3 ? 0 : z < 0 ? 1 : z < 2 / 3 ? 2 : 3, wrong = d !== this.sym[n & MASK];
    this.decision[n & MASK] = d;
    this.error[n & MASK] = wrong ? 1 : 0;
    this.decisions++;
    if (wrong) this.errors++;
  }
}

/** Density image of an eye diagram, centred on the sampling instant. */
export class EyeImage {
  static readonly W = 192;
  static readonly H = 112;
  readonly buf: Float32Array;
  constructor(readonly width = EyeImage.W, readonly height = EyeImage.H) {
    this.buf = new Float32Array(width * height);
  }
  decay(k: number): void {
    for (let i = 0; i < this.buf.length; i++) this.buf[i] *= k;
  }
  /** Overlay a uniformly sampled time window, vertical range ±range. */
  trace(win: Float32Array, range: number): void {
    const W = this.width, H = this.height, last = win.length - 1, sx = (W - 1) / last, sy = (H - 1) / (2 * range);
    let x0 = 0, y0 = (range - win[0]) * sy;
    for (let i = 1; i <= last; i++) {
      const x1 = i * sx, y1 = (range - win[i]) * sy, dx = x1 - x0, dy = y1 - y0;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)))), w = 1 / Math.sqrt(steps);
      for (let s = 0; s < steps; s++) {
        const t = s / steps, yi = Math.floor(y0 + dy * t);
        if (yi >= 0 && yi < H) this.buf[yi * W + Math.floor(x0 + dx * t)] += w;
      }
      x0 = x1;
      y0 = y1;
    }
  }
}

/** Plain TX eye: consecutive 2-UI windows of PAM4 through the existing TX driver, without added noise or equalization. */
export function plainPam4Eye(): EyeImage {
  const image = new EyeImage(640, 400), levels = new Float32Array(RING), prbs = new Prbs13(0x1d3);
  for (let n = 0; n < RING; n++) levels[n] = LEVELS[prbs.symbol()];
  const response = pulse([stage.poles(50e9, 2)]);
  const q = Float32Array.from(response.subarray(PS, PS + PLEN), (v) => v * VPK);
  // Centre the eye on the symbol clock, delayed by the driver's DC group delay.
  const centre = Math.round((T0 + 0.5 + BAUD / (Math.PI * 50e9)) * OS);
  const window = new Float32Array(2 * OS + 1);
  for (let n = 128; n < 640; n++) {
    for (let i = 0; i <= 2 * OS; i++) window[i] = waveAt(q, n * OS + centre - OS + i, levels, MASK);
    image.trace(window, 0.6);
  }
  return image;
}

export interface EyeReadout {
  bits: number;
  bitErrors: number;
  /** Signal-to-error power ratio using the transmitted PAM4 levels as the reference. */
  snr: number;
  padSnr: number;
  /** Snapshot of the phase-swept receiver eye; its centre column is exactly histogram. */
  samplingEye: EyeImage;
  histogram: { counts: Uint16Array; range: number };
}

const MEASURE = 4096;

/**
 * A statistical receiver eye: one amplitude histogram for each clock phase, over exactly MEASURE symbols.
 * Two UI repeat the measured one-UI phase distribution. These columns are not connected as waveform traces.
 */
export class SamplingEye {
  readonly image = new EyeImage(2 * OS + 1, 160);
  range = 1.6;
  count = 0;
  private next = 0;
  private readonly values = new Float32Array(MEASURE * OS);

  reset(): void {
    this.image.buf.fill(0);
    this.range = 1.6;
    this.count = this.next = 0;
  }

  private accumulate(offset: number, weight: number): void {
    const { width, height, buf } = this.image;
    for (let phase = 0; phase < OS; phase++) {
      const bin = Math.min(height - 1, Math.max(0, Math.floor((this.values[offset + phase] / this.range + 1) * 0.5 * height)));
      const row = (height - 1 - bin) * width;
      buf[row + phase] += weight;
      buf[row + phase + OS] += weight;
      if (phase === 0) buf[row + 2 * OS] += weight;
    }
  }

  add(phases: Float32Array): void {
    let needed = this.range;
    for (const value of phases) if (Math.abs(value) >= needed) needed = Math.ceil(Math.abs(value) * 1.05 * 5) / 5;
    if (needed > this.range) {
      // Re-bin all retained samples together so the eye and its centre-slice histogram always share an amplitude axis.
      this.range = needed;
      this.image.buf.fill(0);
      for (let i = 0; i < this.count; i++) this.accumulate(i * OS, 1);
    }
    const offset = this.next * OS;
    if (this.count === MEASURE) this.accumulate(offset, -1);
    else this.count++;
    this.values.set(phases, offset);
    this.accumulate(offset, 1);
    this.next = (this.next + 1) % MEASURE;
  }

  snapshot(): Pick<EyeReadout, 'samplingEye' | 'histogram'> {
    // Drop startup/adaptation outliers from the scale once they leave the same rolling measurement window.
    let needed = 1.6;
    for (let i = 0; i < this.count * OS; i++) if (Math.abs(this.values[i]) >= needed) needed = Math.ceil(Math.abs(this.values[i]) * 1.05 * 5) / 5;
    if (needed < this.range) {
      this.range = needed;
      this.image.buf.fill(0);
      for (let i = 0; i < this.count; i++) this.accumulate(i * OS, 1);
    }
    const { width, height, buf } = this.image;
    const samplingEye = new EyeImage(width, height), counts = new Uint16Array(height);
    samplingEye.buf.set(buf);
    for (let bin = 0; bin < height; bin++) counts[bin] = buf[(height - 1 - bin) * width + OS];
    return { samplingEye, histogram: { counts, range: this.range } };
  }
}

/** Continuous analog/linear eyes and discrete post-DFE measurements from the same received symbols. */
export class EyeStream {
  readonly eyes = [new EyeImage(256, 160), new EyeImage(256, 160), new EyeImage(256, 160)] as const;
  readonly samplingEye = new SamplingEye();
  /** Slicer inputs for clock phases 0 … (OS−1)/OS UI. Phase zero is the actual receiver decision sample. */
  readonly phaseSamples = new Float32Array(OS);
  private readonly phaseDecisions = new Uint8Array(OS);
  /** Latest continuous FFE trace. DFE corrections are never applied between sampling instants. */
  readonly ffeTrace = new Float32Array(2 * OS + 1);
  /** DFE-corrected samples and the corresponding slicer decisions, once per symbol. */
  readonly centre = new Float32Array(RING);
  readonly padCentre = new Float32Array(RING);
  readonly decision = new Uint8Array(RING);
  n = 64;
  private generated = 0;
  private analysis: LinkAnalysis | null = null;
  private warmup = 0;
  private measured = 0;
  private errorPower = 0;
  private padErrorPower = 0;
  private bitErrors = 0;
  private readonly residuals = new Float64Array(MEASURE);
  private readonly padResiduals = new Float64Array(MEASURE);
  private readonly wrongBits = new Uint8Array(MEASURE);
  private readonly sym = new Uint8Array(RING);
  private readonly value = new Float32Array(RING);
  private readonly pad: Float32Array[] = [];
  private readonly adc: Float32Array[] = [];
  private readonly prbs: Prbs13;
  private readonly gauss: () => number;
  constructor(seed = 0x0b5) {
    this.prbs = new Prbs13(seed);
    this.gauss = normals(seed * 104729 + 3);
    for (let i = 0; i < 16; i++) {
      this.pad.push(new Float32Array(2 * OS + 1));
      this.adc.push(new Float32Array(2 * OS + 1));
    }
  }
  run(count: number, rx: Receiver): void {
    const a = rx.a, taps = rx.taps, f0 = rx.live.f0 || 1, b1 = rx.live.b1, stx = Math.sqrt(STX2);
    if (this.analysis !== a) {
      this.analysis = a;
      this.warmup = 0;
      for (const eye of this.eyes) eye.buf.fill(0);
      this.samplingEye.reset();
      this.phaseDecisions.fill(0);
      this.measured = this.errorPower = this.padErrorPower = this.bitErrors = 0;
      this.residuals.fill(0);
      this.padResiduals.fill(0);
      this.wrongBits.fill(0);
    }
    for (let c = 0; c < count; c++) {
      const n = this.n++, wp = this.pad[n & 15], wa = this.adc[n & 15];
      // Generate just enough look-ahead; a large initial fill must not overwrite the symbol ring.
      while (this.generated <= n + 34) {
        const s = this.prbs.symbol();
        this.sym[this.generated & MASK] = s;
        this.value[this.generated & MASK] = LEVELS[s] + this.gauss() * stx;
        this.generated++;
      }
      const mp = n * OS + PS + a.padTs - OS, ma = n * OS + PS + a.tsOff - OS;
      // Adjacent windows share one UI, including its noise: they are cuts from one waveform.
      const first = this.warmup ? OS + 1 : 0;
      if (this.warmup) {
        wp.set(this.pad[(n - 1) & 15].subarray(OS));
        wa.set(this.adc[(n - 1) & 15].subarray(OS));
      }
      for (let i = first; i <= 2 * OS; i++) {
        wp[i] = waveAt(a.pad, mp + i, this.value, MASK) + this.gauss() * a.sigPad;
        wa[i] = Math.max(-1, Math.min(1, waveAt(a.adc, ma + i, this.value, MASK) + this.gauss() * a.sigAdc));
      }
      this.padCentre[n & MASK] = wp[OS];
      this.eyes[0].trace(wp, a.padRange);
      this.eyes[1].trace(wa, 1);
      if (++this.warmup < NF) continue;
      // Apply the linear FFE at every phase, without inventing a held DFE waveform.
      const nd = n - NFPRE;
      for (let i = 0; i <= 2 * OS; i++) {
        let z = 0;
        for (let t = 0; t < NF; t++) z += taps[t] * this.adc[(nd - t + NFPRE) & 15][i];
        this.ffeTrace[i] = z / f0;
      }
      // A DFE is a decision-time operation. Feed back the previous decision, not the known transmitted symbol.
      const feedback = b1 * LEVELS[this.decision[(nd - 1) & MASK]];
      const sample = this.ffeTrace[OS] - feedback;
      this.centre[nd & MASK] = sample;
      this.decision[nd & MASK] = sample < -2 / 3 ? 0 : sample < 0 ? 1 : sample < 2 / 3 ? 2 : 3;
      this.phaseSamples[0] = this.centre[nd & MASK];
      this.phaseDecisions[0] = this.decision[nd & MASK];
      // Sweep the clock with fixed equalizer taps. Each phase runs its own decision history, including errors.
      // Using the nominal phase's previous decision at every phase would create the old non-periodic DFE fan.
      for (let phase = 1; phase < OS; phase++) {
        const z = this.ffeTrace[OS + phase] - b1 * LEVELS[this.phaseDecisions[phase]];
        this.phaseSamples[phase] = z;
        this.phaseDecisions[phase] = z < -2 / 3 ? 0 : z < 0 ? 1 : z < 2 / 3 ? 2 : 3;
      }
      this.eyes[2].trace(this.ffeTrace, 1.6);
      // Let the previously uninitialized decision history settle before reporting steady-state measurements.
      if (this.warmup < NF + 32) continue;
      this.samplingEye.add(this.phaseSamples);
      // A symbol-rate DFE defines only these decision samples. Do not extend its correction across an analog eye.
      const index = this.measured++ % MEASURE, symbol = this.sym[nd & MASK], decoded = this.decision[nd & MASK];
      const residual = (this.phaseSamples[0] - LEVELS[symbol]) ** 2;
      const padResidual = (this.padCentre[nd & MASK] / a.padH0 - LEVELS[symbol]) ** 2;
      const grayDiff = (symbol ^ (symbol >> 1)) ^ (decoded ^ (decoded >> 1));
      const wrong = (grayDiff & 1) + ((grayDiff >> 1) & 1);
      this.errorPower += residual - this.residuals[index];
      this.padErrorPower += padResidual - this.padResiduals[index];
      this.bitErrors += wrong - this.wrongBits[index];
      this.residuals[index] = residual;
      this.padResiduals[index] = padResidual;
      this.wrongBits[index] = wrong;
    }
  }
  measurements(): EyeReadout {
    const count = Math.min(MEASURE, this.measured);
    return { bits: 2 * count, bitErrors: this.bitErrors, snr: count ? EA * count / Math.max(1e-20, this.errorPower) : 0, padSnr: count ? EA * count / Math.max(1e-20, this.padErrorPower) : 0, ...this.samplingEye.snapshot() };
  }
  symbolAt(n: number): number {
    return this.sym[n & MASK];
  }
}
