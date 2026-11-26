<script lang="ts">
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import {
    DEFAULT_CONFIG,
    analyze224gLink,
    type Analysis224g,
    type DetectorMode,
    type LinkConfig,
    type WaveExcitation,
  } from './model';
  import { GUIDED_STEPS, type GuidedStep } from './presets';
  import WaveLinkCanvas from './WaveLinkCanvas.svelte';
  import ChannelSparamChart from './ChannelSparamChart.svelte';
  import EqualizerPulseChart from './EqualizerPulseChart.svelte';
  import EqualizerComparePanel from './EqualizerComparePanel.svelte';

  let stepIdx = $state<number>(1); // Start on step 2 (Reflection & echo) so reflections & echoes are immediately visible!
  const initialStep = GUIDED_STEPS[1];

  let lossDb = $state(initialStep.config.lossDb ?? DEFAULT_CONFIG.lossDb);
  let zVia = $state(initialStep.config.zVia ?? DEFAULT_CONFIG.zVia);
  let zConn = $state(initialStep.config.zConn ?? DEFAULT_CONFIG.zConn);
  let pcbMm = $state(initialStep.config.pcbMm ?? DEFAULT_CONFIG.pcbMm);
  let padCapFf = $state(initialStep.config.padCapFf ?? DEFAULT_CONFIG.padCapFf);
  let tcoil = $state(initialStep.config.tcoil ?? DEFAULT_CONFIG.tcoil);
  let txFfe = $state(initialStep.config.txFfe ?? DEFAULT_CONFIG.txFfe);
  let ctleOn = $state(initialStep.config.ctleOn ?? DEFAULT_CONFIG.ctleOn);
  let autoCtle = $state(initialStep.config.autoCtle ?? DEFAULT_CONFIG.autoCtle);
  let gdc = $state(initialStep.config.gdc ?? DEFAULT_CONFIG.gdc);
  let gdc2 = $state(initialStep.config.gdc2 ?? DEFAULT_CONFIG.gdc2);
  let ffePostTaps = $state(initialStep.config.ffePostTaps ?? DEFAULT_CONFIG.ffePostTaps);
  let rxNoiseMv = $state(initialStep.config.rxNoiseMv ?? DEFAULT_CONFIG.rxNoiseMv);
  let xtMv = $state(initialStep.config.xtMv ?? DEFAULT_CONFIG.xtMv);
  let detector = $state<DetectorMode>(initialStep.config.detector ?? DEFAULT_CONFIG.detector);
  let excitation = $state<WaveExcitation>(initialStep.excitation);

  const liveCfg = $derived<LinkConfig>({
    lossDb, zVia, zConn, pcbMm, padCapFf, tcoil, txFfe, ctleOn, autoCtle, gdc, gdc2, ffePostTaps, rxNoiseMv, xtMv, detector,
  });

  // Key excluding detector (since all detectors are solved simultaneously on the shared front end -> instant switching!)
  const solveKey = $derived(
    JSON.stringify([lossDb, zVia, zConn, pcbMm, padCapFf, tcoil, txFfe, ctleOn, autoCtle, autoCtle ? 0 : gdc, autoCtle ? 0 : gdc2, ffePostTaps, rxNoiseMv, xtMv]),
  );

  const initialCfg: LinkConfig = { ...DEFAULT_CONFIG, ...initialStep.config };
  const initialAnalysis = analyze224gLink(initialCfg);
  let analysis = $state.raw<Analysis224g>(initialAnalysis);
  let appliedKey = JSON.stringify([
    initialCfg.lossDb, initialCfg.zVia, initialCfg.zConn, initialCfg.pcbMm, initialCfg.padCapFf, initialCfg.tcoil,
    initialCfg.txFfe, initialCfg.ctleOn, initialCfg.autoCtle, initialCfg.autoCtle ? 0 : initialCfg.gdc,
    initialCfg.autoCtle ? 0 : initialCfg.gdc2, initialCfg.ffePostTaps, initialCfg.rxNoiseMv, initialCfg.xtMv,
  ]);

  $effect(() => {
    const key = solveKey;
    const snap = liveCfg;
    if (key === appliedKey) return;
    const timer = setTimeout(() => {
      appliedKey = key;
      const next = analyze224gLink(snap);
      analysis = next;
      if (snap.autoCtle && snap.ctleOn) {
        gdc = next.gdc;
        gdc2 = next.gdc2;
      }
    }, 55);
    return () => clearTimeout(timer);
  });

  function applyStep(idx: number) {
    stepIdx = idx;
    const s: GuidedStep = GUIDED_STEPS[idx];
    const merged: LinkConfig = { ...DEFAULT_CONFIG, ...s.config };
    lossDb = merged.lossDb;
    zVia = merged.zVia;
    zConn = merged.zConn;
    pcbMm = merged.pcbMm;
    padCapFf = merged.padCapFf;
    tcoil = merged.tcoil;
    txFfe = merged.txFfe;
    ctleOn = merged.ctleOn;
    autoCtle = merged.autoCtle;
    gdc = merged.gdc;
    gdc2 = merged.gdc2;
    ffePostTaps = merged.ffePostTaps;
    rxNoiseMv = merged.rxNoiseMv;
    xtMv = merged.xtMv;
    detector = merged.detector;
    excitation = s.excitation;
    // Apply immediately without waiting for debounce when clicking a guided step
    const next = analyze224gLink(merged);
    analysis = next;
    if (merged.autoCtle && merged.ctleOn) {
      gdc = next.gdc;
      gdc2 = next.gdc2;
    }
    appliedKey = JSON.stringify([
      merged.lossDb, merged.zVia, merged.zConn, merged.pcbMm, merged.padCapFf, merged.tcoil,
      merged.txFfe, merged.ctleOn, merged.autoCtle, merged.autoCtle ? 0 : gdc, merged.autoCtle ? 0 : gdc2,
      merged.ffePostTaps, merged.rxNoiseMv, merged.xtMv,
    ]);
  }

  const currentStep = $derived(GUIDED_STEPS[stepIdx]);
