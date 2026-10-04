/** Foreground calibration against a known reference ramp. Fit x ≈ Σ c_k (y/scale)^k.
 * Validation uses a separate coherent sine and an independent noise seed. */
import { gaussians } from '../../lib/rng';
import { analyzeSpectrum } from '../../lib/spectrum';
export interface Device { quadratic: number; cubic: number; noiseMv: number }
export interface Training { amplitude: number; count: number; degree: number }
export interface Fit { coefficients: number[]; scale: number; device: Device; training: Training; x: Float64Array; y: Float64Array }
export const DEFAULTS: Device = { quadratic: .06, cubic: -.16, noiseMv: .3 };
export const TRAINING: Training = { amplitude: .95, count: 512, degree: 5 };
export const N = 2048, TONE = 53, LSB = 1 / 2048;
export const transfer = (x: number, s: Device) => x + s.quadratic * x * x + s.cubic * x * x * x;
export function adc(x: number, s: Device, noise = 0): number {
  return Math.max(-2048, Math.min(2047, Math.round((transfer(x, s) + noise) / LSB))) * LSB;
}
/** Twice-orthogonalized QR: avoid squaring the polynomial system's condition number. */
export function leastSquares(columns: Float64Array[], target: Float64Array): number[] {
  const k = columns.length, n = target.length, q: Float64Array[] = [], r = Array.from({ length: k }, () => new Float64Array(k));
  for (let j = 0; j < k; j++) {
    const v = columns[j].slice();
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < j; i++) {
      let dot = 0; for (let m = 0; m < n; m++) dot += q[i][m] * v[m];
      r[i][j] += dot; for (let m = 0; m < n; m++) v[m] -= dot * q[i][m];
    }
    r[j][j] = Math.hypot(...v);
    if (r[j][j] < 1e-10) throw new Error('Training record does not identify this polynomial.');
    q.push(v.map(x => x / r[j][j]));
  }
  const c = q.map(col => col.reduce((sum, v, i) => sum + v * target[i], 0));
  for (let j = k - 1; j >= 0; j--) { for (let i = j + 1; i < k; i++) c[j] -= r[j][i] * c[i]; c[j] /= r[j][j]; }
  return c;
}
export function fitInverse(s: Device, t: Training): Fit {
  const x = Float64Array.from({ length: t.count }, (_, i) => t.amplitude * (2 * i / (t.count - 1) - 1));
  const noise = gaussians(t.count, 71), y = x.map((v, i) => adc(v, s, noise[i] * s.noiseMv / 1000));
  const scale = Math.max(...y.map(Math.abs), .01);
  const columns = Array.from({ length: t.degree + 1 }, (_, k) => y.map(v => (v / scale) ** k));
  return { coefficients: leastSquares(columns, x), scale, device: { ...s }, training: { ...t }, x, y };
}
export function correct(y: number, fit: Fit): number {
  return fit.coefficients.reduceRight((v, c) => v * y / fit.scale + c, 0);
}
export function validate(s: Device, fit: Fit | null, amplitude: number) {
  const noise = gaussians(N, 903), input = Float64Array.from({ length: N }, (_, i) => amplitude * Math.sin(2 * Math.PI * TONE * i / N + .37));
  const raw = input.map((v, i) => adc(v, s, noise[i] * s.noiseMv / 1000));
  const calibrated = raw.map(v => fit ? correct(v, fit) : v);
  const rms = (y: Float64Array) => Math.sqrt(y.reduce((sum, v, i) => sum + (v - input[i]) ** 2, 0) / N);
  return { input, raw, calibrated, before: analyzeSpectrum(raw, 1), after: analyzeSpectrum(calibrated, 1), rmsBefore: rms(raw), rmsAfter: rms(calibrated), clipped: raw.filter(v => v === -1 || v === 2047 / 2048).length };
}
export function minimumSlope(s: Device, amplitude: number): number {
  const xs = [-amplitude, amplitude];
  if (s.cubic !== 0) { const vertex = -s.quadratic / (3 * s.cubic); if (Math.abs(vertex) <= amplitude) xs.push(vertex); }
  return Math.min(...xs.map(x => 1 + 2 * s.quadratic * x + 3 * s.cubic * x * x));
}
