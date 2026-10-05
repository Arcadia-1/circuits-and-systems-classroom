/** Voltage plots share a fixed scale so an error cannot rescale itself away. */
export const VOLTAGE_DOMAIN = [-0.1, 1.1] as const;

/**
 * Common DNL/INL axis policy, in LSBs. Keep small errors on a fixed ±0.5
 * reference scale; larger errors expand symmetrically with 10% headroom,
 * rounded outward to one decimal place. This must not alter the plotted data.
 */
export function linearityDomain(values: readonly number[]): [number, number] {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));
  const limit = peak <= 0.5 ? 0.5 : Math.ceil(peak * 1.1 * 10) / 10;
  return [-limit, limit];
}
