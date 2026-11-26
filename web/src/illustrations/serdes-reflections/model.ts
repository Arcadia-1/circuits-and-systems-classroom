/**
 * 224G PAM4 reflections, bridged T-coil matching and five-equalizer link model.
 *
 * The physical channel is evaluated as an exact passive 2-port ABCD cascade
 * (TX pad/T-coil -> package -> via -> PCB cavity -> connector -> uniform 50-ohm
 * cable -> RX stub -> RX pad/T-coil), producing S11(f), S21(f), TDR and causal
 * pulse responses via IFFT. A matching 1-D bounce-decomposed wave-splitting
 * lattice simulates forward, reflected and secondary-echo travelling waves on
 * the exact same impedance profile.
 *
 * Receiver equalization solves a configurable 12..44-tap MMSE FFE with optional
 * 1-tap DFE or 2-tap partial-response target + 4-state PAM4 Viterbi MLSE on a
 * shared front end so every detector sees the exact same ADC samples and noise.
 * python/serdes_224g_reflections.py is the independent NumPy reference.
 */
import { fft } from '../../lib/fft';
import { mulberry32 } from '../../lib/rng';

export const BAUD = 112e9;
export const FN = BAUD / 2;
export const UI = 1 / BAUD;
export const Z0 = 50;
/** Nominal stripline propagation delay: 6.0 ps/mm (v_p ≈ 0.556 c, 1 UI ≈ 1.49 mm). */
export const PS_PER_MM = 6.0;
export const OS = 16;
export const NFFT = 8192;
export const T0 = 16;
export const PRE = 4;
export const POST = 44;
export const NFPRE = 3;
export const MAX_POST_TAPS = 40;
export const LEVELS = [-1, -1 / 3, 1 / 3, 1] as const;
export const EA = 5 / 9;
/** 3-tap TX FFE c(-1), c(0), c(+1); Σ|c| = 1 maintains 1.0 Vppd peak limit, trading launch swing for pre-cursor cancellation. */
export const TX_FFE = [-0.12, 0.76, -0.12] as const;
export const VPK = 0.5;
export const SIG_ADC = 0.010;
export const RJ = 0.12e-12;
export const SNR_TX_DB = 28;
export const STX2 = EA * 10 ** (-SNR_TX_DB / 10);

/** Fixed physical segment lengths (mm) around the adjustable mainboard cavity. */
export const PKG_MM = 4.0;
export const VIA_MM = 1.6;
export const CONN_MM = 2.4;
export const CABLE_VIS_MM = 4.0;
export const RX_STUB_MM = 6.0;
export const CAVITY_LOSS_DB_PER_MM = 0.10;
export const LATTICE_DX_MM = 0.1;
export const LATTICE_DT_PS = LATTICE_DX_MM * PS_PER_MM; // 0.6 ps
export const LATTICE_DT = LATTICE_DT_PS * 1e-12;

const NP = 1 / 8.685889638;
const GAM = 0.9;
const CG = Math.cos((GAM * Math.PI) / 2);
const SG = Math.sin((GAM * Math.PI) / 2);
const GRAY = [0b00, 0b01, 0b11, 0b10] as const;

export type DetectorMode = 'bypass' | 'ffe' | 'dfe' | 'mlse';
export type WaveExcitation = 'single' | 'stream224' | 'lowfreq';

export interface LinkConfig {
  /** Total distributed channel loss at Nyquist (56 GHz), dB. */
  lossDb: number;
  /** Impedance of the via/BGA transition (Ω); 50 Ω means continuous. */
  zVia: number;
  /** Impedance of the board-to-cable connector (Ω); 50 Ω means continuous. */
  zConn: number;
  /** Mainboard PCB length between via and connector (mm, 6..24, step 0.5). */
  pcbMm: number;
  /** TX and RX pad + ESD shunt capacitance (fF, 0..240). */
  padCapFf: number;
  /** Enable constant-resistance bridged T-coils at TX and RX ports. */
  tcoil: boolean;
  /** Enable 3-tap TX FFE pre-emphasis. */
  txFfe: boolean;
  /** Enable receiver CTLE analog boost. */
  ctleOn: boolean;
  /** Search CTLE g_DC / g_DC2 automatically for best FFE SNR. */
  autoCtle: boolean;
  gdc: number;
  gdc2: number;
  /** Number of RX FFE post-cursor taps (8..40 -> 12..44 total taps). */
  ffePostTaps: number;
  /** Integrated RX input-referred thermal noise (mV rms over 0..f_N). */
  rxNoiseMv: number;
  /** Integrated crosstalk noise at pad (mV rms over 0..f_N). */
  xtMv: number;
  /** Selected receiver detector for active display. */
  detector: DetectorMode;
}

export const DEFAULT_CONFIG: LinkConfig = {
  lossDb: 36,
  zVia: 32,
  zConn: 74,
  pcbMm: 14.5,
  padCapFf: 140,
  tcoil: true,
  txFfe: true,
  ctleOn: true,
  autoCtle: true,
  gdc: -16,
  gdc2: -3,
  ffePostTaps: 40,
  rxNoiseMv: 0.6,
  xtMv: 1.2,
  detector: 'mlse',
};

export interface PhysicalSegment {
  id: 'pkg' | 'via' | 'pcb' | 'conn' | 'cable' | 'rx';
  label: string;
  startMm: number;
  lengthMm: number;
  zOhm: number;
  lossDbAtFn: number;
}

export function physicalSegments(cfg: Pick<LinkConfig, 'lossDb' | 'zVia' | 'zConn' | 'pcbMm'>): PhysicalSegment[] {
  const cavMm = PKG_MM + VIA_MM + cfg.pcbMm + CONN_MM + RX_STUB_MM;
  const cavLoss = Math.min(cfg.lossDb * 0.5, CAVITY_LOSS_DB_PER_MM * cavMm);
  const cableLoss = Math.max(0, cfg.lossDb - cavLoss);
  const perMm = cavMm > 0 ? cavLoss / cavMm : 0;
  let x = 0;
  const push = (id: PhysicalSegment['id'], label: string, lengthMm: number, zOhm: number, lossDbAtFn: number): PhysicalSegment => {
    const seg = { id, label, startMm: x, lengthMm, zOhm, lossDbAtFn };
    x += lengthMm;
    return seg;
  };
  return [
    push('pkg', 'Package', PKG_MM, Z0, PKG_MM * perMm),
    push('via', 'Via', VIA_MM, cfg.zVia, VIA_MM * perMm),
    push('pcb', 'PCB', cfg.pcbMm, Z0, cfg.pcbMm * perMm),
    push('conn', 'Connector', CONN_MM, cfg.zConn, CONN_MM * perMm),
    push('cable', 'Copper cable', CABLE_VIS_MM, Z0, cableLoss),
    push('rx', 'RX stub', RX_STUB_MM, Z0, RX_STUB_MM * perMm),
  ];
}

export function totalVisualMm(pcbMm: number): number {
  return PKG_MM + VIA_MM + pcbMm + CONN_MM + CABLE_VIS_MM + RX_STUB_MM;
}

/** Analytical round-trip echo delays (in 224G UI) and notch spacing between key discontinuities. */
export function echoGeometry(cfg: Pick<LinkConfig, 'pcbMm' | 'zVia' | 'zConn'>): {
  viaConnUi: number;
  txViaUi: number;
  notchSpacingGhz: number;
  gammaVia: number;
  gammaConn: number;
} {
  // Center-to-center electrical spacing between via and connector
  const viaConnMm = cfg.pcbMm + 0.5 * (VIA_MM + CONN_MM);
  const viaConnPs = 2 * viaConnMm * PS_PER_MM;
  const txViaPs = 2 * (PKG_MM + 0.5 * VIA_MM) * PS_PER_MM;
  return {
    viaConnUi: viaConnPs / (UI * 1e12),
    txViaUi: txViaPs / (UI * 1e12),
    notchSpacingGhz: 1000 / viaConnPs,
    gammaVia: (cfg.zVia - Z0) / (cfg.zVia + Z0),
    gammaConn: (cfg.zConn - Z0) / (cfg.zConn + Z0),
  };
}

/** Complex arithmetic helpers (unboxed inline for tight frequency loops). */
function cMulRe(ar: number, ai: number, br: number, bi: number): number { return ar * br - ai * bi; }
function cMulIm(ar: number, ai: number, br: number, bi: number): number { return ar * bi + ai * br; }

/**
 * Evaluate exact 2-port ABCD cascade of the physical link at one frequency f (Hz).
 * Returns S11, effective S21 (including bridged T-coil transfer when enabled),
 * and passive network S21 (without T-coil filter factor, for passivity checks).
 */
