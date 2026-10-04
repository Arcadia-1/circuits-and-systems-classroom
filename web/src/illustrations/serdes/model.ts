/**
 * 112G PAM4 link model: a causal channel and receiver chain evaluated in the frequency domain, turned into a sampled
 * pulse response, then equalized by an MMSE FFE with optional one-tap DFE. Everything here is a pure function of the settings;
 * python/serdes_112g_link.py is the executable reference.
 */
import { fft } from '../../lib/fft';

export const BAUD = 56e9;
export const FN = BAUD / 2;
export const UI = 1 / BAUD;
/** Samples per UI, FFT length (a 256-UI window) and the pre-delay that keeps the causal response inside it. */
export const OS = 32;
export const NFFT = 8192;
export const T0 = 8;
/** Slice of every pulse response that is kept: from 3 UI before the pre-delay, 56 UI long. */
export const PS = (T0 - 3) * OS;
export const PLU = 56;
export const PLEN = PLU * OS;
/** PAM4 levels in units of the outer level, and E[a²]. */
export const LEVELS = [-1, -1 / 3, 1 / 3, 1] as const;
export const EA = 5 / 9;
/** Cursor span the equalizer sees, FFE taps (3 pre, 8 post) and the one DFE tap. */
export const PRE = 6;
export const POST = 44;
export const NFPRE = 3;
export const NFPOST = 8;
export const NF = NFPRE + NFPOST + 1;
/** TX FFE preset c(−1), c(0), c(+1); Σ|c| = 1 keeps the 1.0 Vppd peak swing. */
export const TX_FFE = [-0.1, 0.75, -0.15] as const;
/** Volts per unit level at the pad, and the fixed impairments. */
export const VPK = 0.5;
export const SIG_ADC = 0.01;
export const RJ = 0.2e-12;
export const SNR_TX_DB = 28;
export const STX2 = EA * 10 ** (-SNR_TX_DB / 10);
/** Symbols drawn in flight along the 3-D trace. */
export const NFLY = 44;

const NP = 1 / 8.685889638; // dB → neper
const GAM = 0.9;
const CG = Math.cos((GAM * Math.PI) / 2);
const SG = Math.sin((GAM * Math.PI) / 2);

/** A stage writes ln|H(f)| and arg H(f) into out. */
export type Stage = (f: number, out: [number, number]) => void;

export const stage = {
  poles: (fp: number, n: number): Stage => (f, o) => {
    const r = f / fp;
    o[0] = -0.5 * n * Math.log1p(r * r);
    o[1] = -n * Math.atan(r);
  },
  /** Skin effect, exp(−a·√(j f/f_N)): the causal diffusion response, loss ∝ √f. */
  skin: (lossDb: number): Stage => {
    const a = lossDb * NP * Math.SQRT2;
    return (f, o) => {
      const v = (-a * Math.sqrt(f / FN)) / Math.SQRT2;
      o[0] = v;
      o[1] = v;
    };
  },
  /** Dielectric loss, exp(−b·(j f/f_N)^0.9): a one-sided stable law, causal, loss close to ∝ f. */
  diel: (lossDb: number): Stage => {
    const b = (lossDb * NP) / CG;
    return (f, o) => {
      const v = b * Math.pow(f / FN, GAM);
      o[0] = -v * CG;
      o[1] = -v * SG;
    };
  },
  /** One double reflection between the package and board transitions. */
  echo: (eps: number, delayUi: number, segLossDb: number): Stage => (f, o) => {
    const m = eps * Math.exp((-segLossDb * NP * f) / FN), th = -2 * Math.PI * f * delayUi * UI;
    const re = 1 + m * Math.cos(th), im = m * Math.sin(th);
    o[0] = 0.5 * Math.log(re * re + im * im);
    o[1] = Math.atan2(im, re);
  },
  /** Passive two-path response: (1 + r exp(−jωτ))/(1 + r), unity at DC and a notch at f = 1/(2τ). */
  postcursorEcho: (ratio: number, delayUi = 1): Stage => (f, o) => {
    const th = -2 * Math.PI * f * delayUi * UI;
    const re = 1 + ratio * Math.cos(th), im = ratio * Math.sin(th);
    o[0] = 0.5 * Math.log(re * re + im * im) - Math.log1p(ratio);
    o[1] = Math.atan2(im, re);
  },
  /** IEEE 802.3ck COM reference CTLE: zero at f_b/2.5, poles at f_b/2.5 and f_b, low-frequency shelf at f_b/80. */
  ctle: (gdcDb: number, gdc2Db: number): Stage => {
    const g = 10 ** (gdcDb / 20), g2 = 10 ** (gdc2Db / 20);
    const fz = BAUD / 2.5, fp1 = BAUD / 2.5, fp2 = BAUD, flf = BAUD / 80;
    return (f, o) => {
      const a = f / fz, b = f / fp1, c = f / fp2, d = f / flf;
      o[0] = 0.5 * (Math.log(g * g + a * a) - Math.log1p(b * b) - Math.log1p(c * c) + Math.log(g2 * g2 + d * d) - Math.log1p(d * d));
      o[1] = Math.atan2(a, g) - Math.atan(b) - Math.atan(c) + Math.atan2(d, g2) - Math.atan(d);
    };
  },
};

