/**
 * Guided walkthrough steps and representative link presets covering:
 * 1) Low-frequency wire vs 224G travelling-wave intuition
 * 2) Impedance discontinuities, reflections, echoes and S21 notches
 * 3) Pad/ESD capacitance vs bridged T-coil impedance matching
 * 4) Why 224G needs 29–44 tap far FFE
 * 5) Five-equalizer division of labor, noise enhancement & DFE error propagation
 * 6) 4-state Viterbi MLSE SNR recovery
 */
import { DEFAULT_CONFIG, type LinkConfig, type WaveExcitation } from './model';

export interface GuidedStep {
  id: string;
  shortLabel: string;
  title: string;
  body: string;
  lookFor: string;
  excitation: WaveExcitation;
  config: Partial<LinkConfig>;
}

export const GUIDED_STEPS: readonly GuidedStep[] = [
  {
    id: 'wave-vs-wire',
    shortLabel: '1 · Wire vs wave',
    title: 'Break the low-frequency wire intuition',
    body: 'At low frequencies a trace rises and falls almost simultaneously like a rigid wire. At 224G PAM4 (112 GBd, 1 UI = 8.93 ps), light in a laminate moves 1 mm every 6 ps, so more than twenty symbols travel shoulder-to-shoulder inside a 32 mm board path.',
    lookFor: 'Switch the wave source from Low-freq wire to 224G stream: with uniform 50 Ω impedance and T-coils on, the blue wave glides smoothly to the receiver with zero reflection.',
    excitation: 'lowfreq',
    config: {
      lossDb: 18,
      zVia: 50,
      zConn: 50,
      pcbMm: 14.5,
      padCapFf: 140,
      tcoil: true,
      txFfe: true,
      ctleOn: true,
      autoCtle: true,
      ffePostTaps: 40,
      rxNoiseMv: 0.6,
      xtMv: 1.2,
      detector: 'ffe',
    },
  },
  {
    id: 'reflection-echo',
    shortLabel: '2 · Reflection & echo',
    title: 'Impedance steps create reflections and late echoes',
    body: 'A via pad (32 Ω) and a connector pin (74 Ω) act like sudden knots in a rope. Each step bounces part of the energy backward (red). When that backward wave hits an earlier discontinuity, it bounces a second time (purple echo) and chases the main signal toward the receiver.',
    lookFor: 'Watch a single 8.9 ps pulse split at the via and connector, then watch the purple echo trail ~22 UI behind it—and carve periodic destructive-interference notches into S21.',
    excitation: 'single',
    config: {
      lossDb: 28,
      zVia: 32,
      zConn: 74,
      pcbMm: 14.5,
      padCapFf: 140,
      tcoil: true,
      txFfe: true,
      ctleOn: true,
      autoCtle: true,
      ffePostTaps: 40,
      rxNoiseMv: 0.6,
      xtMv: 1.2,
      detector: 'ffe',
    },
  },
  {
    id: 'tcoil',
    shortLabel: '3 · T-coil matching',
    title: 'Why TX/RX pads need a bridged T-coil',
    body: 'On-die ESD diodes and bump pads add ~140 fF right at the chip doorway—only 20 Ω of reactance at 56 GHz. Without a T-coil, waves bounce straight off the chip pins (poor S11) and add extra echoes and >5 dB of roll-off. A bridged T-coil absorbs the capacitance into a constant-resistance 50 Ω network.',
    lookFor: 'Toggle T-coil Off vs On: S11 collapses from near −1.5 dB, port-reflected purple echoes vanish, and 56 GHz insertion loss improves by more than 5 dB.',
    excitation: 'single',
    config: {
      lossDb: 30,
      zVia: 34,
      zConn: 72,
      pcbMm: 14.5,
      padCapFf: 140,
      tcoil: false,
      txFfe: true,
      ctleOn: true,
      autoCtle: true,
      ffePostTaps: 40,
      rxNoiseMv: 0.6,
      xtMv: 1.2,
      detector: 'ffe',
    },
  },
  {
    id: 'far-ffe',
    shortLabel: '4 · 44-tap far FFE',
    title: 'Why 224G needs 29–44 FFE taps for far echoes',
    body: 'Even with ideal T-coils at the dies, board vias and connectors still launch residual echoes 15–35 UI late. A 12-tap FFE only reaches +8 UI and leaves the +22 UI connector bump intact. Extending the FFE to 44 taps places an exact opposite-sign tap right under the late echo.',
    lookFor: 'Look at the pulse response around +22 UI, then drag RX FFE taps from 12 to 44: the far tap rises at +22 UI, flattens the reflection bump, and lifts measured SNR.',
    excitation: 'stream224',
    config: {
      lossDb: 30,
      zVia: 28,
      zConn: 78,
      pcbMm: 14.5,
      padCapFf: 140,
      tcoil: true,
      txFfe: true,
      ctleOn: true,
      autoCtle: true,
      ffePostTaps: 8,
      rxNoiseMv: 0.4,
      xtMv: 0.8,
      detector: 'ffe',
    },
  },
  {
    id: 'dfe-burst',
    shortLabel: '5 · Equalizer tradeoffs',
    title: 'Each equalizer solves one ISI region—at a physical cost',
    body: 'At 40 dB loss, TX FFE clears h(−1) by sacrificing launch swing; CTLE and linear FFE clear the long tail and far echo but amplify noise heavily. A 1-tap DFE cancels the largest post-cursor h(+1) with zero noise amplification—cutting FFE noise boost in half—but a single wrong decision propagates into a burst of errors.',
    lookFor: 'Compare FFE vs FFE + DFE on the exact same ADC samples: noise boost drops sharply and SNR jumps, yet the decision strip reveals multi-symbol red DFE error bursts.',
    excitation: 'stream224',
    config: {
      ...DEFAULT_CONFIG,
      lossDb: 40,
      zVia: 32,
      zConn: 74,
      ffePostTaps: 40,
      detector: 'dfe',
    },
  },
  {
    id: 'mlse-rescue',
    shortLabel: '6 · MLSE rescue',
    title: '4-state Viterbi MLSE recovers SNR without DFE bursts',
    body: 'Instead of making an irreversible hard decision at every symbol like DFE, a 4-state Viterbi MLSE keeps all four PAM4 candidate states alive for the partial-response target 1 + αD and chooses the lowest-distance path over many symbols.',
    lookFor: 'Inspect the live Viterbi trellis window: where noise pushes one sample past a slicer threshold—causing a DFE burst—MLSE uses the following symbols to stay on the true path and cuts BER dramatically.',
    excitation: 'stream224',
    config: {
      ...DEFAULT_CONFIG,
      lossDb: 40,
      zVia: 32,
      zConn: 74,
      ffePostTaps: 40,
      detector: 'mlse',
    },
  },
];