export function evalAbcdAt(
  f: number,
  segs: readonly PhysicalSegment[],
  padCapFf: number,
  tcoil: boolean,
): { s11r: number; s11i: number; s21r: number; s21i: number; s21PassR: number; s21PassI: number } {
  // Identity ABCD matrix: [A, B; C, D]
  let Ar = 1, Ai = 0, Br = 0, Bi = 0, Cr = 0, Ci = 0, Dr = 1, Di = 0;
  const x = f / FN;
  const sqrtX = Math.sqrt(x);
  const powX = Math.pow(x, GAM);

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const skinV = 0.35 * s.lossDbAtFn * NP * sqrtX;
    const dielV = (0.65 * s.lossDbAtFn * NP / CG) * powX;
    const alpha = skinV + dielV * CG;
    const beta = 2 * Math.PI * f * (s.lengthMm * PS_PER_MM * 1e-12) + skinV + dielV * SG;
    const ea = Math.exp(alpha), ema = Math.exp(-alpha);
    const cosB = Math.cos(beta), sinB = Math.sin(beta);
    const chr = 0.5 * (ea + ema) * cosB;
    const chi = 0.5 * (ea - ema) * sinB;
    const shr = 0.5 * (ea - ema) * cosB;
    const shi = 0.5 * (ea + ema) * sinB;
    const zc = s.zOhm, izc = 1 / zc;
    const b2r = zc * shr, b2i = zc * shi;
    const c2r = izc * shr, c2i = izc * shi;

    const nAr = cMulRe(Ar, Ai, chr, chi) + cMulRe(Br, Bi, c2r, c2i);
    const nAi = cMulIm(Ar, Ai, chr, chi) + cMulIm(Br, Bi, c2r, c2i);
    const nBr = cMulRe(Ar, Ai, b2r, b2i) + cMulRe(Br, Bi, chr, chi);
    const nBi = cMulIm(Ar, Ai, b2r, b2i) + cMulIm(Br, Bi, chr, chi);
    const nCr = cMulRe(Cr, Ci, chr, chi) + cMulRe(Dr, Di, c2r, c2i);
    const nCi = cMulIm(Cr, Ci, chr, chi) + cMulIm(Dr, Di, c2r, c2i);
    const nDr = cMulRe(Cr, Ci, b2r, b2i) + cMulRe(Dr, Di, chr, chi);
    const nDi = cMulIm(Cr, Ci, b2r, b2i) + cMulIm(Dr, Di, chr, chi);
    Ar = nAr; Ai = nAi; Br = nBr; Bi = nBi; Cr = nCr; Ci = nCi; Dr = nDr; Di = nDi;
  }

  const cp = padCapFf * 1e-15;
  if (!tcoil && cp > 0) {
    // Shunt Y = jωCp at both TX and RX ports: [1 0; jωCp 1] * M * [1 0; jωCp 1]
    const wC = 2 * Math.PI * f * cp;
    // Left multiply: new C = C + j*wC*A, new D = D + j*wC*B
    const lCr = Cr - wC * Ai, lCi = Ci + wC * Ar;
    const lDr = Dr - wC * Bi, lDi = Di + wC * Br;
    // Right multiply: new A = A + j*wC*B, new C = lC + j*wC*lD
    const rAr = Ar - wC * Bi, rAi = Ai + wC * Br;
    const rCr = lCr - wC * lDi, rCi = lCi + wC * lDr;
    Ar = rAr; Ai = rAi; Cr = rCr; Ci = rCi; Dr = lDr; Di = lDi;
  }

  const iZ0 = 1 / Z0;
  const denR = Ar + Br * iZ0 + Cr * Z0 + Dr;
  const denI = Ai + Bi * iZ0 + Ci * Z0 + Di;
  const den2 = denR * denR + denI * denI || 1e-30;
  const s21PassR = (2 * denR) / den2;
  const s21PassI = (-2 * denI) / den2;
  const numR = Ar + Br * iZ0 - Cr * Z0 - Dr;
  const numI = Ai + Bi * iZ0 - Ci * Z0 - Di;
  const s11r = (numR * denR + numI * denI) / den2;
  const s11i = (numI * denR - numR * denI) / den2;

  let s21r = s21PassR, s21i = s21PassI;
  if (tcoil && cp > 0) {
    // Exact Butterworth bridged T-coil transfer H(s) = 1 / (1 + 0.5*s*R0*Cp + 0.125*(s*R0*Cp)^2)
    // Port input/output impedance is identically R0 = 50 Ω at every frequency; TX + RX gives H(s)^2.
    const u = 2 * Math.PI * f * Z0 * cp;
    const hr = 1 - 0.125 * u * u;
    const hi = 0.5 * u;
    // H(s)^2 = 1 / (hr + j*hi)^2
    const h2r = hr * hr - hi * hi;
    const h2i = 2 * hr * hi;
    const h2mag2 = h2r * h2r + h2i * h2i;
    const tr = h2r / h2mag2;
    const ti = -h2i / h2mag2;
    const nr = cMulRe(s21r, s21i, tr, ti);
    const ni = cMulIm(s21r, s21i, tr, ti);
    s21r = nr;
    s21i = ni;
  }
  return { s11r, s11i, s21r, s21i, s21PassR, s21PassI };
}

/** Bridged T-coil component values for Butterworth constant-resistance matching (ζ = 1/√2). */
export function tcoilComponents(padCapFf: number): { lPh: number; k: number; cbFf: number; bwBareGhz: number; bwTcoilGhz: number } {
  const cp = padCapFf * 1e-15;
  const lH = (3 / 8) * Z0 * Z0 * cp;
  const cbF = cp / 8;
  const bwBare = cp > 0 ? 1 / (Math.PI * Z0 * cp) : Infinity;
  return {
    lPh: lH * 1e12,
    k: 1 / 3,
    cbFf: cbF * 1e15,
    bwBareGhz: bwBare / 1e9,
    bwTcoilGhz: (2 * Math.SQRT2 * bwBare) / 1e9,
  };
}

/** IEEE 802.3ck/dj COM-form CTLE scaled to BAUD (112 GBd). */
export function evalCtleAt(f: number, gdcDb: number, gdc2Db: number): [number, number] {
  const g = 10 ** (gdcDb / 20), g2 = 10 ** (gdc2Db / 20);
  const fz = BAUD / 2.5, fp1 = BAUD / 2.5, fp2 = BAUD, flf = BAUD / 80;
  const a = f / fz, b = f / fp1, c = f / fp2, d = f / flf;
  // (g + ja) / ((1 + jb)(1 + jc)) * (g2 + jd) / (1 + jd)
  const nr = cMulRe(g, a, g2, d);
  const ni = cMulIm(g, a, g2, d);
  const d1r = cMulRe(1, b, 1, c);
  const d1i = cMulIm(1, b, 1, c);
  const dr = cMulRe(d1r, d1i, 1, d);
  const di = cMulIm(d1r, d1i, 1, d);
  const m2 = dr * dr + di * di;
  return [(nr * dr + ni * di) / m2, (ni * dr - nr * di) / m2];
}

/** Single-pole (n=1) or two-pole (n=2) butterworth-like real-pole analog filter (1 / (1 + j f/fp)^n). */
function evalPolesAt(f: number, fp: number, n: number): [number, number] {
  const r = f / fp;
  const mag = Math.pow(1 + r * r, -0.5 * n);
  const ph = -n * Math.atan(r);
  return [mag * Math.cos(ph), mag * Math.sin(ph)];
}

/** Inverse real FFT of a one-sided spectrum (0..NFFT/2) multiplied by a 1-UI rectangular pulse and pre-delay T0. */
function pulseFromSpectrum(hRe: Float64Array, hIm: Float64Array, extraShiftSec = 0): Float64Array {
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const df = (BAUD * OS) / NFFT;
  for (let k = 0; k <= NFFT / 2; k++) {
    const f = k * df;
    const phShift = -2 * Math.PI * f * (T0 * UI - extraShiftSec);
    const sr = Math.cos(phShift), si = Math.sin(phShift);
    let br = OS, bi = 0;
    if (k > 0) {
      const x = (Math.PI * k) / NFFT;
      const bm = Math.sin(x * OS) / Math.sin(x);
      const ba = -x * (OS - 1);
      br = bm * Math.cos(ba);
      bi = bm * Math.sin(ba);
    }
    const hr = cMulRe(hRe[k], hIm[k], sr, si);
    const hi = cMulIm(hRe[k], hIm[k], sr, si);
    re[k] = cMulRe(hr, hi, br, bi);
    im[k] = cMulIm(hr, hi, br, bi);
    if (k > 0 && k < NFFT / 2) {
      re[NFFT - k] = re[k];
      im[NFFT - k] = -im[k];
    }
  }
  im[NFFT / 2] = 0;
  for (let k = 0; k < NFFT; k++) im[k] = -im[k];
  fft(re, im);
  for (let k = 0; k < NFFT; k++) re[k] /= NFFT;
  return re;
}