/** TX driver, then the channel: 35 % skin / 65 % dielectric distributed loss, a small echo and an optional 1-UI path. */
export function channelStages(lossDb: number, echo = 0): Stage[] {
  return [stage.poles(50e9, 2), stage.skin(0.35 * lossDb), stage.diel(0.65 * lossDb), stage.echo(0.02, 9, 0.12 * lossDb), stage.postcursorEcho(echo)];
}
/** RX front end (termination, T-coil and ESD as one pole) and the CTLE. */
export function rxStages(gdcDb: number, gdc2Db: number): Stage[] {
  return [stage.poles(45e9, 1), stage.ctle(gdcDb, gdc2Db)];
}

/** ln|H| and arg H of a cascade. */
export function response(stages: Stage[], f: number): [number, number] {
  const o: [number, number] = [0, 0];
  let lm = 0, ph = 0;
  for (const s of stages) {
    s(f, o);
    lm += o[0];
    ph += o[1];
  }
  return [lm, ph];
}
export const responseDb = (stages: Stage[], f: number): number => response(stages, f)[0] * 8.685889638;

/** Response to one unit-level symbol (a 1-UI rectangle), OS samples per UI, delayed by T0 UI inside the window. */
export function pulse(stages: Stage[]): Float64Array {
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), o: [number, number] = [0, 0];
  for (let k = 0; k <= NFFT / 2; k++) {
    const f = (k * BAUD * OS) / NFFT;
    let lm = 0, ph = -2 * Math.PI * f * T0 * UI;
    for (const s of stages) {
      s(f, o);
      lm += o[0];
      ph += o[1];
    }
    let br = OS, bi = 0;
    if (k) {
      const x = (Math.PI * k) / NFFT, bm = Math.sin(x * OS) / Math.sin(x), ba = -x * (OS - 1);
      br = bm * Math.cos(ba);
      bi = bm * Math.sin(ba);
    }
    const m = Math.exp(lm), hr = m * Math.cos(ph), hi = m * Math.sin(ph);
    re[k] = hr * br - hi * bi;
    im[k] = hr * bi + hi * br;
    if (k > 0 && k < NFFT / 2) {
      re[NFFT - k] = re[k];
      im[NFFT - k] = -im[k];
    }
  }
  im[NFFT / 2] = 0;
  // inverse transform as the conjugate of the forward transform of the conjugate
  for (let k = 0; k < NFFT; k++) im[k] = -im[k];
  fft(re, im);
  for (let k = 0; k < NFFT; k++) re[k] /= NFFT;
  return re;
}

/** Apply a three-tap TX FFE c(−1), c(0), c(+1) to a pulse response. */
export function withTxFfe(p: Float64Array, c: readonly [number, number, number]): Float64Array {
  const q = new Float64Array(p.length);
  for (let n = 0; n < p.length; n++) {
    let s = c[1] * p[n];
    if (n + OS < p.length) s += c[0] * p[n + OS];
    if (n >= OS) s += c[2] * p[n - OS];
    q[n] = s;
  }
  return q;
}

export interface Noise {
  /** Variances at the ADC, in full-scale units: RX thermal, crosstalk, ADC and random-jitter terms. */
  th2: number;
  xt2: number;
  adc2: number;
  j2: number;
}
export type BudgetPart = 'isi' | 'th' | 'xt' | 'adc' | 'jit' | 'tx';
export interface Metrics {
  /** Main cursor after the FFE, DFE tap relative to it, unbiased SNR and the error budget normalised to f0². */
  f0: number;
  b1: number;
  snr: number;
  parts: Record<BudgetPart, number>;
  total: number;
}