export interface EqualizerSummaryRow {
  name: string;
  target: string;
  strength: string;
  tradeoff: string;
}

export const EQUALIZER_ROLES: readonly EqualizerSummaryRow[] = [
  {
    name: 'TX FFE',
    target: 'h(−1) pre-cursor',
    strength: 'Pre-distorts before the channel without amplifying RX noise',
    tradeoff: 'Sacrifices launch swing (Σ|c| = 1 peak constraint)',
  },
  {
    name: 'CTLE',
    target: 'Broadband HF loss',
    strength: 'Opens a closed analog eye before the ADC',
    tradeoff: 'Boosts front-end thermal noise and crosstalk together',
  },
  {
    name: 'RX FFE (29–44 taps)',
    target: 'Long tail & far reflection',
    strength: 'FIR taps clean extended tails and +15…+35 UI connector echoes',
    tradeoff: 'Linear inversion amplifies noise around roll-off and notches',
  },
  {
    name: '1-tap DFE',
    target: 'h(+1) first post-cursor',
    strength: 'Subtracts the biggest post-cursor with zero noise amplification',
    tradeoff: 'A wrong decision feeds back and causes burst error propagation',
  },
  {
    name: 'MLSE (Viterbi)',
    target: 'PR target 1 + αD sequence',
    strength: 'Recovers SNR lost by FFE while suppressing DFE burst errors',
    tradeoff: 'High digital compute & power (16 branch metrics + 4 ACS/UI)',
  },
];
