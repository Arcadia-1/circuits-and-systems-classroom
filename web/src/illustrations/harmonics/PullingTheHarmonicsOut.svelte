<script lang="ts">
  import { untrack } from 'svelte';
  import Notes from '../../components/ui/Notes.svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import CurveChart from './CurveChart.svelte';
  import { CASES, curve, read, TONE, type Case, type Reading } from './model';
  import PolarChart from './PolarChart.svelte';
  import TimeChart from './TimeChart.svelte';

  const NAMES: { value: string; label: string; what: string }[] = [
    { value: 'clean', label: 'Nothing', what: 'No curvature asked for: the harmonics the fit reports are its own floor, 120 dB down and pointing anywhere.' },
    { value: 'second', label: 'Second', what: 'A square term alone. It bends one half of the sine more than the other, and everything lands on H2.' },
    { value: 'third', label: 'Third', what: 'A cube term alone: symmetric, so it flattens both peaks the same way and lands on H3.' },
    { value: 'both', label: 'Both', what: 'The usual case. The two harmonics have their own phases, and the curve is neither even nor odd.' },
    { value: 'buried', label: 'Buried', what: 'The same curvature under twenty times the noise: the fit still finds it, and the coefficients start to wander.' },
  ];
  /** below this the slider means "none at all", the way the library takes None */
  const OFF = -121;

  let name = $state('both');
  let c = $state<Case>({ ...CASES.both });
  let harmonics = $state(5);
  let hoverTime = $state<number | null>(null);
  let hoverPolar = $state<number | null>(null);
  let hoverCurve = $state<number | null>(null);

  const what = $derived(NAMES.find((n) => n.value === name)?.what ?? '');
  const dbc = (v: number | null) => (v === null ? OFF : v);
  const set = (key: 'hd2' | 'hd3', v: number) => (c = { ...c, [key]: v <= OFF ? null : v });

  function pick(v: string) {
    name = v;
    c = { ...CASES[v] };
  }

  // a capture, a decomposition, a polynomial fit and a spectrum together take a few dozen milliseconds
  let r = $state<Reading>(read(CASES.both, 5));
  let doneFor = $state('both 5');
  const key = $derived(`${c.hd2} ${c.hd3} ${c.noise} ${harmonics}`);
  $effect(() => {
    const [now, current, orders] = [key, { ...c }, harmonics];
    const id = setTimeout(() => {
      r = read(current, orders);
      doneFor = now;
    }, untrack(() => doneFor) ? 90 : 0);
    return () => clearTimeout(id);
  });
  const stale = $derived(doneFor !== key);
  const shape = $derived(curve(r.statik, r.k2, r.k3));
  const spectrumDbc = $derived(r.spectrum.harmonics.map((bin) => r.spectrum.dbfs[bin] - r.spectrum.dbfs[r.spectrum.signal]));
</script>