/** Error budget at the slicer for FFE taps w; an enabled DFE removes cursor +1. */
export function metrics(h: Float64Array, w: Float64Array, nz: Noise, dfe: boolean): Metrics {
  const kmin = -PRE - NFPRE, kmax = POST + NFPOST;
  let f0 = 0, f1 = 0, isi = 0, all = 0, wn = 0;
  for (let a = 0; a < NF; a++) wn += w[a] * w[a];
  for (let k = kmin; k <= kmax; k++) {
    let s = 0;
    for (let a = 0; a < NF; a++) {
      const j = k - a + NFPRE;
      if (j >= -PRE && j <= POST) s += w[a] * h[j + PRE];
    }
    all += s * s;
    if (k === 0) f0 = s;
    else if (k === 1) {
      f1 = s;
      if (!dfe) isi += s * s;
    } else isi += s * s;
  }
  const g2 = f0 * f0 || 1e-12;
  const parts = { isi: (EA * isi) / g2, th: (nz.th2 * wn) / g2, xt: (nz.xt2 * wn) / g2, adc: (nz.adc2 * wn) / g2, jit: (nz.j2 * wn) / g2, tx: (STX2 * all) / g2 };
  const total = parts.isi + parts.th + parts.xt + parts.adc + parts.jit + parts.tx;
  return { f0, b1: dfe ? f1 / (f0 || 1) : 0, snr: EA / total, parts, total };
}

/**
 * MMSE FFE with optional ideal one-tap DFE (or a plain gain when DSP is off), normalised so the main cursor is 1. TX noise
 * rides on every cursor, so it enters the normal equations over all rows; the solution then maximises the unbiased SNR.
 */
export function design(h: Float64Array, nz: Noise, dsp: boolean, dfe = dsp): { w: Float64Array; snr: number } {
  const w = new Float64Array(NF);
  if (!dsp) w[NFPRE] = 1 / h[PRE];
  else {
    const s2 = nz.th2 + nz.xt2 + nz.adc2 + nz.j2;
    const hk = (j: number) => (j >= -PRE && j <= POST ? h[j + PRE] : 0);
    const kmin = -PRE - NFPRE, kmax = POST + NFPOST;
    const A = Array.from({ length: NF }, () => new Float64Array(NF + 1));
    for (let a = 0; a < NF; a++) {
      for (let b = a; b < NF; b++) {
        let s = 0, all = 0;
        for (let k = kmin; k <= kmax; k++) {
          const v = hk(k - a + NFPRE) * hk(k - b + NFPRE);
          all += v;
          if (!dfe || k !== 1) s += v;
        }
        A[a][b] = A[b][a] = EA * s + STX2 * all + (a === b ? s2 : 0);
      }
      A[a][NF] = EA * hk(NFPRE - a);
    }
    solveInPlace(A, w);
  }
  const m = metrics(h, w, nz, dsp && dfe);
  for (let a = 0; a < NF; a++) w[a] /= m.f0;
  return { w, snr: m.snr };
}

