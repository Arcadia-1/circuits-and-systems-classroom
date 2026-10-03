/**
 * NRZ eye diagrams folded two ways from the same edges: by the recovered clock (what the CDR's data sampler sees) and by
 * the free-running local clock (what a receiver without a CDR would see). The transitions are raised-cosine steps as
 * wide as the eye closure, so the drawn eye closes where the model counts a timing-margin violation.
 */
import { EyeImage } from '../serdes/streams';
import { EYE_CLOSURE, wrap, type UiSample } from './model';

const OS = 32;
const RISE = 2 * EYE_CLOSURE;
const rc = (x: number) => (x < -0.5 ? 0 : x > 0.5 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * (x + 0.5)));
const level = (b: number) => (b ? 1 : -1);

export class NrzEyes {
  readonly recovered = new EyeImage();
  readonly free = new EyeImage();
  private readonly last: UiSample[] = [];
  private readonly win = new Float32Array(2 * OS + 1);

  /** Add the newest UI; the eye of the bit before it is drawn once its right-hand edge is known. */
  push(s: UiSample): void {
    this.last.push(s);
    if (this.last.length < 3) return;
    if (this.last.length > 3) this.last.shift();
    const [a, b, c] = this.last;
    this.trace(this.recovered, a.bit, b.bit, c.bit, wrap(b.edge - b.theta) - 0.5, 0.5 + wrap(c.edge - b.theta));
    this.trace(this.free, a.bit, b.bit, c.bit, wrap(b.edge) - 0.5, 0.5 + wrap(c.edge));
  }
  decay(k: number): void {
    this.recovered.decay(k);
    this.free.decay(k);
  }
  clear(): void {
    this.recovered.buf.fill(0);
    this.free.buf.fill(0);
    this.last.length = 0;
  }
  private trace(img: EyeImage, b0: number, b1: number, b2: number, left: number, right: number): void {
    const l0 = level(b0), l1 = level(b1), l2 = level(b2);
    for (let i = 0; i <= 2 * OS; i++) {
      const t = -1 + i / OS;
      this.win[i] = l0 + (l1 - l0) * rc((t - left) / RISE) + (l2 - l1) * rc((t - right) / RISE);
    }
    img.trace(this.win, 1.35);
  }
}
