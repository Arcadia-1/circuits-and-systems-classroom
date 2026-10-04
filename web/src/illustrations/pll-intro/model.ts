/** Averaged phase-domain type-I / type-II PLL. Time: µs; frequency: MHz; phase: rad.
 * This linear detector illustrates tracking near lock, not nonlinear PFD acquisition or reference spurs. */
export interface PllSettings { refMHz: number; divider: number; freeMHz: number; kvco: number; naturalKHz: number; damping: number; integral: boolean; closed: boolean; kick: boolean }
export const DEFAULTS: PllSettings = { refMHz: 10, divider: 4, freeMHz: 36, kvco: 12, naturalKHz: 150, damping: 0.707, integral: true, closed: true, kick: false };
export const DT = 0.01, DURATION = 24, KICK_AT = 10;
export interface PllPoint { t: number; error: number; control: number; frequency: number; referencePhase: number; feedbackPhase: number; saturated: boolean }
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
export function gains(s: PllSettings) {
  const wn = 2 * Math.PI * s.naturalKHz / 1000, k = 2 * Math.PI * s.kvco / s.divider;
  return { kp: 2 * s.damping * wn / k, ki: wn * wn / k };
}
export function simulate(s: PllSettings): PllPoint[] {
  const { kp, ki } = gains(s);
  let e = Math.PI / 4, integral = 0;
  const out: PllPoint[] = [];
  const values = (phase: number, i: number) => {
    const requested = s.closed ? kp * phase + (s.integral ? i : 0) : 0;
    const control = clamp(requested), frequency = Math.max(0.1, s.freeMHz + s.kvco * control);
    return { control, frequency, saturated: Math.abs(requested) > 1 };
  };
  const derivative = (phase: number, i: number): [number, number] => {
    const v = values(phase, i);
    const antiWindup = v.saturated && phase * v.control > 0;
    return [2 * Math.PI * (s.refMHz - v.frequency / s.divider), s.closed && s.integral && !antiWindup ? ki * phase : 0];
  };
  for (let n = 0; n <= Math.round(DURATION / DT); n++) {
    const t = n * DT;
    if (s.kick && n === Math.round(KICK_AT / DT)) e += Math.PI / 4;
    const referencePhase = 2 * Math.PI * s.refMHz * t + Math.PI / 4 + (s.kick && t >= KICK_AT ? Math.PI / 4 : 0);
    out.push({ t, error: e, ...values(e, integral), referencePhase, feedbackPhase: referencePhase - e });
    const a = derivative(e, integral), b = derivative(e + DT * a[0] / 2, integral + DT * a[1] / 2);
    const c = derivative(e + DT * b[0] / 2, integral + DT * b[1] / 2), d = derivative(e + DT * c[0], integral + DT * c[1]);
    e += DT * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
    integral += DT * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
  }
  return out;
}
export function canLock(s: PllSettings): boolean { return Math.abs(s.refMHz * s.divider - s.freeMHz) <= s.kvco; }