/** Apply 3-tap TX FFE c(-1), c(0), c(+1) to an OS-sampled pulse response. */
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

/** Compute TDR step reflection profile ρ(t) and apparent impedance Z(x) directly from S11(f). */
export function computeTdr(s11Re: Float64Array, s11Im: Float64Array, totalMm: number): { distMm: Float32Array; rho: Float32Array; zOhm: Float32Array } {
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const df = (BAUD * OS) / NFFT;
  const fCut = 110e9; // smooth Gaussian-step edge (~4 ps rise time)
  for (let k = 0; k <= NFFT / 2; k++) {
    const f = k * df;
    const win = Math.exp(-0.5 * (f / fCut) ** 2);
    re[k] = s11Re[k] * win;
    im[k] = s11Im[k] * win;
    if (k > 0 && k < NFFT / 2) {
      re[NFFT - k] = re[k];
      im[NFFT - k] = -im[k];
    }
  }
  im[NFFT / 2] = 0;
  for (let k = 0; k < NFFT; k++) im[k] = -im[k];
  fft(re, im);
  // Cumulative integral of the impulse reflection gives the step reflection ρ(t)
  const dtPs = (1e12) / (BAUD * OS); // ~0.558 ps
  const maxRoundTripPs = 2 * totalMm * PS_PER_MM;
  const nPts = Math.min(NFFT / 2, Math.ceil(maxRoundTripPs / dtPs) + 1);
  const distMm = new Float32Array(nPts);
  const rho = new Float32Array(nPts);
  const zOhm = new Float32Array(nPts);
  let acc = 0;
  for (let i = 0; i < nPts; i++) {
    acc += re[i] / NFFT;
    const r = Math.max(-0.85, Math.min(0.85, acc));
    distMm[i] = (i * dtPs) / (2 * PS_PER_MM);
    rho[i] = r;
    zOhm[i] = Z0 * (1 + r) / (1 - r);
  }
  return { distMm, rho, zOhm };
}

export interface NoiseTerms {
  th2: number;
  xt2: number;
  adc2: number;
  j2: number;
}
export type BudgetPart = 'isi' | 'th' | 'xt' | 'adc' | 'jit' | 'tx';

export interface EqualizerResult {
  taps: Float64Array;
  nfPost: number;
  b1: number;
  f0: number;
  /** Effective cursor vector after FFE (indexed k = -PRE-NFPRE .. POST+nfPost), normalized by f0. */
  effectiveCursors: Float64Array;
  kMin: number;
  snr: number;
  snrDb: number;
  ber: number;
  noiseEnhDb: number;
  wn: number;
  parts: Record<BudgetPart, number>;
  totalErr: number;
}

function solveInPlace(A: Float64Array[], x: Float64Array): void {
  const n = x.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (p !== i) [A[i], A[p]] = [A[p], A[i]];
    const diag = A[i][i] || 1e-30;
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / diag;
      if (f) for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i][n];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / (A[i][i] || 1e-30);
  }
}

export function qfunc(x: number): number {
  const z = Math.abs(x / Math.SQRT2), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223
    + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
  );
  return 0.5 * (x >= 0 ? r : 2 - r);
}

export const berOf = (snr: number): number => 0.75 * qfunc(Math.sqrt(Math.max(0, snr) / 5));

export function evalMetrics(h: Float64Array, w: Float64Array, nz: NoiseTerms, pr1: boolean): EqualizerResult {
  const nf = w.length;
  const nfPost = nf - NFPRE - 1;
  const kMin = -PRE - NFPRE;
  const kMax = POST + nfPost;
  const eff = new Float64Array(kMax - kMin + 1);
  let f0 = 0, f1 = 0, isi = 0, all = 0, wn = 0;
  for (let a = 0; a < nf; a++) wn += w[a] * w[a];
  for (let k = kMin; k <= kMax; k++) {
    let s = 0;
    for (let a = 0; a < nf; a++) {
      const j = k - a + NFPRE;
      if (j >= -PRE && j <= POST) s += w[a] * h[j + PRE];
    }
    eff[k - kMin] = s;
    all += s * s;
    if (k === 0) f0 = s;
    else if (k === 1) {
      f1 = s;
      if (!pr1) isi += s * s;
    } else isi += s * s;
  }
  const g = f0 || 1e-12;
  const g2 = g * g;
  for (let i = 0; i < eff.length; i++) eff[i] /= g;
  const parts: Record<BudgetPart, number> = {
    isi: (EA * isi) / g2,
    th: (nz.th2 * wn) / g2,
    xt: (nz.xt2 * wn) / g2,
    adc: (nz.adc2 * wn) / g2,
    jit: (nz.j2 * wn) / g2,
    tx: (STX2 * all) / g2,
  };
  const totalErr = parts.isi + parts.th + parts.xt + parts.adc + parts.jit + parts.tx;
  const snr = EA / Math.max(totalErr, 1e-30);
  const wNorm2 = wn / g2;
  // Relative noise enhancement vs plain unity-cursor gain (1/h0)^2
  const plainGain2 = 1 / ((h[PRE] || 1e-6) ** 2);
  const noiseEnhDb = 10 * Math.log10(Math.max(1e-6, wNorm2 / plainGain2));
  return {
    taps: Float64Array.from(w, (v) => v / g),
    nfPost,
    b1: pr1 ? f1 / g : 0,
    f0: 1,
    effectiveCursors: eff,
    kMin,
    snr,
    snrDb: 10 * Math.log10(snr),
    ber: berOf(snr),
    noiseEnhDb,
    wn: wNorm2,
    parts,
    totalErr,
  };
}

/** Solve configurable-length MMSE FFE (pr1=false) or joint FFE + 1-tap DFE / PR(1+αD) target (pr1=true). */
export function solveMmse(h: Float64Array, nz: NoiseTerms, dsp: boolean, nfPost: number, pr1: boolean): EqualizerResult {
  const nf = NFPRE + nfPost + 1;
  const w = new Float64Array(nf);
  if (!dsp) {
    w[NFPRE] = 1 / (h[PRE] || 1e-6);
    return evalMetrics(h, w, nz, false);
  }
  const s2 = nz.th2 + nz.xt2 + nz.adc2 + nz.j2;
  const hk = (j: number) => (j >= -PRE && j <= POST ? h[j + PRE] : 0);
  const kMin = -PRE - NFPRE, kMax = POST + nfPost;
  const A = Array.from({ length: nf }, () => new Float64Array(nf + 1));
  for (let a = 0; a < nf; a++) {
    for (let b = a; b < nf; b++) {
      let s = 0, all = 0;
      for (let k = kMin; k <= kMax; k++) {
        const v = hk(k - a + NFPRE) * hk(k - b + NFPRE);
        all += v;
        if (!pr1 || k !== 1) s += v;
      }
      A[a][b] = A[b][a] = EA * s + STX2 * all + (a === b ? s2 : 0);
    }
    A[a][nf] = EA * hk(NFPRE - a);
  }
  solveInPlace(A, w);
  return evalMetrics(h, w, nz, pr1);
}

export interface FrequencyCurves {
  freqsGhz: Float32Array;
  s21Db: Float32Array;
  s21SmoothDb: Float32Array;
  s11Db: Float32Array;
  ctleDb: Float32Array;
  linkDb: Float32Array;
  s21AtFnDb: number;
  s11MaxDb: number;
  notchDepthDb: number;
}

export interface DetectorMcStats {
  ser: number;
  ber: number;
  symbolErrors: number;
  bitErrors: number;
  totalSymbols: number;
  totalBits: number;
  effSnrDb: number;
  burstsGe2: number;
  maxBurst: number;
  burstErrorShare: number;
  /** 80-bin amplitude histogram over ±1.6 around ideal PAM4 levels. */
  histCounts: Uint16Array;
  histRange: number;
}

export interface TrellisStep {
  symIndex: number;
  txSym: number;
  yFfe: number;
  ffeDec: number;
  dfeDec: number;
  mlseDec: number;
  /** Survivor parent state (0..3) for each current state (0..3). */
  prevState: [number, number, number, number];
  /** Normalized cumulative path metrics at this step (min = 0). */
  pathMetric: [number, number, number, number];
}