<main class="page">
  <header class="top">
    <div class="pick">
      <span class="label">Fit</span>
      <Segmented size="sm" mono label="Harmonics fitted" options={[3, 5, 7].map((h) => ({ value: h, label: String(h) }))} bind:value={harmonics} />
      <span class="unit">harmonics</span>
    </div>
    <Notes>
      <p><b>Ported from ADCToolbox 0.9.1.</b> <code>aout/</code>: <a href="/doc/api/aout#adctoolbox.analyze_decomposition_time"><code>analyze_decomposition_time</code></a> and <a href="/doc/api/aout#adctoolbox.analyze_decomposition_polar"><code>analyze_decomposition_polar</code></a>, which share <code>decompose_harmonic_error</code>, and <a href="/doc/api/aout#adctoolbox.fit_static_nonlin"><code>fit_static_nonlin</code></a>; <code>siggen/nonidealities.py</code>: <a href="/doc/api/siggen#adctoolbox.siggen.ADC_Signal_Generator.apply_static_nonlinearity"><code>apply_static_nonlinearity</code></a>, <a href="/doc/api/siggen#adctoolbox.siggen.ADC_Signal_Generator.apply_static_nonlinearity_hd"><code>apply_static_nonlinearity_hd</code></a>, <a href="/doc/api/siggen#adctoolbox.siggen.ADC_Signal_Generator.apply_thermal_noise"><code>apply_thermal_noise</code></a>, <a href="/doc/api/siggen#adctoolbox.siggen.ADC_Signal_Generator.apply_quantization_noise"><code>apply_quantization_noise</code></a>; <code>fundamentals/</code>: <a href="/doc/api/fundamentals#adctoolbox.find_coherent_frequency"><code>find_coherent_frequency</code></a> and <a href="/doc/api/fundamentals#adctoolbox.fit_sine_4param"><code>fit_sine_4param</code></a>; and <a href="/doc/api/spectrum#adctoolbox.analyze_spectrum"><code>analyze_spectrum</code></a> for the third opinion. This page is the interactive companion to its examples <code>exp_a11</code>, <code>exp_a12</code>, <code>exp_a25</code> and <code>exp_a31</code>; <a href="https://github.com/Arcadia-1/circuits-and-systems-classroom/blob/main/web/python/adc_harmonics.py">python/adc_harmonics.py</a> runs <a href="https://github.com/Arcadia-1/ADCToolbox">ADCToolbox</a> on the same samples and every number here matches it.</p>
      <p><b>The setup.</b> 4096 samples at 1 GS/s of a 0.45 V sine on a 0 … 1 V range, at a coherent bin low enough that harmonics 2 … 5 all stay below Nyquist. The two sliders ask for a second and a third harmonic in dBc, and <code>apply_static_nonlinearity_hd</code> builds the Chebyshev polynomial that puts them there exactly while keeping the output fundamental at <var>A</var>: <var>k</var><sub>1</sub> = 1 − 3·10<sup>HD3/20</sup>, <var>k</var><sub>2</sub> = 2·10<sup>HD2/20</sup>/<var>A</var>, <var>k</var><sub>3</sub> = 4·10<sup>HD3/20</sup>/<var>A</var>². Nothing else is wrong with this converter except the noise you leave it.</p>
      <p><b>The decomposition</b> fits DC, the fundamental and every harmonic at once by least squares, straight against the samples. No FFT, no window, no leakage: each harmonic comes back as a pair of coefficients, and so with a size and a phase. Its phases are relative to the fundamental's, which is why they stay still as the input frequency moves, and why a harmonic that has simply been delayed looks different from one the converter made.</p>
      <p><b>What is left</b> after every harmonic is taken out is drawn under the capture. That residual is the converter's noise and nothing else — the point of the whole exercise, since it says how much of a poor SNDR is distortion you could design out and how much is noise you cannot.</p>
      <p><b>The polynomial fit</b> works the other way round: take the fitted sine as the input the converter was given, fit a cubic from that input to the output, and refer each term back through the fitted linear slope (<var>k</var><sub>i</sub> = <var>c</var><sub>i</sub> / <var>k</var><sub>1</sub><sup>i</sup>) so cubic gain on the fundamental does not bias <var>k</var><sub>2</sub> and <var>k</var><sub>3</sub>. Subtracting the fitted linear term leaves the curve drawn against the one you asked for.</p>
      <p><b>Three opinions.</b> The decomposition, the spectrum and the polynomial are three different ways of measuring the same bend, and on a clean capture they agree to a hundredth of a dB. Push the noise up and watch them part company: the FFT keeps its harmonic bins, the decomposition follows, and the polynomial coefficients are the first to wander.</p>
    </Notes>
  </header>

  <section class="controls" aria-label="The distortion asked for">
    <Segmented label="Working point" options={NAMES.map((n) => ({ value: n.value, label: n.label }))} bind:value={() => name, pick} />
    <Range id="hd2" min={OFF} max={-30} step={1} output={c.hd2 === null ? 'none' : `${nf(c.hd2, 0)} dBc`} bind:value={() => dbc(c.hd2), (v) => set('hd2', v)}>H2</Range>
    <Range id="hd3" min={OFF} max={-30} step={1} output={c.hd3 === null ? 'none' : `${nf(c.hd3, 0)} dBc`} bind:value={() => dbc(c.hd3), (v) => set('hd3', v)}>H3</Range>
    <Range id="noise" min={0} max={60} step={1} output="{nf(c.noise * 1e6, c.noise < 1e-5 ? 1 : 0)} µV" bind:value={() => Math.round(20 * Math.log10(c.noise * 1e6)), (v) => (c = { ...c, noise: 10 ** (v / 20) * 1e-6 })}>Noise</Range>
    <p class="sign">{what}</p>
  </section>

  <section class="compare" class:stale>
    <div class="chart wide">
      <div class="cap">
        <span class="left"><span class="label">The capture</span><span>two and a half cycles, and what the fit took out of them</span></span>
        <span>residual <b>{nf(r.decomposition.noiseDb, 2)} dB</b> · the spectrum's SNDR <b>{nf(r.spectrum.sndr, 2)} dB</b></span>
      </div>
      <TimeChart data={r.data} decomposition={r.decomposition} fin={TONE.fin} hover={hoverTime} onhover={(i) => (hoverTime = i)} label="A few cycles of the capture, the fitted fundamental, and the harmonics and residual under them" />
    </div>

    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">Each harmonic</span><span>size and phase, against the fundamental</span></span>
        <span>{#each r.decomposition.db.slice(1, 4) as v, i (i)}{i ? ' · ' : ''}H{i + 2} <b>{nf(v - r.decomposition.db[0], 1)}</b>{/each} dBc</span>
      </div>
      <PolarChart decomposition={r.decomposition} hover={hoverPolar} onhover={(h) => (hoverPolar = h)} label="Each harmonic as a vector, its length its size in dBc and its angle its phase" />
    </div>

    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">The bend itself</span><span>fitted, against the one asked for</span></span>
        <span>k<sub>2</sub> <b>{nf(r.statik.k2, 5)}</b> of {nf(r.k2, 5)} · k<sub>3</sub> <b>{nf(r.statik.k3, 5)}</b> of {nf(r.k3, 5)}</span>
      </div>
      <CurveChart curve={shape} hover={hoverCurve} onhover={(i) => (hoverCurve = i)} label="The fitted transfer curve against the one asked for" />
    </div>
  </section>

  <p class="agree">
    <span class="label">Three opinions on the same capture</span>
    {#each [0, 1, 2, 3] as i (i)}
      <span class="one">H{i + 2}: decomposition <b>{nf(r.decomposition.db[i + 1] - r.decomposition.db[0], 2)}</b> · spectrum <b>{nf(spectrumDbc[i], 2)}</b> dBc</span>
    {/each}
  </p>
</main>

<style>
  .page { grid-template-rows: auto auto minmax(0, 1fr) auto; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 28px; border-top: 1px solid var(--rule); padding-top: 12px; }
  .sign { margin: 0; color: var(--ink-2); font-size: 13.5px; flex: 1 1 260px; }
  .compare { --rows: minmax(0, 0.95fr) minmax(0, 1fr); }
  .compare.stale { opacity: 0.45; }
  .wide { grid-column: 1 / -1; }
  .agree { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 28px; align-items: baseline; font-size: 12.5px; color: var(--ink-2); border-top: 1px solid var(--rule); padding-top: 8px; }
  .agree b { font: 500 13.5px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
  @media (max-width: 900px) {
    .wide { grid-column: auto; }
    .sign { flex-basis: 100%; }
  }
</style>
