import { DEFAULT_ERRORS, evaluateStage, normalizeErrorSettings, type PipelineErrorSettings } from './errors';

export interface StageCurvePoint { x: number; y: number }

export interface LocalStageCurve {
  /** Zero-based index. Every x coordinate is this stage's LOCAL input. */
  stage: number;
  bits: number;
  gain: number;
  flash: boolean;
  injected: boolean;
  xDomain: [number, number];
  /** Residue volts for amplifier stages; integer digit for the final flash. */
  yDomain: [number, number];
  actual: StageCurvePoint[][];
  ideal: StageCurvePoint[][];
  /** Closed envelopes of reachable values; a reset's upper limit may be unattained. */
  inputRange: [number, number];
  outputRange: [number, number];
}

/**
 * Every local transfer characteristic includes its nominal 0–1 V input range,
 * even if a preceding under-gain amplifier cannot reach all of it. Positive
 * overrange is retained through all later stages. These are NOT curves versus
 * original Vin; moving markers must use the corresponding trace.stage.input.
 */
export function localStageCurves(bits: readonly number[], settings: PipelineErrorSettings = DEFAULT_ERRORS): LocalStageCurve[] {
  const normalized = normalizeErrorSettings(bits, settings);
  const configured = new Set((Array.isArray(settings) ? settings : [settings]).map(entry => entry.stage));
  let reachableInputMax = 1;
  return bits.map((stageBits, stage): LocalStageCurve => {
    const gain = 2 ** stageBits, flash = stage === bits.length - 1, injected = configured.has(stage);
    const inputRange: [number, number] = [0, reachableInputMax];
    const xMax = Math.max(1, reachableInputMax);
    const coefficients = normalized[stage] ?? null;
    const actual: StageCurvePoint[][] = [], ideal: StageCurvePoint[][] = [];
    for (let digit = 0; digit < gain; digit++) {
      const x0 = digit / gain, x1 = digit === gain - 1 ? xMax : (digit + 1) / gain;
      if (flash) {
        const branch = [{ x: x0, y: digit }, { x: x1, y: digit }];
        actual.push(branch);
        ideal.push(branch.map(point => ({ ...point })));
      } else {
        // All branch endpoints are exact one-sided values; cubic interiors are
        // sampled only for drawing. No line ever joins separate reset branches.
        const count = coefficients && coefficients.nonlinearity !== 0 ? 33 : 2;
        actual.push(Array.from({ length: count }, (_, index) => {
          const x = x0 + (x1 - x0) * index / (count - 1);
          return { x, y: evaluateStage(x, stageBits, coefficients, digit).residue };
        }));
        ideal.push([{ x: x0, y: evaluateStage(x0, stageBits, null, digit).residue }, { x: x1, y: evaluateStage(x1, stageBits, null, digit).residue }]);
      }
    }

    let reachableOutputMax: number;
    if (flash) {
      reachableOutputMax = evaluateStage(reachableInputMax, stageBits).digit;
    } else if (reachableInputMax >= 1) {
      reachableOutputMax = evaluateStage(reachableInputMax, stageBits, coefficients).residue;
    } else {
      // A complete lower quantizer interval approaches residue 1 even when the
      // value at maximum input lies on a later, incomplete ramp.
      reachableOutputMax = reachableInputMax >= 1 / gain
        ? evaluateStage(1, stageBits, coefficients).residue
        : evaluateStage(reachableInputMax, stageBits, coefficients).residue;
    }

    const displayedActualMax = flash ? gain - 1 : evaluateStage(xMax, stageBits, coefficients).residue;
    const displayedIdealMax = flash ? gain - 1 : evaluateStage(xMax, stageBits).residue;
    const yMax = flash ? gain - 1 : Math.max(1, reachableOutputMax, displayedActualMax, displayedIdealMax);
    const result: LocalStageCurve = { stage, bits: stageBits, gain, flash, injected, xDomain: [0, xMax], yDomain: [0, yMax], actual, ideal, inputRange, outputRange: [0, reachableOutputMax] };
    reachableInputMax = reachableOutputMax;
    return result;
  });
}