export interface McComparison {
  bypass: DetectorMcStats;
  ffe12: DetectorMcStats;
  ffe: DetectorMcStats;
  dfe: DetectorMcStats;
  dfeGenie: DetectorMcStats;
  mlse: DetectorMcStats;
  /** Interesting 16-symbol window capturing DFE burst or MLSE rescue from the real stream. */
  trellisWindow: TrellisStep[];
  rescuedCount: number;
  /** 48-symbol decision strip showing real error bursts in DFE vs FFE vs MLSE. */
  stripStart: number;
  stripTx: Uint8Array;
  stripFfeErr: Uint8Array;
  stripDfeErr: Uint8Array;
  stripMlseErr: Uint8Array;
}

export interface Analysis224g {
  cfg: LinkConfig;
  segments: PhysicalSegment[];
  geometry: ReturnType<typeof echoGeometry>;
  tcoilInfo: ReturnType<typeof tcoilComponents>;
  maxPassivity: number;
  channelLossAtFnDb: number;
  txSwingRatio: number;
  txSwingLossDb: number;
  gdc: number;
  gdc2: number;
  ctleBoostDb: number;
  vga: number;
  phaseUi: number;
  noise: NoiseTerms;
  sigAdc: number;
  /** Sampled cursors (-PRE..+POST) at key stages (normalized to main peak for direct comparison). */
  rawCursors: Float64Array;
  afterTxCursors: Float64Array;
  adcCursors: Float64Array;
  /** Continuous OS-sampled pulse at ADC input (index 0 = -PRE UI). */
  adcPulse: Float32Array;
  rawPulse: Float32Array;
  afterTxPulse: Float32Array;
  /** Equalizer solutions sharing the exact same calibrated front end. */
  eqBypass: EqualizerResult;
  eqFfe12: EqualizerResult;
  eqFfe: EqualizerResult;
  eqPr1: EqualizerResult;
  /** Dominant far-reflection cursor (+10..+38 UI) at ADC input. */
  farEchoUi: number;
  farEchoRatio: number;
  freq: FrequencyCurves;
  tdr: ReturnType<typeof computeTdr>;
  mc: McComparison;
}

/** Run full 224G link analysis: ABCD cascade, TDR, front-end optimization, 5-equalizer comparison, and Monte-Carlo with Viterbi MLSE. */
export function analyze224gLink(cfg: LinkConfig, mcSymbols = 8000, seed = 0x224a): Analysis224g {
  const segments = physicalSegments(cfg);
  const smoothSegments = physicalSegments({ ...cfg, zVia: Z0, zConn: Z0 });
  const geometry = echoGeometry(cfg);
  const tcoilInfo = tcoilComponents(cfg.padCapFf);

  const half = NFFT / 2 + 1;
  const df = (BAUD * OS) / NFFT;
  const s11Re = new Float64Array(half), s11Im = new Float64Array(half);
  const s21Re = new Float64Array(half), s21Im = new Float64Array(half);
  const drvChRe = new Float64Array(half), drvChIm = new Float64Array(half);
  let maxPassivity = 0;
  let s11MaxSq = 0;

  // Bulk flight delay removal so pulse peaks reliably near T0 inside the FFT window
  const flightSec = totalVisualMm(cfg.pcbMm) * PS_PER_MM * 1e-12;

  for (let k = 0; k < half; k++) {
    const f = k * df;
    const ab = evalAbcdAt(f, segments, cfg.padCapFf, cfg.tcoil);
    s11Re[k] = ab.s11r;
    s11Im[k] = ab.s11i;
    s21Re[k] = ab.s21r;
    s21Im[k] = ab.s21i;
    const s11Sq = ab.s11r * ab.s11r + ab.s11i * ab.s11i;
    if (f >= 4e9 && f <= FN && s11Sq > s11MaxSq) s11MaxSq = s11Sq;
    const pwr = s11Sq + ab.s21PassR * ab.s21PassR + ab.s21PassI * ab.s21PassI;
    if (pwr > maxPassivity) maxPassivity = pwr;
    const [dr, di] = evalPolesAt(f, 95e9, 2);
    drvChRe[k] = cMulRe(dr, di, ab.s21r, ab.s21i);
    drvChIm[k] = cMulIm(dr, di, ab.s21r, ab.s21i);
  }
  const s11MaxDb = 20 * Math.log10(Math.max(1e-6, Math.sqrt(s11MaxSq)));

  const txTaps: readonly [number, number, number] = cfg.txFfe ? TX_FFE : [0, 1, 0];
  const txSwingRatio = txTaps[1];
  const txSwingLossDb = 20 * Math.log10(txSwingRatio);

  // Raw pulse (TX driver + channel + RX AFE pole, no TX FFE, no CTLE)
  const rawRxRe = new Float64Array(half), rawRxIm = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const [ar, ai] = evalPolesAt(k * df, 90e9, 1);
    rawRxRe[k] = cMulRe(drvChRe[k], drvChIm[k], ar, ai);
    rawRxIm[k] = cMulIm(drvChRe[k], drvChIm[k], ar, ai);
  }
  const rawFull = pulseFromSpectrum(rawRxRe, rawRxIm, flightSec);
  const afterTxFull = withTxFfe(rawFull, txTaps);

  // CTLE search (calibrated on selected FFE length so all detectors share the exact same front end)
  const gdcs = !cfg.ctleOn ? [0] : cfg.autoCtle ? [0, -2, -4, -6, -8, -10, -12, -14, -16, -18, -20] : [cfg.gdc];
  const gdc2s = !cfg.ctleOn ? [0] : cfg.autoCtle ? [0, -3, -6] : [cfg.gdc2];

  const rxRe = new Float64Array(half), rxIm = new Float64Array(half);
  const totRe = new Float64Array(half), totIm = new Float64Array(half);
  const rxNoiseV = cfg.rxNoiseMv * 1e-3;
  const xtV = cfg.xtMv * 1e-3;

  let best: {
    snr: number; g: number; g2: number; ts: number; pi: number; vga: number; nz: NoiseTerms; h: Float64Array; p: Float64Array;
  } | null = null;

  for (const g of gdcs) {
    for (const g2 of gdc2s) {
      let ni = 0, nx = 0, nxn = 0;
      for (let k = 0; k < half; k++) {
        const f = k * df;
        const [ar, ai] = evalPolesAt(f, 90e9, 1);
        const [cr, ci] = cfg.ctleOn ? evalCtleAt(f, g, g2) : [1, 0];
        const rr = cMulRe(ar, ai, cr, ci);
        const ri = cMulIm(ar, ai, cr, ci);
        rxRe[k] = rr;
        rxIm[k] = ri;
        totRe[k] = cMulRe(drvChRe[k], drvChIm[k], rr, ri);
        totIm[k] = cMulIm(drvChRe[k], drvChIm[k], rr, ri);
        const gg = rr * rr + ri * ri;
        const x = f / FN;
        const px = (x * x) / (1 + x * x * x * x);
        ni += gg;
        nx += px * gg;
        nxn += px;
      }
      const p = withTxFfe(pulseFromSpectrum(totRe, totIm, flightSec), txTaps);
      let pk = -Infinity, pi = T0 * OS;
      const searchLo = Math.max(PRE * OS + 2, (T0 - 4) * OS);
      const searchHi = Math.min(NFFT - (POST + 2) * OS, (T0 + 16) * OS);
      for (let i = searchLo; i < searchHi; i++) if (p[i] > pk) { pk = p[i]; pi = i; }

      let r2 = 0;
      for (let k = -PRE; k <= POST; k++) r2 += p[pi + k * OS] ** 2;
      const vga = 0.3 / Math.sqrt(Math.max(1e-20, EA * r2));
      const th2 = ((vga * rxNoiseV) / VPK) ** 2 * ((ni * df) / FN);
      const xt2 = ((vga * xtV) / VPK) ** 2 * (nx / Math.max(1e-30, nxn));

      for (let ts = pi - OS / 2; ts <= pi + OS / 2; ts += 2) {
        const h = new Float64Array(PRE + POST + 1);
        let slope = 0;
        for (let k = -PRE; k <= POST; k++) {
          const i = ts + k * OS;
          h[k + PRE] = p[i] * vga;
          const d = ((p[i + 1] - p[i - 1]) * vga * OS) / 2;
          slope += d * d;
        }
        const nz: NoiseTerms = { th2, xt2, adc2: SIG_ADC * SIG_ADC, j2: EA * slope * (RJ / UI) ** 2 };
        const res = solveMmse(h, nz, true, cfg.ffePostTaps, false);
        if (!best || res.snr > best.snr) best = { snr: res.snr, g, g2, ts, pi, vga, nz, h, p };
      }
    }
  }
  if (!best) throw new Error('No CTLE candidate evaluated');

  // Extract aligned cursor vectors and continuous pulses at -PRE..+POST
  const sliceLen = (PRE + POST + 1) * OS;
  const extractPulse = (src: Float64Array, center: number, scale: number) => {
    const out = new Float32Array(sliceLen);
    const start = center - PRE * OS;
    for (let i = 0; i < sliceLen; i++) out[i] = (src[start + i] ?? 0) * scale;
    return out;
  };
  let rawPk = -Infinity, rawPi = T0 * OS;
  for (let i = (T0 - 4) * OS; i < (T0 + 16) * OS; i++) if (rawFull[i] > rawPk) { rawPk = rawFull[i]; rawPi = i; }
  let txPk = -Infinity, txPi = T0 * OS;
  for (let i = (T0 - 4) * OS; i < (T0 + 16) * OS; i++) if (afterTxFull[i] > txPk) { txPk = afterTxFull[i]; txPi = i; }

  const rawCursors = new Float64Array(PRE + POST + 1);
  const afterTxCursors = new Float64Array(PRE + POST + 1);
  for (let k = -PRE; k <= POST; k++) {
    rawCursors[k + PRE] = rawFull[rawPi + k * OS] / (rawPk || 1);
    afterTxCursors[k + PRE] = afterTxFull[txPi + k * OS] / (rawPk || 1);
  }
  const rawPulse = extractPulse(rawFull, rawPi, 1 / (rawPk || 1));
  const afterTxPulse = extractPulse(afterTxFull, txPi, 1 / (rawPk || 1));
  const adcPulse = extractPulse(best.p, best.ts, best.vga / (best.h[PRE] || 1));

  // Locate dominant far-reflection bump in +10..+38 UI
  let farEchoUi = Math.min(38, Math.max(10, Math.round(geometry.viaConnUi)));
  let farEchoMax = 0;
  for (let u = 10; u <= 38; u++) {
    const v = Math.abs(best.h[PRE + u]);
    if (v > farEchoMax) { farEchoMax = v; farEchoUi = u; }
  }
  const farEchoRatio = farEchoMax / (Math.abs(best.h[PRE]) || 1);

  // Solve all equalizer modes on the EXACT same calibrated ADC cursor vector & noise
  const eqBypass = solveMmse(best.h, best.nz, false, cfg.ffePostTaps, false);
  const eqFfe12 = solveMmse(best.h, best.nz, true, 8, false);
  const eqFfe = solveMmse(best.h, best.nz, true, cfg.ffePostTaps, false);
  const eqPr1 = solveMmse(best.h, best.nz, true, cfg.ffePostTaps, true);

  // Frequency response curves on a crisp 0..84 GHz grid (0.5 GHz step -> 169 pts)
  const nF = 169;
  const freqsGhz = new Float32Array(nF);
  const s21Db = new Float32Array(nF);
  const s21SmoothDb = new Float32Array(nF);
  const s11Db = new Float32Array(nF);
  const ctleDb = new Float32Array(nF);
  const linkDb = new Float32Array(nF);
  let notchDepthDb = 0;
  for (let i = 0; i < nF; i++) {
    const fGhz = i * 0.5;
    const f = fGhz * 1e9;
    freqsGhz[i] = fGhz;
    const ab = evalAbcdAt(f, segments, cfg.padCapFf, cfg.tcoil);
    const sm = evalAbcdAt(f, smoothSegments, cfg.padCapFf, cfg.tcoil);
    const s21m = Math.hypot(ab.s21r, ab.s21i);
    const smm = Math.hypot(sm.s21r, sm.s21i);
    const s11m = Math.hypot(ab.s11r, ab.s11i);
    const s21d = 20 * Math.log10(Math.max(1e-6, s21m));
    const smd = 20 * Math.log10(Math.max(1e-6, smm));
    const s11d = 20 * Math.log10(Math.max(1e-6, s11m));
    s21Db[i] = s21d;
    s21SmoothDb[i] = smd;
    s11Db[i] = s11d;
    if (fGhz >= 4 && fGhz <= 56) {
      const dip = s21d - smd;
      if (dip < notchDepthDb) notchDepthDb = dip;
    }
    const [cr, ci] = cfg.ctleOn ? evalCtleAt(f, best.g, best.g2) : [1, 0];
    ctleDb[i] = 20 * Math.log10(Math.max(1e-6, Math.hypot(cr, ci)));
    const [dr, di] = evalPolesAt(f, 95e9, 2);
    const [ar, ai] = evalPolesAt(f, 90e9, 1);
    const th = 2 * Math.PI * f * UI;
    const txMag = Math.hypot(txTaps[1] + (txTaps[0] + txTaps[2]) * Math.cos(th), (txTaps[0] - txTaps[2]) * Math.sin(th));
    const linkMag = best.vga * txMag * Math.hypot(dr, di) * s21m * Math.hypot(ar, ai) * Math.hypot(cr, ci);
    linkDb[i] = 20 * Math.log10(Math.max(1e-6, linkMag));
  }
  const s21AtFnDb = s21Db[112]; // 56 GHz = 112 * 0.5 GHz
  const [cFnR, cFnI] = cfg.ctleOn ? evalCtleAt(FN, best.g, best.g2) : [1, 0];
  const [cDcR, cDcI] = cfg.ctleOn ? evalCtleAt(1e5, best.g, best.g2) : [1, 0];
  const ctleBoostDb = 20 * Math.log10(Math.hypot(cFnR, cFnI) / Math.max(1e-12, Math.hypot(cDcR, cDcI)));

  const tdr = computeTdr(s11Re, s11Im, totalVisualMm(cfg.pcbMm));
  const sigAdc = Math.sqrt(best.nz.th2 + best.nz.xt2 + best.nz.adc2 + best.nz.j2);

  const mc = runDetectorComparison(best.h, sigAdc, eqBypass, eqFfe12, eqFfe, eqPr1, mcSymbols, seed);

  return {
    cfg,
    segments,
    geometry,
    tcoilInfo,
    maxPassivity,
    channelLossAtFnDb: -s21AtFnDb,
    txSwingRatio,
    txSwingLossDb,
    gdc: best.g,
    gdc2: best.g2,
    ctleBoostDb,
    vga: best.vga,
    phaseUi: (best.ts - best.pi) / OS,
    noise: best.nz,
    sigAdc,
    rawCursors,
    afterTxCursors,
    adcCursors: Float64Array.from(best.h, (v) => v / (best.h[PRE] || 1)),
    adcPulse,
    rawPulse,
    afterTxPulse,
    eqBypass,
    eqFfe12,
    eqFfe,
    eqPr1,
    farEchoUi,
    farEchoRatio,
    freq: { freqsGhz, s21Db, s21SmoothDb, s11Db, ctleDb, linkDb, s21AtFnDb, s11MaxDb, notchDepthDb },
    tdr,
    mc,
  };
}

