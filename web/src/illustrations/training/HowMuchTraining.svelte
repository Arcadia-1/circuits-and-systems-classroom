<script lang="ts">
  import SpectrumChart from '../../components/chart/SpectrumChart.svelte';
  import Notes from '../../components/ui/Notes.svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import { ARRAYS, LENGTHS, N_TEST, read, SIGMA, sweepStream, TRIALS, uncalibrated, type ArrayName, type Band } from './model';
  import TrainingChart from './TrainingChart.svelte';
  import WeightsChart from './WeightsChart.svelte';

  const NAMES: { value: ArrayName; label: string; what: string }[] = [
    { value: 'redundant', label: 'Redundant', what: 'Eighteen weights at a radix near 1.8 for sixteen bits of span: every level can be reached more than one way, and the calibration has room to move.' },
    { value: 'binary', label: 'Strict binary', what: 'Sixteen weights, each half the last. Nothing is spare, so a short training capture can fit itself perfectly and still be wrong everywhere else.' },
  ];

  let name = $state<ArrayName>('binary');
  let index = $state(LENGTHS.indexOf(32));
  let sigma = $state(SIGMA);
  let chip = $state(0);
  let hoverSweep = $state<number | null>(null);
  let hoverBin = $state<number | null>(null);
  let hoverWeight = $state<number | null>(null);

  const n = $derived(LENGTHS[index]);
  const what = $derived(NAMES.find((x) => x.value === name)!.what);
  const r = $derived(read(name, chip, n, sigma));
  const raw = $derived(uncalibrated(name, sigma));

  // eighty calibrations and twice as many spectra: run them a few milliseconds at a time
  let rows = $state<Band[]>([]);
  let running = $state(true);
  $effect(() => {
    const steps = sweepStream(name, sigma, TRIALS);
    const found: Band[] = [];
    let id: ReturnType<typeof setTimeout> | undefined;
    running = true;
    const step = () => {
      const until = performance.now() + 10;
      while (performance.now() < until) {
        const next = steps.next();
        if (next.done) {
          rows = found;
          running = false;
          return;
        }
        if (next.value) {
          found.push(next.value);
          rows = [...found];
        }
      }
      id = setTimeout(step, 0);
    };
    step();
    return () => clearTimeout(id);
  });
</script>