</script>

<main class="course reflections-course">
  <!-- Guided walkthrough banner -->
  <section class="panel tour-panel" aria-label="Guided walkthrough">
    <div class="tour-tabs" role="tablist" aria-label="Walkthrough steps">
      {#each GUIDED_STEPS as step, i (step.id)}
        <button
          type="button"
          role="tab"
          aria-selected={stepIdx === i}
          onclick={() => applyStep(i)}
        >{step.shortLabel}</button>
      {/each}
    </div>
    <div class="tour-body">
      <div>
        <h2>{currentStep.title}</h2>
        <p class="course-intro">{currentStep.body}</p>
        <p class="look-for"><strong>Try this:</strong> {currentStep.lookFor}</p>
      </div>
      <div class="tour-nav">
        <button type="button" disabled={stepIdx === 0} onclick={() => applyStep(stepIdx - 1)}>← Prev</button>
        <button type="button" class="primary" disabled={stepIdx === GUIDED_STEPS.length - 1} onclick={() => applyStep(stepIdx + 1)}>Next →</button>
      </div>
    </div>
  </section>

  <!-- Unified Controls Deck -->
  <section class="panel controls-deck" aria-label="Channel and equalizer controls">
    <div class="deck-group">
      <div class="group-title">
        <span class="label">Physical channel &amp; impedance discontinuities</span>
        <button type="button" class="mini-btn" onclick={() => { zVia = 50; zConn = 50; tcoil = true; }}>Make 50 Ω continuous</button>
      </div>
      <div class="deck-grid">
        <Range id="ref-loss" bind:value={lossDb} min={10} max={46} step={1} output={`${lossDb} dB`}>Channel loss @ 56 GHz</Range>
        <Range id="ref-via" bind:value={zVia} min={25} max={75} step={1} output={`${zVia} Ω`}>Via impedance Z<sub>via</sub></Range>
        <Range id="ref-conn" bind:value={zConn} min={25} max={80} step={1} output={`${zConn} Ω`}>Connector Z<sub>conn</sub></Range>
        <Range id="ref-pcb" bind:value={pcbMm} min={6} max={24} step={0.5} output={`${pcbMm.toFixed(1)} mm`}>Via↔Conn spacing</Range>
        <Range id="ref-cap" bind:value={padCapFf} min={0} max={240} step={10} output={`${padCapFf} fF`}>Pad + ESD cap C<sub>p</sub></Range>
        <div class="control">
          <span class="label">TX/RX bridged T-coil</span>
          <Segmented size="sm" label="Bridged T-coil matching" options={[{ value: false, label: 'Off (bare C)' }, { value: true, label: 'On (50 Ω)' }]} bind:value={tcoil} />
        </div>
      </div>
    </div>

    <div class="deck-group">
      <div class="group-title">
        <span class="label">224G equalizer stack (112 GBd PAM4)</span>
        <span class="note">Total RX FFE taps = <b class="mono">{ffePostTaps + 4}</b> (3 pre + main + {ffePostTaps} post)</span>
      </div>
      <div class="deck-grid">
        <div class="control">
          <span class="label">TX 3-tap FFE</span>
          <Segmented size="sm" label="TX 3-tap FFE" options={[{ value: false, label: 'Off (100%)' }, { value: true, label: 'On (76%)' }]} bind:value={txFfe} />
        </div>
        <div class="control">
          <span class="label">RX CTLE</span>
          <Segmented size="sm" label="RX CTLE" options={[{ value: false, label: 'Off' }, { value: true, label: 'Auto COM' }]} bind:value={ctleOn} />
        </div>
        <Range id="ref-taps" bind:value={ffePostTaps} min={8} max={40} step={2} output={`${ffePostTaps + 4} taps`}>RX FFE length</Range>
        <div class="control">
          <span class="label">Active RX detector</span>
          <Segmented
            size="sm"
            label="Active RX detector"
            options={[
              { value: 'bypass' as DetectorMode, label: 'Bypass' },
              { value: 'ffe' as DetectorMode, label: 'FFE' },
              { value: 'dfe' as DetectorMode, label: 'DFE' },
              { value: 'mlse' as DetectorMode, label: 'MLSE' },
            ]}
            bind:value={detector}
          />
        </div>
        <Range id="ref-rxn" bind:value={rxNoiseMv} min={0.2} max={2.0} step={0.1} output={`${rxNoiseMv.toFixed(1)} mV`}>RX noise</Range>
        <Range id="ref-xt" bind:value={xtMv} min={0} max={3.0} step={0.1} output={`${xtMv.toFixed(1)} mV`}>Crosstalk (ICN)</Range>
      </div>
    </div>
  </section>

  <!-- Section 1: Real-time 1D wave-splitting "rope wave" simulator -->
  <WaveLinkCanvas cfg={liveCfg} bind:excitation />

  <!-- Section 2: Frequency-domain S21 notches / S11 return loss + TDR impedance profile -->
  <ChannelSparamChart a={analysis} />

  <!-- Section 3: 224G Pulse Response Equalizer Division-of-Labor + 44-tap FFE weights -->
  <EqualizerPulseChart a={analysis} {detector} />

  <!-- Section 4: 5-Equalizer Tradeoffs, Error Budget, DFE Burst Timeline & 4-State Viterbi MLSE Trellis -->
  <EqualizerComparePanel a={analysis} bind:detector />

  <details>
    <summary>Model notes, verification &amp; related SerDes lessons</summary>
    <p>
      <strong>Physical channel (ABCD cascade).</strong> Each segment (TX pad/T-coil, 4.0 mm package, 1.6 mm via, 6–24 mm PCB cavity,
      2.4 mm connector, matched 50 Ω copper cable carrying bulk distributed loss, 6.0 mm RX stub, RX pad/T-coil) is multiplied as a
      passive 2-port ABCD matrix using causal skin-effect (∝ √(j f)) and dielectric (∝ (j f)<sup>0.9</sup>) propagation constants
      at 6.0 ps/mm. Turning bridged T-coils on replaces bare shunt pad capacitance with the constant-resistance Butterworth bridged T-coil
      (Z<sub>in</sub> ≡ 50 Ω, H(s) = 1 / (1 + ½ s R<sub>0</sub> C<sub>p</sub> + ⅛ (s R<sub>0</sub> C<sub>p</sub>)<sup>2</sup>)).
    </p>
    <p>
      <strong>Travelling-wave decomposition.</strong> The live animation solves an exact 1-D wave-splitting lattice on the same 0.1 mm (0.6 ps)
      impedance grid, algebraically separating primary forward (v<sub>0</sub><sup>+</sup>), backward reflection (v<sup>−</sup>) and secondary echo
      (v<sub>2</sub><sup>+</sup>) waves so their sum equals the unsplit wave to machine precision and matches the ABCD IFFT to &lt; 5×10<sup>−5</sup> in the lossless limit.
    </p>
    <p>
      <strong>224G equalizers &amp; MLSE.</strong> At 112 GBd PAM4 (1 UI = 8.93 ps, f<sub>N</sub> = 56 GHz), the CTLE and sampling phase are
      calibrated once on the selected FFE so Bypass, 12-tap FFE, N-tap FFE, 1-tap DFE and 4-state PAM4 Viterbi MLSE (1 + α D partial-response
      target) are compared on the exact same 8,000-symbol noisy ADC capture. <code>python/serdes_224g_reflections.py</code> reproduces every case
      and symbol-error count bit-for-bit.
    </p>
    <p>
      Related lessons: <a href="/serdes/112g-pam4-link/">112G PAM4 SerDes link (3-D)</a> ·
      <a href="/serdes/clock-and-data-recovery/">Clock and data recovery</a> ·
      <a href="/serdes/pci-express/">PCI Express</a>.
    </p>
  </details>
</main>

<style>
  .reflections-course { gap: 16px; }
  .tour-panel { display: grid; gap: 12px; background: var(--plot); }
  .tour-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .tour-tabs button { padding: 6px 10px; font-size: 12px; }
  .tour-tabs button[aria-selected='true'] { color: var(--brand); border-color: var(--brand); background: var(--brand-soft); }
  .tour-body { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 12px 20px; }
  .tour-body > div:first-child { flex: 1 1 520px; display: grid; gap: 6px; }
  .tour-body h2 { margin: 0; font-size: 17px; letter-spacing: -0.015em; }
  .look-for { margin: 0; font-size: 13px; color: var(--brand); line-height: 1.5; }
  .look-for strong { font-weight: 600; }
  .tour-nav { display: flex; gap: 8px; flex: none; }

  .controls-deck { display: grid; gap: 16px; }
  .deck-group { display: grid; gap: 10px; }
  .deck-group + .deck-group { padding-top: 14px; border-top: 1px solid var(--rule-soft); }
  .group-title { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
  .group-title b { color: var(--ink); font-weight: 550; }
  .mini-btn { padding: 4px 9px !important; font-size: 11.5px !important; }
  .deck-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 24px; align-items: end; }
  .deck-grid :global(.range) { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'label out' 'input input'; gap: 5px 8px; }
  .deck-grid :global(.range label) { grid-area: label; white-space: normal; }
  .deck-grid :global(.range output) { grid-area: out; width: auto; text-align: right; }
  .deck-grid :global(.range input) { grid-area: input; width: 100%; }
  .deck-grid .control { display: grid; gap: 6px; }

  @media (max-width: 960px) { .deck-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 600px) { .deck-grid { grid-template-columns: 1fr; } }
</style>