/** Deterministic Box-Muller Gaussian pair generator from mulberry32 (shared identically with Python). */
export function makeNormals(seed: number): () => number {
  const rnd = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u1 = rnd() || 1e-12;
    const u2 = rnd();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
}

function slicePam4(z: number): number {
  return z < -2 / 3 ? 0 : z < 0 ? 1 : z < 2 / 3 ? 2 : 3;
}

/**
 * Exact 4-state PAM4 Viterbi MLSE for 2-tap partial-response target y[n] ≈ a[n] + alpha * a[n-1].
 * When alpha = 0, every state transition depends only on a[n], so the survivor at every step is
 * mathematically identical to a symbol-by-symbol hard PAM4 slicer.
 */
export function runViterbiPr1(
  y: Float64Array,
  alpha: number,
  start: number,
  end: number,
): {
  decisions: Uint8Array;
  prevStates: Uint8Array;
  pathMetrics: Float32Array;
} {
  const nTotal = y.length;
  const decisions = new Uint8Array(nTotal);
  const prevStates = new Uint8Array(nTotal * 4);
  const pathMetrics = new Float32Array(nTotal * 4);
  let pm0 = 0, pm1 = 0, pm2 = 0, pm3 = 0;

  for (let n = start; n < end; n++) {
    const yn = y[n];
    const pms = [pm0, pm1, pm2, pm3];
    const nextPm = [0, 0, 0, 0];
    for (let sc = 0; sc < 4; sc++) {
      const ac = LEVELS[sc];
      let bestM = Infinity, bestP = 0;
      for (let sp = 0; sp < 4; sp++) {
        const diff = yn - (ac + alpha * LEVELS[sp]);
        const m = pms[sp] + diff * diff;
        if (m < bestM) {
          bestM = m;
          bestP = sp;
        }
      }
      nextPm[sc] = bestM;
      prevStates[n * 4 + sc] = bestP;
    }
    const mMin = Math.min(nextPm[0], nextPm[1], nextPm[2], nextPm[3]);
    pm0 = nextPm[0] - mMin;
    pm1 = nextPm[1] - mMin;
    pm2 = nextPm[2] - mMin;
    pm3 = nextPm[3] - mMin;
    pathMetrics[n * 4] = pm0;
    pathMetrics[n * 4 + 1] = pm1;
    pathMetrics[n * 4 + 2] = pm2;
    pathMetrics[n * 4 + 3] = pm3;
  }

  // Exact traceback from the minimum-metric final state
  let st = 0;
  let bestEnd = pm0;
  if (pm1 < bestEnd) { bestEnd = pm1; st = 1; }
  if (pm2 < bestEnd) { bestEnd = pm2; st = 2; }
  if (pm3 < bestEnd) { st = 3; }
  for (let n = end - 1; n >= start; n--) {
    decisions[n] = st;
    st = prevStates[n * 4 + st];
  }
  return { decisions, prevStates, pathMetrics };
}