<main class="page">
  <header class="top">
    <div class="pick">
      <Segmented size="sm" label="Capacitor array" options={NAMES.map((x) => ({ value: x.value, label: x.label }))} bind:value={name} />
    </div>
    <Notes>
      <p><b>Ported from ADCToolbox 0.9.1.</b> <code>models/sar.py</code>: <a href="/doc/api/models#adctoolbox.sar_apply_cap_mismatch"><code>sar_apply_cap_mismatch</code></a>, <a href="/doc/api/models#adctoolbox.sar_convert"><code>sar_convert</code></a>, <a href="/doc/api/models#adctoolbox.sar_reconstruct"><code>sar_reconstruct</code></a>; <code>calibration/</code>: <a href="/doc/api/calibration#adctoolbox.calibrate_weight_sine"><code>calibrate_weight_sine</code></a>; <code>spectrum/</code>: <a href="/doc/api/spectrum#adctoolbox.quick_sndr"><code>quick_sndr</code></a> and <a href="/doc/api/spectrum#adctoolbox.analyze_spectrum"><code>analyze_spectrum</code></a>. This page is the interactive companion to its examples <code>exp_d18</code>, <code>exp_d16</code> and <code>exp_d01</code>; <a href="https://github.com/Arcadia-1/circuits-and-systems-classroom/blob/main/web/python/adc_training_length.py">python/adc_training_length.py</a> runs <a href="https://github.com/Arcadia-1/ADCToolbox">ADCToolbox</a> on the same chips and every number here matches it.</p>
      <p><b>The setup</b> is <code>exp_d18</code>'s. Eight chips of the same design, each with its own capacitor mismatch: a capacitor built from <var>n</var> units carries σ/√<var>n</var> of relative error, so the big MSB capacitors come out closest to size and the small ones worst. Each chip is calibrated from a short coherent capture of its own, and the weights that fall out are then used to read a {N_TEST}-sample capture at a different frequency and phase, which they have never seen.</p>
      <p><b>The gap between the two lines is the whole lesson.</b> The dashed line is what the calibrated weights say about the very capture they were solved from — always flattering, sometimes absurd: with strict binary weights and thirty-two samples, one of these chips reads thirty-three bits on its own training data. The solid line is the same weights on an unseen capture, and at that length it is worse than no calibration at all. Somewhere above a hundred samples the two lines meet, and that is the number you were looking for.</p>
      <p><b>Redundancy is what makes a calibration teachable.</b> A strict binary array has exactly one way to reach each level, so a short capture visits few enough patterns that the fit can solve them all exactly and learn nothing general. The radix-1.8 array reaches most levels several ways, the bit patterns spread out, and the fit has to explain them all — which is the same reason redundancy helps the converter settle in the first place.</p>
      <p><b>The array itself</b> is drawn on the right: the bar is how each capacitor came out, the dot is what the calibration decided it was. Watch them agree bit by bit as the training record grows, and watch the smallest capacitors — the ones with the most relative error and the least influence on the output — be the last to be learnt.</p>
    </Notes>
  </header>

  <section class="controls" aria-label="The chip and its training">
    <Range id="n" min={0} max={LENGTHS.length - 1} step={1} output="{n} samples" bind:value={index}>Training</Range>
    <Range id="sigma" min={2} max={30} step={1} output="{nf(sigma * 100, 1)} %" bind:value={() => Math.round(sigma * 1000), (v) => (sigma = v / 1000)}>Unit cap σ</Range>
    <Range id="chip" min={0} max={TRIALS - 1} step={1} output="#{chip + 1}" bind:value={chip}>Chip</Range>
    <p class="sign">{what}</p>
  </section>

  <section class="compare">
    <div class="chart wide">
      <div class="cap">
        <span class="left"><span class="label">What training buys</span><span>{TRIALS} chips at each length, worst to best</span></span>
        <span>
          <span class="key k1"></span>a capture it has never seen · <span class="key k2"></span>its own training capture
          {#if running}· still solving{/if}
        </span>
      </div>
      <TrainingChart {rows} at={n} raw={raw} hover={hoverSweep} onhover={(i) => (hoverSweep = i)} label="Calibrated ENOB against training length, on an unseen capture and on the training capture itself" />
    </div>

    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">Chip #{chip + 1}, after {n} samples</span><span>the unseen capture, before in grey</span></span>
        <span>ENOB <b>{nf(r.after.enob, 2)}</b> from {nf(r.before.enob, 2)} · SFDR <b>{nf(r.after.sfdr, 1)}</b> from {nf(r.before.sfdr, 1)} dB</span>
      </div>
      <SpectrumChart spectrum={r.after} behind={r.before} n={16} series={1} hover={hoverBin} onhover={(b) => (hoverBin = b)} label="The unseen capture read with the calibrated weights, over the same capture read with the nominal ones" />
    </div>

    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">The array</span><span>bars as built, dots as calibrated</span></span>
        <span>{ARRAYS[name].length} weights · worst bar <b>{nf(Math.max(...r.built.map((v) => Math.abs(v - 1))) * 100, 2)} %</b></span>
      </div>
      <WeightsChart built={r.built} recovered={r.recovered} hover={hoverWeight} onhover={(j) => (hoverWeight = j)} label="Each capacitor as built and as the calibration recovered it" />
    </div>
  </section>
</main>

<style>
  .page { grid-template-rows: auto auto minmax(0, 1fr); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 28px; border-top: 1px solid var(--rule); padding-top: 12px; }
  .sign { margin: 0; color: var(--ink-2); font-size: 13.5px; flex: 1 1 320px; }
  .compare { --rows: minmax(0, 0.95fr) minmax(0, 1fr); }
  .wide { grid-column: 1 / -1; }
  @media (max-width: 900px) {
    .wide { grid-column: auto; }
    .sign { flex-basis: 100%; }
  }
</style>
