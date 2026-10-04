/** Channel-only examples. Changing a channel must not change TX equalization, noise or the selected RX DSP. */
export const CHANNELS = [
  { id: 'short', name: 'Short', detail: '8 dB loss', lossDb: 8, echo: 0, note: 'A short, low-loss path with little ISI.' },
  { id: 'lossy', name: 'Lossy', detail: '28 dB loss', lossDb: 28, echo: 0, note: 'Distributed loss spreads each symbol into its neighbours.' },
  { id: 'echo', name: '1 UI echo', detail: 'DFE example', lossDb: 12, echo: 0.85, note: 'A strong delayed path creates a Nyquist notch and a large postcursor.' },
  { id: 'long', name: 'Long', detail: '42 dB loss', lossDb: 42, echo: 0, note: 'High loss exposes noise enhancement and DFE error propagation.' },
] as const;

export type ChannelExample = typeof CHANNELS[number];