function summarizeDecisions(
  syms: Uint8Array,
  decs: Uint8Array,
  samples: Float64Array,
  start: number,
  end: number,
  effectiveResidues?: Float64Array,
): DetectorMcStats {
  const histRange = 1.6;
  const nBins = 80;
  const histCounts = new Uint16Array(nBins);
  let symErr = 0, bitErr = 0, err2 = 0, burstsGe2 = 0, maxBurst = 0, burstErrSyms = 0, run = 0;
  const totalSymbols = end - start;

  for (let n = start; n < end; n++) {
    const s = syms[n], d = decs[n];
    const wrong = s !== d;
    if (wrong) {
      symErr++;
      const g = GRAY[s] ^ GRAY[d];
      bitErr += (g & 1) + ((g >> 1) & 1);
      run++;
    } else if (run > 0) {
      if (run >= 2) {
        burstsGe2++;
        burstErrSyms += run;
      }
      if (run > maxBurst) maxBurst = run;
      run = 0;
    }
    const sampleVal = effectiveResidues ? effectiveResidues[n] : samples[n];
    const diff = sampleVal - LEVELS[s];
    err2 += diff * diff;
    const bin = Math.min(nBins - 1, Math.max(0, Math.floor(((sampleVal / histRange) + 1) * 0.5 * nBins)));
    histCounts[bin]++;
  }
  if (run > 0) {
    if (run >= 2) {
      burstsGe2++;
      burstErrSyms += run;
    }
    if (run > maxBurst) maxBurst = run;
  }
  const effSnrDb = 10 * Math.log10((EA * totalSymbols) / Math.max(1e-20, err2));
  return {
    ser: symErr / totalSymbols,
    ber: bitErr / (2 * totalSymbols),
    symbolErrors: symErr,
    bitErrors: bitErr,
    totalSymbols,
    totalBits: 2 * totalSymbols,
    effSnrDb,
    burstsGe2,
    maxBurst,
    burstErrorShare: symErr > 0 ? burstErrSyms / symErr : 0,
    histCounts,
    histRange,
  };
}

/** Run every detector on the exact same noisy ADC capture so comparisons are completely honest. */
export function runDetectorComparison(
  h: Float64Array,
  sigAdc: number,
  eqBypass: EqualizerResult,
  eqFfe12: EqualizerResult,
  eqFfe: EqualizerResult,
  eqPr1: EqualizerResult,
  nSym = 8000,
  seed = 0x224a,
): McComparison {
  const pad = 64;
  const nTotal = nSym + 2 * pad;
  const start = pad, end = pad + nSym;
  const rnd = mulberry32(seed);
  const gauss = makeNormals(seed ^ 0x9e3779b9);

  const syms = new Uint8Array(nTotal);
  const txLevels = new Float64Array(nTotal);
  const stx = Math.sqrt(STX2);
  for (let n = 0; n < nTotal; n++) {
    const s = Math.min(3, Math.floor(rnd() * 4));
    syms[n] = s;
    txLevels[n] = LEVELS[s] + gauss() * stx;
  }

  // Shared ADC sample vector (exact same ISI + TX distortion + ADC/CTLE/XT/jitter noise)
  const yAdc = new Float64Array(nTotal);
  for (let n = 0; n < nTotal; n++) {
    let v = 0;
    for (let k = -PRE; k <= POST; k++) {
      const idx = n - k;
      if (idx >= 0 && idx < nTotal) v += h[k + PRE] * txLevels[idx];
    }
    yAdc[n] = v + gauss() * sigAdc;
  }

  const applyFfe = (w: Float64Array): Float64Array => {
    const out = new Float64Array(nTotal);
    const nf = w.length;
    for (let n = start - 4; n < end + 4; n++) {
      let s = 0;
      for (let a = 0; a < nf; a++) {
        const idx = n - a + NFPRE;
        if (idx >= 0 && idx < nTotal) s += w[a] * yAdc[idx];
      }
      out[n] = s;
    }
    return out;
  };

  const yBypass = applyFfe(eqBypass.taps);
  const yFfe12 = applyFfe(eqFfe12.taps);
  const yFfe = applyFfe(eqFfe.taps);
  const yPr1 = applyFfe(eqPr1.taps);

  const decBypass = new Uint8Array(nTotal);
  const decFfe12 = new Uint8Array(nTotal);
  const decFfe = new Uint8Array(nTotal);
  const decDfe = new Uint8Array(nTotal);
  const decGenie = new Uint8Array(nTotal);
  const sampDfe = new Float64Array(nTotal);
  const sampGenie = new Float64Array(nTotal);
  const alpha = eqPr1.b1;

  for (let n = start; n < end; n++) {
    decBypass[n] = slicePam4(yBypass[n]);
    decFfe12[n] = slicePam4(yFfe12[n]);
    decFfe[n] = slicePam4(yFfe[n]);
    const prevReal = n > start ? decDfe[n - 1] : syms[n - 1];
    const zReal = yPr1[n] - alpha * LEVELS[prevReal];
    sampDfe[n] = zReal;
    decDfe[n] = slicePam4(zReal);
    const zGenie = yPr1[n] - alpha * LEVELS[syms[n - 1]];
    sampGenie[n] = zGenie;
    decGenie[n] = slicePam4(zGenie);
  }

  const vit = runViterbiPr1(yPr1, alpha, start, end);
  // Effective MLSE slicer-domain residual using MLSE's own sequence previous symbol
  const sampMlse = new Float64Array(nTotal);
  let rescuedCount = 0;
  for (let n = start; n < end; n++) {
    const prevM = n > start ? vit.decisions[n - 1] : syms[n - 1];
    sampMlse[n] = yPr1[n] - alpha * LEVELS[prevM];
    if (vit.decisions[n] === syms[n] && (decDfe[n] !== syms[n] || decFfe[n] !== syms[n])) rescuedCount++;
  }

  // Pick the most informative window: prefer a real DFE burst rescued by MLSE, else an FFE error rescued by MLSE, else first 16 symbols.
  let focusIdx = start + 8;
  let bestScore = -1;
  for (let n = start + 6; n < end - 14; n++) {
    let score = 0;
    const dfeErr = decDfe[n] !== syms[n];
    const mlseOk = vit.decisions[n] === syms[n];
    const ffeErr = decFfe[n] !== syms[n];
    if (dfeErr && mlseOk) score += 10;
    if (dfeErr && decDfe[n + 1] !== syms[n + 1] && mlseOk && vit.decisions[n + 1] === syms[n + 1]) score += 20;
    if (ffeErr && mlseOk) score += 5;
    if (score > bestScore) {
      bestScore = score;
      focusIdx = n;
      if (score >= 30) break;
    }
  }

  const winStart = Math.max(start + 1, focusIdx - 3);
  const winLen = 12;
  const trellisWindow: TrellisStep[] = [];
  for (let i = 0; i < winLen; i++) {
    const n = winStart + i;
    trellisWindow.push({
      symIndex: n - start,
      txSym: syms[n],
      yFfe: yPr1[n],
      ffeDec: decFfe[n],
      dfeDec: decDfe[n],
      mlseDec: vit.decisions[n],
      prevState: [
        vit.prevStates[n * 4],
        vit.prevStates[n * 4 + 1],
        vit.prevStates[n * 4 + 2],
        vit.prevStates[n * 4 + 3],
      ],
      pathMetric: [
        vit.pathMetrics[n * 4],
        vit.pathMetrics[n * 4 + 1],
        vit.pathMetrics[n * 4 + 2],
        vit.pathMetrics[n * 4 + 3],
      ],
    });
  }

  const stripLen = 48;
  const stripStart = Math.max(start, Math.min(end - stripLen, focusIdx - 8));
  const stripTx = new Uint8Array(stripLen);
  const stripFfeErr = new Uint8Array(stripLen);
  const stripDfeErr = new Uint8Array(stripLen);
  const stripMlseErr = new Uint8Array(stripLen);
  for (let i = 0; i < stripLen; i++) {
    const n = stripStart + i;
    stripTx[i] = syms[n];
    stripFfeErr[i] = decFfe[n] !== syms[n] ? 1 : 0;
    stripDfeErr[i] = decDfe[n] !== syms[n] ? 1 : 0;
    stripMlseErr[i] = vit.decisions[n] !== syms[n] ? 1 : 0;
  }

  // Note: for MLSE effective SNR, convert measured BER to equivalent PAM4 Gaussian SNR when errors exist,
  // or keep residual SNR when error-free, while always reporting exact observed BER and symbol errors.
  const bypass = summarizeDecisions(syms, decBypass, yBypass, start, end);
  const ffe12 = summarizeDecisions(syms, decFfe12, yFfe12, start, end);
  const ffe = summarizeDecisions(syms, decFfe, yFfe, start, end);
  const dfe = summarizeDecisions(syms, decDfe, sampDfe, start, end);
  const dfeGenie = summarizeDecisions(syms, decGenie, sampGenie, start, end);
  const mlse = summarizeDecisions(syms, vit.decisions, sampMlse, start, end);

  return {
    bypass,
    ffe12,
    ffe,
    dfe,
    dfeGenie,
    mlse,
    trellisWindow,
    rescuedCount,
    stripStart: stripStart - start,
    stripTx,
    stripFfeErr,
    stripDfeErr,
    stripMlseErr,
  };
}

