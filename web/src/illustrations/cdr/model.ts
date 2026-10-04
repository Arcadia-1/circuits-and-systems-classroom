/**
 * Bang-bang clock and data recovery for 56 GBd NRZ: an ideal transition-based early/late detector, a decimated digital loop
 * filter with proportional and integral paths, and a phase interpolator with 64 steps per UI. Every phase is in UI.
 * python/serdes_cdr.py is the executable reference.
 */
import { mulberry32 } from '../../lib/rng';

export const BAUD = 56e9;
/** Phase-interpolator steps per UI. */
export const NPI = 64;
/** ISI closes this much of the eye at each side, leaving a 0.6 UI opening. */
export const EYE_CLOSURE = 0.2;

export type Pattern = 'prbs7' | 'prbs31' | 'cid';

export interface CdrSettings {
  /** Positive ppm means data edges arrive later: the local reference runs fast relative to the data. */
  ppm: number;
  /** Sinusoidal jitter, UI peak-to-peak, and its frequency in Hz. */
  sjUipp: number;
  sjHz: number;
  /** Random jitter on every edge, UI rms. */
  rjUi: number;
  pattern: Pattern;
  /** Close the loop (true) or sample with the free-running local clock (false). */
  cdr: boolean;
  /** Proportional step, PI steps per loop update. */
  kp: number;
  integral: boolean;
  /** Integral gain 2^kiLog2 PI steps per update, per update. */
  kiLog2: number;
  /** UI per loop update (the deserialized digital loop votes over this many decisions). */
  decim: number;
  /** Loop latency in updates. */
  latency: number;
}

export const DEFAULTS: CdrSettings = { ppm: 300, sjUipp: 0.3, sjHz: 10e6, rjUi: 0.015, pattern: 'prbs31', cdr: true, kp: 1, integral: true, kiLog2: -6, decim: 32, latency: 2 };

/** Scrambled start state for the pattern generators, so a run does not open with a long string of zeros. */
const patternSeed = (seed: number): number => (0x2468ace1 * seed) >>> 0;

/** Wrap a phase into [−0.5, 0.5). */
export const wrap = (x: number): number => x - Math.floor(x + 0.5);

/** NRZ bit sources: PRBS7 (x⁷+x⁶+1), PRBS31 (x³¹+x²⁸+1), and PRBS7 with a run of 72 identical bits every 1000 bits. */
export class BitSource {
  private s: number;
  private count = 0;
  constructor(readonly pattern: Pattern, seed = 1) {
    this.s = pattern === 'prbs31' ? seed & 0x7fffffff || 1 : seed & 0x7f || 1;
  }
  next(): number {
    if (this.pattern === 'cid' && this.count++ % 1000 < 72) return 0;
    if (this.pattern === 'prbs31') {
      const b = ((this.s >>> 30) ^ (this.s >>> 27)) & 1;
      this.s = ((this.s << 1) | b) & 0x7fffffff;
      return b;
    }
    const b = ((this.s >> 6) ^ (this.s >> 5)) & 1;
    this.s = ((this.s << 1) | b) & 0x7f;
    return b;
  }
}

/** Box–Muller normals from mulberry32, reproduced exactly by the Python reference. */
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

export interface UiSample {
  n: number;
  bit: number;
  transition: boolean;
  /** Deterministic input phase, the data edge before this bit (with random jitter) and the edge sampler (unwrapped UI). */
  phase: number;
  edge: number;
  theta: number;
  /** Early (+1, clock must move later), late (−1) or no transition (0). */
  decision: number;
  /** A timing-margin violation occurred; this is not a decoded bit error. */
  error: boolean;
}

