import type { ErrorConversion, LinearityAnalysis } from './errors';

export interface ProgressiveWindow {
  /** Original-Vin interval displayed for this stage, never a local-voltage axis. */
  domain: [number, number];
  /** True interval selected by this stage's prefix; final flash has no next zoom. */
  selected: [number, number] | null;
  /** Display magnification into the next row, not the residue-amplifier gain. */
  zoom: number | null;
  /** The requested domain or selected prefix exists only at a boundary. */
  boundaryOnly: boolean;
}

/**
 * A nonredundant prefix P contains exactly final codes [P·stride,(P+1)·stride).
 * True final-code thresholds therefore give its original-input interval even
 * when internal codes are missing. A zero-width prefix stays zero-width: its
 * display uses the nearest nonempty ancestor, rather than a neighboring prefix
 * or an invented finite input interval.
 */
export function progressiveWindows(conversion: ErrorConversion, analysis: LinearityAnalysis): ProgressiveWindow[] {
  if (conversion.levels !== analysis.levels || conversion.totalBits !== analysis.totalBits || conversion.stages.length !== analysis.bits.length || conversion.stages.some((stage, index) => stage.bits !== analysis.bits[index]) || analysis.thresholds.length !== analysis.levels + 1) {
    throw new RangeError('Conversion and transition analysis must describe the same topology.');
  }

  const prefixes = conversion.stages.map((stage): [number, number] => {
    const stride = analysis.levels / 2 ** stage.resolvedBits;
    const lower = analysis.thresholds[stage.prefixCode * stride];
    const upper = analysis.thresholds[(stage.prefixCode + 1) * stride];
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper > 1 || upper < lower) {
      throw new RangeError('Prefix thresholds must form an ordered interval inside [0, 1].');
    }
    return [lower, upper];
  });
  const positive = (interval: [number, number]) => interval[1] > interval[0];
  const windows = conversion.stages.map((_, index): ProgressiveWindow => {
    const requested: [number, number] = index === 0 ? [0, 1] : prefixes[index - 1];
    let domain = requested;
    if (!positive(domain)) {
      domain = [0, 1];
      for (let ancestor = index - 2; ancestor >= 0; ancestor--) {
        if (positive(prefixes[ancestor])) { domain = prefixes[ancestor]; break; }
      }
    }
    const selected = index === conversion.stages.length - 1 ? null : prefixes[index];
    return {
      domain: [...domain], selected: selected ? [...selected] : null, zoom: null,
      boundaryOnly: !positive(requested) || (selected !== null && !positive(selected)),
    };
  });

  for (let index = 0; index < windows.length - 1; index++) {
    const current = windows[index], next = windows[index + 1], selected = current.selected;
    if (selected && positive(selected) && selected[0] === next.domain[0] && selected[1] === next.domain[1]) {
      current.zoom = (current.domain[1] - current.domain[0]) / (next.domain[1] - next.domain[0]);
    }
  }
  return windows;
}
