/**
 * Bang-bang digital PLL at the reference rate: a 1-bit phase detector, a digital proportional-integral loop filter and a
 * DCO, with every decision acting after a latency of D reference cycles. python/pll_bang_bang.py is the executable
 * reference and reproduces the runs bit for bit, noise included.
 *
 * The timing error e is the feedback edge minus the reference edge, in ps: positive means the divided DCO edge is late.
 * The detector answers only late (+1) or early (−1). A late decision speeds the DCO up by a fixed proportional step β
 * and adds α to the integral path, whatever the size of the error. Frequency error is in kHz at the DCO output.
 * The detector compares each reference edge with the nearest feedback edge, so e wraps at ±T_ref / 2: a wrap is a
 * cycle slip.
 */
import { gaussians } from '../../lib/rng';

export const F_REF = 100e6;
export const N_DIV = 40;
export const F_OUT = F_REF * N_DIV;
/** ps of timing error gained in one reference period per kHz of DCO frequency error: T_ref / f_out, 0.0025. */
export const PS_PER_KHZ = (1e3 * 1e12) / (F_REF * F_OUT);
/** Half a reference period in ps, where the detector wraps. */
export const HALF_PS = 1e12 / F_REF / 2;
export const CYCLES = 4000;
export const US_PER_CYCLE = 1e6 / F_REF;
/** The second half of a run is taken as settled when reporting jitter. */
export const SETTLED_FROM = CYCLES / 2;

export interface BbSettings {
  /** Proportional frequency step per decision, kHz at the DCO. */
  betaKHz: number;
  /** Integral step per decision, kHz; 0 leaves only the proportional path. */
  alphaKHz: number;
  /** Reference cycles between a decision and the DCO update it causes; 0 acts on the very next period. */
  latency: number;
  /** DCO frequency error before the loop closes, kHz. */
  offsetKHz: number;
  /** White timing jitter at the detector (reference and detector noise), ps rms. */
  refJitterPs: number;
  /** DCO phase noise at 1 MHz offset in the white-FM region, dBc/Hz. */
  dcoDbc: number;
  noise: boolean;
}

export const DEFAULTS: BbSettings = { betaKHz: 400, alphaKHz: 4, latency: 1, offsetKHz: 2000, refJitterPs: 0.3, dcoDbc: -95, noise: true };

export type PresetKey = 'acquire' | 'limit' | 'latency' | 'dither' | 'pullin' | 'small';

export const PRESETS: Record<PresetKey, BbSettings> = {
  acquire: DEFAULTS,
  limit: { ...DEFAULTS, alphaKHz: 0, offsetKHz: 0, noise: false },
  latency: { ...DEFAULTS, alphaKHz: 0, offsetKHz: 0, latency: 3, noise: false },
  dither: { ...DEFAULTS, offsetKHz: 0, refJitterPs: 3 },
  pullin: { ...DEFAULTS, offsetKHz: 6000 },
  small: { ...DEFAULTS, betaKHz: 50, alphaKHz: 0.5, offsetKHz: 0 },
};

/**
 * Free-running DCO jitter accumulated over one reference period, ps rms. For white FM, σ(τ) = (f_m / f_0)·√(10^(L/10)·τ)
 * with L the phase noise at offset f_m, so the timing error random-walks by this much each reference cycle.
 */
export function dcoStepPs(dbc: number): number {
  return (1e6 / F_OUT) * Math.sqrt(10 ** (dbc / 10) / F_REF) * 1e12;
}

/** The timing step one proportional correction makes per reference cycle, ps. */
export const stepPs = (s: Pick<BbSettings, 'betaKHz'>): number => s.betaKHz * PS_PER_KHZ;

/** Noise-free, proportional-only limit cycle: the error overshoots for D cycles each way, (2D + 1) steps peak to peak. */
export const limitCyclePp = (s: Pick<BbSettings, 'betaKHz' | 'latency'>): number => (2 * s.latency + 1) * stepPs(s);
/** Its period in reference cycles. */
export const limitCyclePeriod = (s: Pick<BbSettings, 'latency'>): number => 4 * s.latency + 2;

/**
 * Pull-in estimate: the integral path ramps the frequency by α per cycle, so a frequency error f left after the
 * proportional step β piles up f²/(2α) cycles·kHz of phase before it is gone. Lock holds if that stays inside half a
 * reference period: f_offset < β + √(2α·(T_ref/2) / (T_ref/f_out)).
 */
export function pullInKHz(s: Pick<BbSettings, 'betaKHz' | 'alphaKHz'>): number {
  return s.betaKHz + (s.alphaKHz > 0 ? Math.sqrt((2 * s.alphaKHz * HALF_PS) / PS_PER_KHZ) : 0);
}

/** erf by Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7), enough for a drawn curve. */
export function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
}

/** Average detector output for a fixed timing error e (ps) behind Gaussian jitter σ (ps): erf(e / (σ√2)). */
export const meanDecision = (ePs: number, sigmaPs: number): number => (sigmaPs > 0 ? erf(ePs / (sigmaPs * Math.SQRT2)) : ePs >= 0 ? 1 : -1);
/** Its slope at e = 0, per ps: the gain jitter gives a detector that alone has none, √(2/π) / σ. */
export const detectorSlope = (sigmaPs: number): number => Math.sqrt(2 / Math.PI) / sigmaPs;

export interface BbRun {
  /** timing error at each reference edge, ps */
  err: Float64Array;
  /** what the detector compared: the error plus the reference jitter of that edge, ps */
  seen: Float64Array;
  /** detector decision at each edge, +1 late or −1 early */
  decision: Int8Array;
  /** DCO frequency error during the period after each edge, kHz */
  freq: Float64Array;
  /** what the integral path has learned so far, kHz */
  integral: Float64Array;
  /** 1 where the error wrapped */
  slip: Uint8Array;
  slips: number;
}