export class CdrSim {
  n = 0;
  /** Phase-interpolator code; the edge sampler sits at code/NPI UI. */
  code = 0;
  /** Phase accumulator in PI steps, integral path in steps per update. */
  acc = 0;
  integ = 0;
  slips = 0;
  errors = 0;
  /** Loop updates applied so far and the vote of the latest one (for the animation). */
  updates = 0;
  lastVote = 0;
  private vote = 0;
  private inBlock = 0;
  private readonly queue: number[] = [];
  /** Bits and unit normals drawn ahead for peek(); step() takes them in the same order, so peeking never changes a run. */
  private readonly drawn: { bit: number; g: number }[] = [];
  private src: BitSource;
  private readonly gauss: () => number;
  private prevBit: number;
  private prevTheta = 0;
  private lastErrorBit = -1;
  private lockOffset = 0;
  /** Frequency-offset phase and sinusoidal-jitter argument, advanced once per UI so settings can change mid-run. */
  private offsetPhase = 0;
  private sjArg = 0;
  readonly s: CdrSettings;
  constructor(settings: CdrSettings, private readonly seed = 1) {
    this.s = { ...settings };
    this.src = new BitSource(settings.pattern, patternSeed(seed));
    this.gauss = normals(seed * 7919 + 13);
    this.prevBit = this.src.next();
  }
  /** Switch sinusoidal jitter on from the next UI, starting at zero phase. */
  startJitter(uipp: number): void {
    this.s.sjUipp = uipp;
    this.sjArg = 0;
  }
  /** Push the recovered clock off by `ui` (for the tour: watch the loop pull it back). */
  kick(ui: number): void {
    this.acc += ui * NPI;
    this.code = Math.floor(this.acc + 0.5);
  }
  /** Edge-sampler phase of the next UI. */
  get theta(): number {
    return this.s.cdr ? this.code / NPI : 0;
  }
  /** Bit and edge of UI n + k as the current settings will produce them, for drawing the data still to arrive. */
  peek(k: number): { bit: number; edge: number } {
    while (this.drawn.length <= k) this.drawn.push({ bit: this.src.next(), g: this.gauss() });
    const phi = this.offsetPhase + k * this.s.ppm * 1e-6 + 0.5 * this.s.sjUipp * Math.sin(this.sjArg + (k * 2 * Math.PI * this.s.sjHz) / BAUD);
    return { bit: this.drawn[k].bit, edge: phi + this.s.rjUi * this.drawn[k].g };
  }
  /** Change the data pattern without restarting the loop. */
  setPattern(p: CdrSettings['pattern']): void {
    if (p === this.s.pattern) return;
    this.s.pattern = p;
    this.src = new BitSource(p, patternSeed(this.seed));
    for (const d of this.drawn) d.bit = this.src.next();
  }
  /** Offset in UI that the loop would need to track, i.e. the ppm the integral path has learned. */
  get trackedPpm(): number {
    return (this.integ / (NPI * this.s.decim)) * 1e6;
  }
  step(): UiSample {
    const next = this.drawn.shift(), n = this.n++, bit = next ? next.bit : this.src.next(), transition = bit !== this.prevBit;
    const phi = this.offsetPhase + 0.5 * this.s.sjUipp * Math.sin(this.sjArg), edge = phi + this.s.rjUi * (next ? next.g : this.gauss());
    this.offsetPhase += this.s.ppm * 1e-6;
    this.sjArg += (2 * Math.PI * this.s.sjHz) / BAUD;
    const theta = this.theta;
    let decision = 0, error = false;
    if (transition) {
      const e = wrap(edge - theta);
      decision = e > 0 ? 1 : e < 0 ? -1 : 0;
      // the data sampler of this bit sits 0.5 − e after the edge; that of the previous bit 0.5 + e' before it
      // Visit bits in order so a bit flagged by both bounding edges is counted once.
      if (0.5 + wrap(edge - this.prevTheta) < EYE_CLOSURE) error = this.flag(n - 1);
      if (0.5 - e < EYE_CLOSURE) error = this.flag(n) || error;
    }
    this.prevBit = bit;
    this.prevTheta = theta;
    // a cycle slip moves the tracking error by a whole UI; ±0.75 UI hysteresis keeps brief excursions out of the count
    let d = phi - theta - this.lockOffset;
    while (d > 0.75) { this.lockOffset++; this.slips++; d -= 1; }
    while (d < -0.75) { this.lockOffset--; this.slips++; d += 1; }
    this.vote += decision;
    if (++this.inBlock >= this.s.decim) {
      this.queue.push(Math.sign(this.vote));
      this.vote = 0;
      this.inBlock = 0;
      while (this.queue.length > this.s.latency) this.apply(this.queue.shift() as number);
    }
    return { n, bit, transition, phase: phi, edge, theta, decision, error };
  }
  private flag(bit: number): boolean {
    if (bit < 0) return false;
    if (bit > this.lastErrorBit) {
      this.lastErrorBit = bit;
      this.errors++;
    }
    return true;
  }
  private apply(v: number): void {
    this.updates++;
    this.lastVote = v;
    if (!this.s.cdr) return;
    // switching the integral path off forgets what it learned
    if (this.s.integral) this.integ += 2 ** this.s.kiLog2 * v;
    else this.integ = 0;
    this.acc += this.s.kp * v + this.integ;
    this.code = Math.floor(this.acc + 0.5);
  }
}

/** Frequencies of the jitter-tolerance sweep. */
export const JTOL_HZ = [2e6, 5e6, 10e6, 20e6, 50e6, 100e6, 200e6, 500e6, 1e9];

/**
 * Largest sinusoidal jitter (UIpp) with no timing-margin violations or cycle slips at one frequency: lock for 4000 UI,
 * switch the jitter on, run 1.5 periods (at least 4000 UI), and bisect geometrically between 0.02 and 20 UIpp.
 */
export function jtolAt(s: CdrSettings, hz: number, seed = 7): number {
  const len = Math.max(4000, Math.ceil((1.5 * BAUD) / hz));
  const ok = (uipp: number): boolean => {
    const sim = new CdrSim({ ...s, sjUipp: 0, sjHz: hz }, seed);
    for (let i = 0; i < 4000; i++) sim.step();
    sim.startJitter(uipp);
    const before = sim.errors, slipsBefore = sim.slips;
    for (let i = 0; i < len; i++) sim.step();
    return sim.errors === before && sim.slips === slipsBefore;
  };
  let lo = 0.02, hi = 20;
  if (!ok(lo)) return 0;
  if (ok(hi)) return hi;
  for (let k = 0; k < 8; k++) {
    const mid = Math.sqrt(lo * hi);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface RunSummary {
  slips: number;
  errors: number;
  trackedPpm: number;
  /** rms and peak of the wrapped edge error (including random jitter) over the last half of the run, UI. */
  rmsUi: number;
  peakUi: number;
  code: number;
}

/** Run n UI from a zero-phase start and summarise the second half, as the Python reference prints it. */
export function run(s: CdrSettings, n: number, seed = 1): RunSummary {
  const sim = new CdrSim(s, seed);
  let sum2 = 0, peak = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const u = sim.step();
    if (i >= n / 2) {
      const e = wrap(u.edge - u.theta);
      sum2 += e * e;
      peak = Math.max(peak, Math.abs(e));
      count++;
    }
  }
  return { slips: sim.slips, errors: sim.errors, trackedPpm: sim.trackedPpm, rmsUi: Math.sqrt(sum2 / count), peakUi: peak, code: sim.code };
}