/**
 * 1-D bounce-decomposed wave-splitting transmission line simulator.
 *
 * Uses the exact same physical segment layout (0.1 mm / 0.6 ps cells) as the
 * ABCD frequency model and splits the total wave algebraically into:
 *   - v0p: primary forward incident wave (0 reflections)
 *   - v1m: 1st-order backward reflection (bouncing back toward TX)
 *   - v2p: 2nd+-order forward echo (bouncing again toward RX)
 *   - v2m: higher-order backward reflection
 *
 * Algebraic invariant at every cell i and every time step n:
 *   v0p[i] + v2p[i] === vPlusTotal[i],  v1m[i] + v2m[i] === vMinusTotal[i].
 */
export class WaveLattice {
  readonly nCells: number;
  readonly totalMm: number;
  readonly zCell: Float64Array;
  readonly gamma: Float64Array;
  readonly cellAtten: Float64Array;
  readonly segments: PhysicalSegment[];
  readonly padCapFf: number;
  readonly tcoil: boolean;

  v0p: Float64Array;
  v1m: Float64Array;
  v2p: Float64Array;
  v2m: Float64Array;
  private n0p: Float64Array;
  private n1m: Float64Array;
  private n2p: Float64Array;
  private n2m: Float64Array;

  // Shunt capacitor trapezoidal port filter states (linearly split by bounce order!)
  private txSrcU = 0; private txSrcY = 0;
  private txRefU = 0; private txRefY = 0;
  private rx0U = 0; private rx0Y = 0;
  private rx2U = 0; private rx2Y = 0;

  // Butterworth bridged T-coil bilinear 2nd-order filter states (for TX launch & RX tap)
  private tcTxX1 = 0; private tcTxX2 = 0; private tcTxY1 = 0; private tcTxY2 = 0;
  private tcRxX1 = 0; private tcRxX2 = 0; private tcRxY1 = 0; private tcRxY2 = 0;

  stepCount = 0;
  lastRxPrimary = 0;
  lastRxEcho = 0;
  lastRxTotal = 0;
  lastTxReflected = 0;

  constructor(cfg: Pick<LinkConfig, 'lossDb' | 'zVia' | 'zConn' | 'pcbMm' | 'padCapFf' | 'tcoil'>, lossless = false) {
    this.segments = physicalSegments(cfg);
    this.padCapFf = cfg.padCapFf;
    this.tcoil = cfg.tcoil;
    const zList: number[] = [];
    const attenList: number[] = [];
    for (const seg of this.segments) {
      const count = Math.max(1, Math.round(seg.lengthMm / LATTICE_DX_MM));
      // Mild broadband visual attenuation per cell in animated mode (zero in lossless cross-validation mode)
      const segDb = lossless ? 0 : (seg.id === 'cable' ? Math.min(6, seg.lossDbAtFn * 0.14) : seg.lossDbAtFn * 0.35);
      const cellA = Math.exp(-(segDb * NP) / count);
      for (let i = 0; i < count; i++) {
        zList.push(seg.zOhm);
        attenList.push(cellA);
      }
    }
    this.nCells = zList.length;
    this.totalMm = this.nCells * LATTICE_DX_MM;
    this.zCell = Float64Array.from(zList);
    this.cellAtten = Float64Array.from(attenList);
    this.gamma = new Float64Array(this.nCells + 1);
    this.gamma[0] = (this.zCell[0] - Z0) / (this.zCell[0] + Z0);
    for (let j = 1; j < this.nCells; j++) {
      this.gamma[j] = (this.zCell[j] - this.zCell[j - 1]) / (this.zCell[j] + this.zCell[j - 1]);
    }
    this.gamma[this.nCells] = (Z0 - this.zCell[this.nCells - 1]) / (Z0 + this.zCell[this.nCells - 1]);

    this.v0p = new Float64Array(this.nCells);
    this.v1m = new Float64Array(this.nCells);
    this.v2p = new Float64Array(this.nCells);
    this.v2m = new Float64Array(this.nCells);
    this.n0p = new Float64Array(this.nCells);
    this.n1m = new Float64Array(this.nCells);
    this.n2p = new Float64Array(this.nCells);
    this.n2m = new Float64Array(this.nCells);
  }

  reset(): void {
    this.v0p.fill(0); this.v1m.fill(0); this.v2p.fill(0); this.v2m.fill(0);
    this.txSrcU = this.txSrcY = this.txRefU = this.txRefY = 0;
    this.rx0U = this.rx0Y = this.rx2U = this.rx2Y = 0;
    this.tcTxX1 = this.tcTxX2 = this.tcTxY1 = this.tcTxY2 = 0;
    this.tcRxX1 = this.tcRxX2 = this.tcRxY1 = this.tcRxY2 = 0;
    this.stepCount = 0;
    this.lastRxPrimary = this.lastRxEcho = this.lastRxTotal = this.lastTxReflected = 0;
  }

  /** Bilinear filter for 2nd-order Butterworth bridged T-coil H(s) = 1 / (1 + 0.5*tau*s + 0.125*tau^2*s^2). */
  private filterTcoil(x: number, isTx: boolean): number {
    const tau = Z0 * this.padCapFf * 1e-15;
    if (tau <= 1e-18) return x;
    const k = 2 / LATTICE_DT;
    const b0 = 1, b1 = 2, b2 = 1;
    const a0 = 1 + 0.5 * tau * k + 0.125 * tau * tau * k * k;
    const a1 = 2 - 0.25 * tau * tau * k * k;
    const a2 = 1 - 0.5 * tau * k + 0.125 * tau * tau * k * k;
    if (isTx) {
      const y = (b0 * x + b1 * this.tcTxX1 + b2 * this.tcTxX2 - a1 * this.tcTxY1 - a2 * this.tcTxY2) / a0;
      this.tcTxX2 = this.tcTxX1; this.tcTxX1 = x;
      this.tcTxY2 = this.tcTxY1; this.tcTxY1 = y;
      return y;
    }
    const y = (b0 * x + b1 * this.tcRxX1 + b2 * this.tcRxX2 - a1 * this.tcRxY1 - a2 * this.tcRxY2) / a0;
    this.tcRxX2 = this.tcRxX1; this.tcRxX1 = x;
    this.tcRxY2 = this.tcRxY1; this.tcRxY1 = y;
    return y;
  }

