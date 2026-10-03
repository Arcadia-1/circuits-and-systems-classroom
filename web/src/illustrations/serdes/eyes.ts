/** Draws an EyeImage density onto a canvas: grid, persistence-style colour map, slicer levels and axis labels. */
import type { EyeImage } from './streams';

type Rgba = [number, number, number, number];
function ramp(stops: [number, Rgba][]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [xa, ca] = stops[k], [xb, cb] = stops[k + 1], t = (x - xa) / (xb - xa);
    for (let j = 0; j < 4; j++) lut[i * 4 + j] = ca[j] + (cb[j] - ca[j]) * t;
  }
  return lut;
}
const DARK = ramp([[0, [20, 50, 95, 0]], [0.1, [32, 84, 150, 150]], [0.35, [70, 145, 235, 235]], [0.65, [150, 200, 255, 255]], [1, [245, 250, 255, 255]]]);
const LIGHT = ramp([[0, [200, 222, 245, 0]], [0.1, [150, 190, 235, 150]], [0.35, [60, 120, 200, 235]], [0.65, [30, 80, 160, 255]], [1, [10, 30, 70, 255]]]);

export interface EyeStyle {
  light: boolean;
  /** Half the vertical span, in the eye's own units. */
  range: number;
  /** PAM4 level amplitude for the dashed slicer thresholds, or null for none. */
  amplitude: number | null;
  corner: string;
  /** Width of the displayed time window, in UI. */
  spanUi?: number;
}

const offscreen = new WeakMap<HTMLCanvasElement, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData }>();

export function drawEye(canvas: HTMLCanvasElement, eye: EyeImage, style: EyeStyle): void {
  const W = canvas.width, H = canvas.height, css = canvas.clientWidth;
  const g = canvas.getContext('2d');
  if (!W || !H || !css || !g) return;
  let off = offscreen.get(canvas);
  if (!off || off.canvas.width !== eye.width || off.canvas.height !== eye.height) {
    const c = document.createElement('canvas');
    c.width = eye.width;
    c.height = eye.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    off = { canvas: c, ctx, img: ctx.createImageData(eye.width, eye.height) };
    offscreen.set(canvas, off);
  }
  const lut = style.light ? LIGHT : DARK, buf = eye.buf, d = off.img.data;
  let max = 0;
  for (let k = 0; k < buf.length; k++) if (buf[k] > max) max = buf[k];
  const inv = max > 0 ? 1.7 / max : 0;
  for (let k = 0, j = 0; k < buf.length; k++, j += 4) {
    const o = ((Math.sqrt(Math.min(1, buf[k] * inv)) * 255) | 0) * 4;
    d[j] = lut[o];
    d[j + 1] = lut[o + 1];
    d[j + 2] = lut[o + 2];
    d[j + 3] = lut[o + 3];
  }
  off.ctx.putImageData(off.img, 0, 0);
  const dpr = W / css, ink = style.light ? 'rgba(23, 33, 46, 0.72)' : 'rgba(210, 222, 236, 0.8)';
  g.clearRect(0, 0, W, H);
  g.strokeStyle = style.light ? 'rgba(23, 33, 46, 0.08)' : 'rgba(150, 190, 215, 0.1)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 1; x < 8; x++) {
    const X = Math.round((x * W) / 8) + 0.5;
    g.moveTo(X, 0);
    g.lineTo(X, H);
  }
  for (let y = 1; y < 4; y++) {
    const Y = Math.round((y * H) / 4) + 0.5;
    g.moveTo(0, Y);
    g.lineTo(W, Y);
  }
  g.stroke();
  g.imageSmoothingEnabled = true;
  g.drawImage(off.canvas, 0, 0, W, H);
  if (style.amplitude !== null) {
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.strokeStyle = style.light ? 'rgba(179, 105, 22, 0.75)' : 'rgba(240, 180, 92, 0.6)';
    g.beginPath();
    for (const th of [-2 / 3, 0, 2 / 3]) {
      const y = Math.round((0.5 - (th * style.amplitude) / (2 * style.range)) * H) + 0.5;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    g.stroke();
    g.setLineDash([]);
  }
  g.strokeStyle = style.light ? 'rgba(23, 33, 46, 0.3)' : 'rgba(255, 255, 255, 0.3)';
  g.beginPath();
  g.moveTo(Math.round(W / 2) + 0.5, 0);
  g.lineTo(Math.round(W / 2) + 0.5, H);
  g.stroke();
  g.fillStyle = ink;
  g.font = `${10.5 * dpr}px 'Google Sans Code Variable', ui-monospace, monospace`;
  g.textBaseline = 'top';
  g.textAlign = 'left';
  g.fillText(style.corner, 5 * dpr, 4 * dpr);
  g.textBaseline = 'bottom';
  g.fillText(`−${(style.spanUi ?? 2) / 2} UI`, 5 * dpr, H - 3 * dpr);
  g.textAlign = 'right';
  g.fillText(`+${(style.spanUi ?? 2) / 2} UI`, W - 5 * dpr, H - 3 * dpr);
}
