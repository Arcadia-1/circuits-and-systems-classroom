/**
 * Symbol streams driven by a LinkAnalysis: a slow-motion stream for the 3-D view (one T/H sample and one slicer
 * decision per symbol) and a fast statistical stream that fills the three eye diagrams. No DOM here.
 */
import { mulberry32 } from '../../lib/rng';
import { BAUD, LEVELS, NF, NFLY, NFPRE, OS, PLEN, POST, PRE, PS, Prbs13, STX2, T0, VPK, metrics, pulse, stage, waveAt, type LinkAnalysis, type Metrics } from './model';

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
    this.live = metrics(a.h, this.taps, a.noise, dsp);
  }
  /** Take a new analysis; the taps keep their values and adapt from there. */
  retarget(a: LinkAnalysis, dsp: boolean): void {
    this.a = a;
    this.dsp = dsp;
    this.live = metrics(a.h, this.taps, a.noise, dsp);
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
    this.live = metrics(this.a.h, this.taps, this.a.noise, this.dsp);
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

/** Density image of one eye diagram: 2 UI wide, centred on the sampling instant. */
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
  /** Draw one 2-UI trace (2·OS + 1 samples) into the image, vertical range ±range. */
  trace(win: Float32Array, range: number): void {
    const W = this.width, H = this.height, sx = (W - 1) / (2 * OS), sy = (H - 1) / (2 * range);
    let x0 = 0, y0 = (range - win[0]) * sy;
    for (let i = 1; i <= 2 * OS; i++) {
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

/** Continuous eyes: RX pad (V), ADC input (FS), and linear FFE output before symbol-rate DFE feedback. */
export class EyeStream {
  readonly eyes = [new EyeImage(), new EyeImage(), new EyeImage()] as const;
  /** Latest continuous FFE trace. DFE corrections are never applied between sampling instants. */
  readonly ffeTrace = new Float32Array(2 * OS + 1);
  /** DFE-corrected samples and the corresponding slicer decisions, once per symbol. */
  readonly centre = new Float32Array(RING);
  readonly decision = new Uint8Array(RING);
  n = 64;
  private generated = 0;
  private analysis: LinkAnalysis | null = null;
  private warmup = 0;
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
      const sample = this.ffeTrace[OS] - b1 * LEVELS[this.decision[(nd - 1) & MASK]];
      this.centre[nd & MASK] = sample;
      this.decision[nd & MASK] = sample < -2 / 3 ? 0 : sample < 0 ? 1 : sample < 2 / 3 ? 2 : 3;
      this.eyes[2].trace(this.ffeTrace, 1.6);
    }
  }
  symbolAt(n: number): number {
    return this.sym[n & MASK];
  }
}