const noiseCache = new Map<string, Float64Array>();
function noiseOf(cycles: number, seed: number): Float64Array {
  const key = `${cycles}|${seed}`;
  let g = noiseCache.get(key);
  if (!g) noiseCache.set(key, (g = gaussians(cycles, seed)));
  return g;
}

export const REF_SEED = 101;
export const DCO_SEED = 202;

/** Run the loop from e = 0 with an empty integral path. */
export function simulate(s: BbSettings, cycles = CYCLES, seeds: [number, number] = [REF_SEED, DCO_SEED]): BbRun {
  const gr = noiseOf(cycles, seeds[0]), gw = noiseOf(cycles, seeds[1]);
  const sr = s.noise ? s.refJitterPs : 0, sw = s.noise ? dcoStepPs(s.dcoDbc) : 0;
  const run: BbRun = {
    err: new Float64Array(cycles), seen: new Float64Array(cycles), decision: new Int8Array(cycles), freq: new Float64Array(cycles),
    integral: new Float64Array(cycles), slip: new Uint8Array(cycles), slips: 0,
  };
  let e = 0, integral = 0;
  for (let k = 0; k < cycles; k++) {
    run.err[k] = e;
    run.seen[k] = e + sr * gr[k];
    const d = run.seen[k] >= 0 ? 1 : -1;
    run.decision[k] = d;
    const applied = k >= s.latency ? run.decision[k - s.latency] : 0;
    integral += s.alphaKHz * applied;
    run.integral[k] = integral;
    const f = s.offsetKHz + integral + s.betaKHz * applied;
    run.freq[k] = f;
    // a fast DCO (f > 0) brings the feedback edge earlier
    e += -PS_PER_KHZ * f + sw * gw[k];
    if (e >= HALF_PS) {
      e -= 2 * HALF_PS;
      run.slip[k] = 1;
      run.slips++;
    } else if (e < -HALF_PS) {
      e += 2 * HALF_PS;
      run.slip[k] = 1;
      run.slips++;
    }
  }
  return run;
}

export interface Summary {
  /** first cycle at which the integral path has cancelled the offset to within one proportional step, or null */
  acquiredAt: number | null;
  /**
   * first cycle from which the error stays within 1.5 times the settled half's peak, or null when the run slips. Later
   * than acquiredAt: the phase error piled up during the ramp still has to be paid back.
   */
  settledAt: number | null;
  slips: number;
  /** settled half: rms and peak-to-peak timing error, ps, and mean frequency error, kHz */
  rmsPs: number;
  ppPs: number;
  meanFreqKHz: number;
}

export function summarize(run: BbRun, s: BbSettings, from = SETTLED_FROM): Summary {
  let acquiredAt: number | null = null;
  for (let k = 0; k < run.integral.length; k++) {
    if (Math.abs(s.offsetKHz + run.integral[k]) <= s.betaKHz) {
      acquiredAt = k;
      break;
    }
  }
  const tail = run.err.subarray(from), f = run.freq.subarray(from);
  let mean = 0, lo = Infinity, hi = -Infinity, fm = 0, peak = 0;
  for (let i = 0; i < tail.length; i++) {
    mean += tail[i];
    lo = Math.min(lo, tail[i]);
    hi = Math.max(hi, tail[i]);
    peak = Math.max(peak, Math.abs(tail[i]));
    fm += f[i];
  }
  mean /= tail.length;
  let v = 0;
  for (let i = 0; i < tail.length; i++) v += (tail[i] - mean) ** 2;
  let settledAt: number | null = null;
  if (run.slips === 0) {
    settledAt = run.err.length;
    while (settledAt > 0 && Math.abs(run.err[settledAt - 1]) <= 1.5 * peak) settledAt--;
  }
  return { acquiredAt, settledAt, slips: run.slips, rmsPs: Math.sqrt(v / tail.length), ppPs: hi - lo, meanFreqKHz: fm / f.length };
}

export const SWEEP_BETAS = [25, 50, 100, 200, 400, 800, 1600];
export const SWEEP_CYCLES = 12000;
export const SWEEP_WARMUP = 2000;
export const SWEEP_SEEDS: [number, number][] = [[11, 12], [13, 14], [15, 16]];

export interface SweepPoint {
  betaKHz: number;
  /** rms timing error with the chosen noise, averaged over the seeds, ps */
  noisyPs: number;
  /** rms of the noise-free limit cycle alone, ps */
  cleanPs: number;
}

/**
 * Settled rms jitter against the proportional step, starting locked (no offset). The integral step keeps the chosen
 * α/β ratio so that only the size of the corrections changes. Too small a step cannot keep up with the DCO's random
 * walk; too large a step makes a large limit cycle.
 */
export function sweep(s: BbSettings): SweepPoint[] {
  const ratio = s.betaKHz > 0 ? s.alphaKHz / s.betaKHz : 0;
  return SWEEP_BETAS.map((betaKHz) => {
    const t = { ...s, betaKHz, alphaKHz: betaKHz * ratio, offsetKHz: 0 };
    const noisyPs = SWEEP_SEEDS.reduce((acc, seeds) => acc + summarize(simulate(t, SWEEP_CYCLES, seeds), t, SWEEP_WARMUP).rmsPs, 0) / SWEEP_SEEDS.length;
    const clean = { ...t, noise: false };
    const cleanPs = summarize(simulate(clean, 4000), clean, SWEEP_WARMUP).rmsPs;
    return { betaKHz, noisyPs, cleanPs };
  });
}