function solveInPlace(A: Float64Array[], x: Float64Array): void {
  const n = x.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (p !== i) [A[i], A[p]] = [A[p], A[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      if (f) for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i][n];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
}

/** Upper-tail Gaussian probability, Q(x) = erfc(x/√2)/2 (Numerical Recipes erfc, 1.2e-7 relative). */
export function qfunc(x: number): number {
  const z = Math.abs(x / Math.SQRT2), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return 0.5 * (x >= 0 ? r : 2 - r);
}
/** Gray-coded PAM4 bit error rate for a Gaussian error at the given SNR: (3/4)·Q(√(SNR/5)). */
export const berOf = (snr: number): number => 0.75 * qfunc(Math.sqrt(snr / 5));

export interface LinkSettings {
  /** Distributed skin/dielectric loss at Nyquist; an optional echo adds its own frequency-dependent loss. */
  lossDb: number;
  /** Relative amplitude of a second path delayed by 1 UI, DC-normalized; 0 … 0.9. */
  echo?: number;
  /** Calibrate CTLE and clock for FFE once per channel, then reuse that front end in every DSP mode. */
  sharedFrontEnd?: boolean;
  /** Integrated crosstalk noise and input-referred RX noise at the pad, in volts rms over 0 … f_N. */
  xtV: number;
  rxNoiseV: number;
  txFfe: boolean;
  /** Search the CTLE over g_DC ∈ [−20, 0] dB and g_DC2 ∈ {0, −3, −6} dB, or use the given pair. */
  autoCtle: boolean;
  gdc: number;
  gdc2: number;
  dsp: boolean;
  /** Enable decision feedback as well as the FFE. Defaults to true for the reference model. */
  dfe?: boolean;
}

export interface LinkAnalysis {
  txFfe: boolean;
  dfe: boolean;
  echo: number;
  sharedFrontEnd: boolean;
  /** Actual bump-to-bump insertion loss at Nyquist, including both echoes and excluding the TX driver. */
  channelLossDb: number;
  gdc: number;
  gdc2: number;
  /** VGA gain that puts the signal rms at 0.3 of ADC full scale. */
  vga: number;
  ctleBoostDb: number;
  noise: Noise;
  /** Cursors −PRE … +POST at the chosen sampling phase, in full-scale units. */
  h: Float64Array;
  /** Sampling phase relative to the pulse peak, in UI, and its index in the kept slice. */
  phaseUi: number;
  tsOff: number;
  /** Kept slices: ADC input in full scale, RX pad in volts. */
  adc: Float32Array;
  pad: Float32Array;
  padTs: number;
  padH0: number;
  padRange: number;
  /** Cursor SNR at the RX pad, before receiver equalization, at the pad eye's sampling phase. */
  padSnr: number;
  /** Noise per fine sample at the pad (V) and at the ADC (FS), and per symbol decision (FS). */
  sigPad: number;
  sigAdc: number;
  sigSample: number;
  /** MMSE taps and the SNR they reach. */
  weights: Float64Array;
  snr: number;
  stages: { channel: Stage[]; rx: Stage[] };
}

export function analyzeLink(s: LinkSettings): LinkAnalysis {
  const dfe = s.dsp && s.dfe !== false;
  const c = s.txFfe ? TX_FFE : ([0, 1, 0] as const);
  const echo = s.echo ?? 0, sharedFrontEnd = s.sharedFrontEnd ?? false;
  const channel = channelStages(s.lossDb, echo);
  const pad = withTxFfe(pulse(channel), c);
  const gdcs = s.autoCtle ? Array.from({ length: 21 }, (_, i) => 0 - i) : [s.gdc];
  const gdc2s = s.autoCtle ? [0, -3, -6] : [s.gdc2];
  const df = (BAUD * OS) / NFFT;
  let best: { snr: number; w: Float64Array; g: number; g2: number; ts: number; pi: number; vga: number; nz: Noise; h: Float64Array; p: Float64Array; rx: Stage[] } | null = null;
  for (const g of gdcs) for (const g2 of gdc2s) {
    const rx = rxStages(g, g2);
    const p = withTxFfe(pulse(channel.concat(rx)), c);
    let pk = -Infinity, pi = PS;
    for (let i = PS; i < PS + 24 * OS; i++) if (p[i] > pk) { pk = p[i]; pi = i; }
    let ni = 0, nx = 0, nxn = 0;
    for (let k = 0; k <= NFFT / 2; k++) {
      const f = k * df, x = f / FN, gg = Math.exp(2 * response(rx, f)[0]), px = (x * x) / (1 + x * x * x * x);
      ni += gg;
      nx += px * gg;
      nxn += px;
    }
    let r2 = 0;
    for (let k = -PRE; k <= POST; k++) r2 += p[pi + k * OS] ** 2;
    const vga = 0.3 / Math.sqrt(EA * r2);
    const th2 = ((vga * s.rxNoiseV) / VPK) ** 2 * ((ni * df) / FN);
    const xt2 = ((vga * s.xtV) / VPK) ** 2 * (nx / nxn);
    for (let ts = pi - OS / 2; ts <= pi + OS / 2; ts += 2) {
      const h = new Float64Array(PRE + POST + 1);
      let slope = 0;
      for (let k = -PRE; k <= POST; k++) {
        const i = ts + k * OS;
        h[k + PRE] = p[i] * vga;
        const d = ((p[i + 1] - p[i - 1]) * vga * OS) / 2;
        slope += d * d;
      }
      const nz: Noise = { th2, xt2, adc2: SIG_ADC * SIG_ADC, j2: EA * slope * (RJ / UI) ** 2 };
      // A matched comparison chooses the front end using the best FFE, so feedback cannot win by changing the ADC input.
      const r = design(h, nz, sharedFrontEnd || s.dsp, sharedFrontEnd ? false : dfe);
      if (!best || r.snr > best.snr) best = { snr: r.snr, w: r.w, g, g2, ts, pi, vga, nz, h, p, rx };
    }
  }
  if (!best) throw new Error('no CTLE setting evaluated');
  const selected = sharedFrontEnd ? design(best.h, best.nz, s.dsp, dfe) : best;
  const adc = new Float32Array(PLEN), padSlice = new Float32Array(PLEN);
  let padH0 = 0, padTs = 0;
  for (let i = 0; i < PLEN; i++) {
    adc[i] = best.p[PS + i] * best.vga;
    const v = pad[PS + i] * VPK;
    padSlice[i] = v;
    if (v > padH0) { padH0 = v; padTs = i; }
  }
  let dc = 0, pr2 = 0;
  for (let k = -PRE; k <= POST; k++) {
    const i = padTs + k * OS;
    if (i >= 0 && i < PLEN) { dc += padSlice[i]; pr2 += padSlice[i] ** 2; }
  }
  const sigPad = Math.hypot(s.rxNoiseV, s.xtV);
  let hh = 0;
  for (const v of best.h) hh += v * v;
  const { th2, xt2, adc2, j2 } = best.nz;
  const ct = [stage.ctle(best.g, best.g2)];
  return {
    txFfe: s.txFfe,
    dfe,
    echo,
    sharedFrontEnd,
    channelLossDb: -responseDb(channel.slice(1), FN),
    gdc: best.g,
    gdc2: best.g2,
    vga: best.vga,
    ctleBoostDb: responseDb(ct, FN) - responseDb(ct, 1e5),
    noise: best.nz,
    h: best.h,
    phaseUi: (best.ts - best.pi) / OS,
    tsOff: best.ts - PS,
    adc,
    pad: padSlice,
    padTs,
    padH0,
    padSnr: EA * padH0 ** 2 / (EA * Math.max(0, pr2 - padH0 ** 2) + STX2 * pr2 + sigPad ** 2),
    padRange: Math.max(1.12 * Math.abs(dc), 3.4 * Math.sqrt(EA * pr2), 1.3 * padH0) + 3 * sigPad,
    sigPad,
    // The eye stream and analytical budget use the same small-jitter equivalent noise variance.
    sigAdc: Math.sqrt(th2 + xt2 + adc2 + j2),
    sigSample: Math.sqrt(th2 + xt2 + adc2 + j2 + STX2 * hh),
    weights: selected.w,
    snr: selected.snr,
    stages: { channel, rx: best.rx },
  };
}

/** TX-symbol to ADC-input gain: digital TX FFE, driver/channel, CTLE and VGA. */
export function adcResponseDb(a: LinkAnalysis, f: number): number {
  const th = 2 * Math.PI * f * UI;
  const c = a.txFfe ? TX_FFE : [0, 1, 0];
  const re = c[1] + (c[0] + c[2]) * Math.cos(th);
  const im = (c[0] - c[2]) * Math.sin(th);
  return responseDb(a.stages.channel.concat(a.stages.rx), f)
    + 20 * Math.log10(a.vga * Math.hypot(re, im));
}

/** Pulse responses along the line (0 … 1 of its length, 16 steps), without the CTLE, for the travelling waveform. */
export function lineResponses(lossDb: number, txFfe: boolean, echo = 0): Float32Array[] {
  const c = txFfe ? TX_FFE : ([0, 1, 0] as const);
  return Array.from({ length: 16 }, (_, j) => {
    const u = j / 15;
    // The two propagation paths coincide at launch and separate by one UI at the far end.
    const q = withTxFfe(pulse([stage.poles(50e9, 2), stage.skin(0.35 * lossDb * u), stage.diel(0.65 * lossDb * u), stage.echo(0.02 * u, 9 * u, 0.12 * lossDb * u), stage.postcursorEcho(echo, u)]), c);
    return Float32Array.from(q.subarray(PS, PS + PLEN));
  });
}

/** Σ a[n]·q[m − n·OS − PS] for a kept pulse slice q and a ring of symbol values (length a power of two). */
export function waveAt(q: Float32Array, m: number, ring: Float32Array, mask: number): number {
  const nHi = Math.floor((m - PS) / OS);
  let s = 0;
  for (let n = nHi, k = m - nHi * OS - PS; k < PLEN; n--, k += OS) s += ring[n & mask] * q[k];
  return s;
}

/** PRBS13 (x¹³ + x¹² + x² + x + 1) with bit pairs Gray-mapped to PAM4 level indices, as PRBS13Q. */
export class Prbs13 {
  private s: number;
  constructor(seed: number) {
    this.s = seed & 0x1fff || 1;
  }
  bit(): number {
    const s = this.s, b = ((s >> 12) ^ (s >> 11) ^ (s >> 1) ^ s) & 1;
    this.s = ((s << 1) | b) & 0x1fff;
    return b;
  }
  /** Level index 0 … 3 for −3, −1, +1, +3: 00 → −3, 01 → −1, 11 → +1, 10 → +3. */
  symbol(): number {
    const msb = this.bit(), lsb = this.bit();
    return msb ? (lsb ? 2 : 3) : lsb ? 1 : 0;
  }
}