  /** Advance the physical line by one cell step Δt = 0.6 ps with matched-load source wave vSrc. */
  step(vSrc: number): void {
    const N = this.nCells;
    const { v0p, v1m, v2p, v2m, n0p, n1m, n2p, n2m, gamma, cellAtten } = this;
    const cp = this.padCapFf * 1e-15;
    const useShuntCap = !this.tcoil && cp > 0;
    const aCap = (2 * cp) / LATTICE_DT;
    const gPort = 2 / Z0;
    const cPrev = (aCap - gPort) / (aCap + gPort);
    const cIn = gPort / (aCap + gPort);

    // Port 0 (TX): first cell always has Z0 = 50 Ω (Package), so gamma[0] = 0, but general gamma[0] is supported.
    const g0 = gamma[0];
    const inBack = v1m[0] + v2m[0];
    let launchPrimary: number;
    let launchEcho: number;
    if (useShuntCap) {
      // Shunt capacitor at TX: primary launch passes through RC low-pass; returning waves reflect back as echoes!
      const ySrc = cPrev * this.txSrcY + cIn * (vSrc + this.txSrcU);
      this.txSrcU = vSrc; this.txSrcY = ySrc;
      const yRef = cPrev * this.txRefY + cIn * (inBack + this.txRefU);
      this.txRefU = inBack; this.txRefY = yRef;
      launchPrimary = ySrc;
      launchEcho = yRef - inBack;
      this.lastTxReflected = (ySrc - vSrc) + yRef;
    } else {
      const srcFilt = this.tcoil && cp > 0 ? this.filterTcoil(vSrc, true) : vSrc;
      launchPrimary = (1 + g0) * srcFilt;
      launchEcho = -g0 * inBack;
      this.lastTxReflected = g0 * srcFilt + (1 - g0) * inBack;
    }
    n0p[0] = launchPrimary * cellAtten[0];
    n2p[0] = launchEcho * cellAtten[0];

    // Interior boundaries j = 1 .. N - 1
    for (let j = 1; j < N; j++) {
      const gj = gamma[j];
      const aR = cellAtten[j], aL = cellAtten[j - 1];
      const f0 = v0p[j - 1], f2 = v2p[j - 1];
      const b1 = v1m[j], b2 = v2m[j];
      n0p[j] = (1 + gj) * f0 * aR;
      n1m[j - 1] = (gj * f0 + (1 - gj) * b1) * aL;
      n2p[j] = ((1 + gj) * f2 - gj * (b1 + b2)) * aR;
      n2m[j - 1] = (gj * f2 + (1 - gj) * b2) * aL;
    }

    // Port N (RX)
    const gN = gamma[N];
    const rxIn0 = v0p[N - 1], rxIn2 = v2p[N - 1];
    if (useShuntCap) {
      const y0 = cPrev * this.rx0Y + cIn * (rxIn0 + this.rx0U);
      this.rx0U = rxIn0; this.rx0Y = y0;
      const y2 = cPrev * this.rx2Y + cIn * (rxIn2 + this.rx2U);
      this.rx2U = rxIn2; this.rx2Y = y2;
      n1m[N - 1] = (y0 - rxIn0) * cellAtten[N - 1];
      n2m[N - 1] = (y2 - rxIn2) * cellAtten[N - 1];
      this.lastRxPrimary = y0;
      this.lastRxEcho = y2;
      this.lastRxTotal = y0 + y2;
    } else {
      n1m[N - 1] = gN * rxIn0 * cellAtten[N - 1];
      n2m[N - 1] = gN * rxIn2 * cellAtten[N - 1];
      const out0 = (1 + gN) * rxIn0;
      const out2 = (1 + gN) * rxIn2;
      const totalPort = out0 + out2;
      if (this.tcoil && cp > 0) {
        this.lastRxTotal = this.filterTcoil(totalPort, false);
        this.lastRxPrimary = out0;
        this.lastRxEcho = out2;
      } else {
        this.lastRxPrimary = out0;
        this.lastRxEcho = out2;
        this.lastRxTotal = totalPort;
      }
    }

    // Swap buffers
    this.v0p = n0p; this.n0p = v0p;
    this.v1m = n1m; this.n1m = v1m;
    this.v2p = n2p; this.n2p = v2p;
    this.v2m = n2m; this.n2m = v2m;
    this.stepCount++;
  }
}

/**
 * Pure helper for scientific cross-validation: drive a lossless WaveLattice with a Gaussian
 * test pulse and compare its time-domain RX & reflected waveforms against ABCD IFFT.
 */
export function runLatticeCrossCheck(
  cfg: Pick<LinkConfig, 'zVia' | 'zConn' | 'pcbMm' | 'padCapFf' | 'tcoil'>,
  nSteps = 900,
): { rxLattice: Float64Array; txRefLattice: Float64Array; rxAbcd: Float64Array; txRefAbcd: Float64Array; maxDecompErr: number } {
  const lat = new WaveLattice({ ...cfg, lossDb: 0 }, true);
  const segs = physicalSegments({ ...cfg, lossDb: 0 });
  const t0 = 20e-12, sigma = 3.2e-12;
  const vin = new Float64Array(nSteps);
  const rxLattice = new Float64Array(nSteps);
  const txRefLattice = new Float64Array(nSteps);

  // Also run an unsplit full-wave lattice to prove exact algebraic bounce decomposition
  const N = lat.nCells;
  let vp = new Float64Array(N), vm = new Float64Array(N);
  let maxDecompErr = 0;
  const cp = cfg.padCapFf * 1e-15;
  const useShunt = !cfg.tcoil && cp > 0;
  const aCap = (2 * cp) / LATTICE_DT, gPort = 2 / Z0;
  const cPrev = (aCap - gPort) / (aCap + gPort), cIn = gPort / (aCap + gPort);
  let fullTxU = 0, fullTxY = 0, fullRxU = 0, fullRxY = 0;

  for (let n = 0; n < nSteps; n++) {
    const t = n * LATTICE_DT;
    const src = Math.exp(-0.5 * ((t - t0) / sigma) ** 2);
    vin[n] = src;
    lat.step(src);
    rxLattice[n] = lat.lastRxTotal;
    txRefLattice[n] = lat.lastTxReflected;

    if (!cfg.tcoil || cp === 0) {
      const np = new Float64Array(N), nm = new Float64Array(N);
      if (useShunt) {
        const uTx = src + vm[0];
        const yTx = cPrev * fullTxY + cIn * (uTx + fullTxU);
        fullTxU = uTx; fullTxY = yTx;
        np[0] = yTx - vm[0];
      } else {
        np[0] = (1 + lat.gamma[0]) * src - lat.gamma[0] * vm[0];
      }
      for (let j = 1; j < N; j++) {
        const gj = lat.gamma[j];
        np[j] = (1 + gj) * vp[j - 1] - gj * vm[j];
        nm[j - 1] = gj * vp[j - 1] + (1 - gj) * vm[j];
      }
      if (useShunt) {
        const uRx = vp[N - 1];
        const yRx = cPrev * fullRxY + cIn * (uRx + fullRxU);
        fullRxU = uRx; fullRxY = yRx;
        nm[N - 1] = yRx - uRx;
      } else {
        nm[N - 1] = lat.gamma[N] * vp[N - 1];
      }
      vp = np; vm = nm;
      for (let i = 0; i < N; i++) {
        const e1 = Math.abs((lat.v0p[i] + lat.v2p[i]) - vp[i]);
        const e2 = Math.abs((lat.v1m[i] + lat.v2m[i]) - vm[i]);
        if (e1 > maxDecompErr) maxDecompErr = e1;
        if (e2 > maxDecompErr) maxDecompErr = e2;
      }
    }
  }

  // Frequency-domain ABCD reference using 2048-point FFT on the exact same dt grid
  const M = 2048;
  const vr = new Float64Array(M), vi = new Float64Array(M);
  for (let n = 0; n < nSteps; n++) vr[n] = vin[n];
  fft(vr, vi);
  const rxR = new Float64Array(M), rxI = new Float64Array(M);
  const txR = new Float64Array(M), txI = new Float64Array(M);
  const df = 1 / (M * LATTICE_DT);
  for (let k = 0; k <= M / 2; k++) {
    const ab = evalAbcdAt(k * df, segs, cfg.padCapFf, cfg.tcoil);
    rxR[k] = cMulRe(vr[k], vi[k], ab.s21r, ab.s21i);
    rxI[k] = cMulIm(vr[k], vi[k], ab.s21r, ab.s21i);
    txR[k] = cMulRe(vr[k], vi[k], ab.s11r, ab.s11i);
    txI[k] = cMulIm(vr[k], vi[k], ab.s11r, ab.s11i);
    if (k > 0 && k < M / 2) {
      rxR[M - k] = rxR[k]; rxI[M - k] = -rxI[k];
      txR[M - k] = txR[k]; txI[M - k] = -txI[k];
    }
  }
  rxI[M / 2] = 0; txI[M / 2] = 0;
  for (let k = 0; k < M; k++) { rxI[k] = -rxI[k]; txI[k] = -txI[k]; }
  fft(rxR, rxI); fft(txR, txI);
  const rxAbcd = new Float64Array(nSteps);
  const txRefAbcd = new Float64Array(nSteps);
  for (let n = 0; n < nSteps; n++) {
    rxAbcd[n] = rxR[n] / M;
    txRefAbcd[n] = txR[n] / M;
  }
  return { rxLattice, txRefLattice, rxAbcd, txRefAbcd, maxDecompErr };
}
