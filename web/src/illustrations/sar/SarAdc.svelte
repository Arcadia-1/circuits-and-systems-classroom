<script lang="ts">
  import SpectrumChart from '../../components/chart/SpectrumChart.svelte';
  import Notes from '../../components/ui/Notes.svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import ValueField from '../../components/ui/ValueField.svelte';
  import { nf } from '../../lib/format';
  import { coherentFrequency } from '../../lib/frequency';
  import { gaussians } from '../../lib/rng';
  import { clamp } from '../../lib/scale';

  import CdacDiagram from './CdacDiagram.svelte';
  import InputRuler from './InputRuler.svelte';
  import { analyzeSpectrum, N_FFT } from '../../lib/spectrum';
  import {
    binaryWeights,
    calibrate,
    capMismatch,
    capture,
    convert,
    DEFAULT_FFT_POINTS,
    FS,
    lostInputs,
    margin,
    reconstruct,
    redundantWeights,
    TEST_BIN,
    TEST_PHASE,
    TRAIN_BIN,
    TRAIN_SAMPLES,
    type Trial,
    weightsAfterCalibration,
  } from './model';
  import ResidueChart from './ResidueChart.svelte';

  const NAMES = ['Binary', 'Redundant'];

  // defaults show a chip with a clear binary mid-scale gap while the redundant array keeps the same input reachable
  let n = $state(12);
  let vin = $state(0.499);
  let sigma = $state(0.1);
  let noiseLsb = $state(0);
  let bin = $state(TEST_BIN);
  let fftExponent = $state(Math.log2(DEFAULT_FFT_POINTS));
  let jitterPs = $state(0);
  let chip = $state(43);
  let seed = $state(1);
  let shown = $state(Infinity);
  let playing = $state(false);
  let hoverK = $state<number | null>(null);
  let hoverBin = $state<number | null>(null);

  const trainingTone = coherentFrequency(FS, (TRAIN_BIN / N_FFT) * FS, TRAIN_SAMPLES);
  const fftPoints = $derived(2 ** fftExponent);
  const testTone = $derived(coherentFrequency(FS, (bin / N_FFT) * FS, fftPoints));

  const nominals = $derived([binaryWeights(n), redundantWeights(n)]);
  // the capacitors one chip actually has
  const actuals = $derived(nominals.map((w, i) => capMismatch(w, sigma, gaussians(w.length, 1000 * chip + i))));
  // input ranges with more than one LSB of analog DAC reconstruction error
  const gaps = $derived(actuals.map((w) => lostInputs(n, w)));
  // standard normals for the test and training captures, drawn once per resolution and scaled by the noise slider
  const normals = $derived(nominals.map((w, i) => gaussians((fftPoints + TRAIN_SAMPLES) * w.length, 11 + i)));
  // one sampling clock for both converters; jitter is a sampling-instant error in sample periods
  const clock = $derived(jitterPs ? gaussians(fftPoints + TRAIN_SAMPLES, 7).map((v) => v * jitterPs * 1e-12 * FS) : null);
  // calibrate on one tone, show the spectra of another; independent of the stepped conversion
  const spectra = $derived(
    nominals.map((nominal, i) => {
      const bank = fftPoints * nominal.length, testRows = fftPoints * nominal.length, trainRows = TRAIN_SAMPLES * nominal.length;
      const scaled = noiseLsb ? normals[i].map((v) => v * noiseLsb) : null;
      const test = capture(n, actuals[i], scaled?.subarray(0, testRows) ?? null, testTone.bin, TEST_PHASE, clock?.subarray(0, fftPoints) ?? null, fftPoints);
      const train = capture(n, actuals[i], scaled?.subarray(bank, bank + trainRows) ?? null, trainingTone.bin, 0, clock?.subarray(fftPoints, fftPoints + TRAIN_SAMPLES) ?? null, TRAIN_SAMPLES);
      const calibrated = weightsAfterCalibration(train, nominal, trainingTone.bin, sigma, TRAIN_SAMPLES, TRAIN_SAMPLES);
      return [analyzeSpectrum(reconstruct(test, nominal), n), analyzeSpectrum(reconstruct(test, calibrated), n)];
    }),
  );
  const calibratedGap = $derived({
    enob: spectra[1][1].enob - spectra[0][1].enob,
    sfdr: spectra[1][1].sfdr - spectra[0][1].sfdr,
  });

  const slots = $derived(nominals[1].length);
  const at = $derived(Math.min(shown, slots));
  const x = $derived(vin * 2 ** n);
  const ideal = $derived(Math.min(2 ** n - 1, Math.max(0, Math.round(x))));
  const noise = $derived(gaussians(32, seed).map((v) => v * noiseLsb));
  const conversions = $derived(
    nominals.map((nominal, i) => {
      const trace: Trial[] = [];
      const bits = new Uint8Array(nominal.length);
      convert(x, actuals[i], noise, bits, trace);
      return { trace, code: reconstruct(bits, nominal)[0], lost: trace.findIndex((t) => !(t.lo <= x && x <= t.hi)) };
    }),
  );

  function reset() {
    playing = false;
    shown = Infinity;
  }
  function step(d: number) {
    playing = false;
    shown = clamp(at + d, 0, slots);
  }
  function play() {
    if (!playing && at >= slots) shown = 0;
    playing = !playing;
  }
  const signed = (value: number, digits: number) => `${value >= 0 ? '+' : '−'}${nf(Math.abs(value), digits)}`;
  $effect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      if (shown < slots) shown++;
      else playing = false;
    }, 520);
    return () => clearInterval(id);
  });
</script>

{#snippet header(i: number)}
  {@const nominal = nominals[i]}
  {@const c = conversions[i]}
  <div class="head col{i + 1}">
    <div class="line">
      <div class="name-f">
        <div class="name"><span class="key k{i + 1}"></span><span>{NAMES[i]} SAR</span></div>
        <div class="formula"><var>w</var><sub><var>j</var>+1</sub> <span class="op">{i ? '≈' : '='}</span> <var>w</var><sub><var>j</var></sub> <span class="op">/</span> {i ? nf(2 ** (n / nominal.length), 2) : 2}</div>
      </div>
      <span class="meta">
        {nominal.length} comparisons for {n} bits · {i ? `margin from ${margin(nominal, 0)} LSB down to 1` : 'no margin anywhere'}
        <b class:ghost={gaps[i].fraction <= 0} class="unreachable" aria-hidden={gaps[i].fraction <= 0}>{nf(gaps[i].fraction * 100, 2)}% with DAC error &gt; 1 LSB</b>
      </span>
    </div>
    <div class="line">
      <div class="readout">
        <span>code <span class="mono">{c.code}</span></span>
        <span>ideal <span class="mono">{ideal}</span></span>
        {#if c.code === ideal}<span class="chip">correct</span>{:else}<span class="chip off">off by {c.code > ideal ? '+' : '−'}{Math.abs(c.code - ideal)} LSB</span>{/if}
        {#if c.lost >= 0}<span class="chip off">outside DAC bounds at {c.lost + 1}</span>{:else}<span class="chip">within DAC bounds</span>{/if}
      </div>
    </div>
  </div>
{/snippet}

{#snippet spectrumChart(i: number, k: number)}
  {@const sp = spectra[i][k]}
  <div class="chart">
    <div class="cap">
      <span class="label">
        <span class="tag">{NAMES[i]}</span>{k ? 'After weight calibration' : 'As built'}
        {#if i === 1 && k === 1}<span class="gain">vs Binary: {signed(calibratedGap.enob, 2)} ENOB · {signed(calibratedGap.sfdr, 1)} dB SFDR</span>{/if}
      </span>
      <span>ENOB <b>{nf(sp.enob, 2)}</b> · SFDR <b>{nf(sp.sfdr, 1)} dB</b></span>
    </div>
    <SpectrumChart spectrum={sp} {n} series={i ? 2 : 1} hover={hoverBin} onhover={(b) => (hoverBin = b)} label="{NAMES[i]} SAR output spectrum, {k ? 'after weight calibration' : 'as built'}" />
  </div>
{/snippet}

<main class="page">
  <header class="top">
    <div class="pick">
      <span class="label" id="res-label">Resolution</span>
      <Segmented size="sm" mono label="Resolution in bits" options={[8, 10, 12, 14, 16].map((b) => ({ value: b, label: String(b) }))} bind:value={() => n, (b) => { n = b; reset(); }} />
      <span class="unit">bits</span>
    </div>
    <Notes>
      <p><b>Ported from ADCToolbox 0.9.1.</b> <code>models/sar.py</code>: <a href="/doc/api/models#adctoolbox.sar_convert"><code>sar_convert</code></a>, <a href="/doc/api/models#adctoolbox.sar_reconstruct"><code>sar_reconstruct</code></a>, <a href="/doc/api/models#adctoolbox.sar_apply_cap_mismatch"><code>sar_apply_cap_mismatch</code></a>. <code>calibration/</code>: <a href="/doc/api/calibration#adctoolbox.calibrate_weight_sine"><code>calibrate_weight_sine</code></a>, <a href="/doc/api/calibration#adctoolbox.scale_calibration_output"><code>scale_calibration_output</code></a>. <code>siggen/nonidealities.py</code>: <a href="/doc/api/siggen#adctoolbox.siggen.ADC_Signal_Generator.apply_jitter"><code>apply_jitter</code></a>. <code>spectrum/</code>: <a href="/doc/api/spectrum#adctoolbox.analyze_spectrum"><code>analyze_spectrum</code></a>. This page is the interactive companion to its examples <code>exp_d02</code>, <code>exp_d03</code>, <code>exp_d15</code> and <code>exp_g04</code>; <a href="https://github.com/Arcadia-1/circuits-and-systems-classroom/blob/main/web/python/sar_binary_vs_redundant.py">python/sar_binary_vs_redundant.py</a> calls <a href="https://github.com/Arcadia-1/ADCToolbox">ADCToolbox</a> itself and the numbers agree to 0.001 ENOB.</p>
      <p><b>Conversion.</b> Comparison <var>j</var> adds weight <var>w<sub>j</sub></var> to the DAC level kept so far and keeps it when the input is not lower. The code is the sum of the kept nominal weights.</p>
      <p><b>Terminating capacitor.</b> The switched capacitors add up to 2<sup><var>N</var></sup> − 1 units, so one more unit terminates the array and makes the total 2<sup><var>N</var></sup>: that is what makes one unit worth exactly one LSB. Half of it is switched to the reference, which puts every decision level half an LSB below a code level, so the converter returns the nearest code rather than the one below and its interior-range error is ±½ LSB instead of −1 … 0 LSB. The endpoints saturate. This is a behavioral decision-threshold offset, not a universal SAR switching scheme.</p>
      <p><b>Weights.</b> Both arrays are specified by the same thing, the nominal resolution <var>N</var>: they cover 2<sup><var>N</var></sup> − 1 LSB and their smallest capacitor is one unit. Binary spends one comparison per bit, <var>w<sub>j</sub></var> = 2<sup><var>N</var>−1−<var>j</var></sup>. Redundant takes the fewest comparisons <var>m</var> whose radix 2<sup><var>N</var>/<var>m</var></sup> is still at most 1.8 — 15 for 12 bits, 19 for 16 — and uses that geometric series, with each nonterminal weight limited by the available tail where the cap applies.</p>
      <p><b>What the cap buys.</b> Capping is what leaves each comparison a margin: a comparison that wrongly drops its weight is recovered while the input stays within the later weights plus one LSB, and the nominal array has at least one LSB of that margin before the final comparison. The final comparison has no later weight for recovery. It binds only at the bottom, where it ends the array 4 2 1 1 instead of 4 2 1 — the extra unit capacitor is the last LSB of redundancy, and with ideal capacitors it is the one comparison that never changes anything.</p>
      <p><b>The shaded input ranges.</b> These mark an analog DAC reconstruction error larger than one LSB, sampled on a 0.25 LSB grid. They do not measure an irrecoverable percentage: digital weights can shift reconstruction levels. What calibration cannot recover is information within an overly wide decision interval. Redundancy reduces such intervals when the remaining actual weights cover a decision error; it is not a guarantee for every mismatch or noise draw.</p>
      <p><b>Reachability bars.</b> After each decision the remaining positive weights give an outer DAC range, expanded by ±1 LSB. Being outside proves that the analog reconstruction cannot finish within that tolerance. Being inside does not prove that every level is reachable. This unipolar search mainly tolerates a wrongly rejected weight; a wrongly accepted weight cannot subsequently be subtracted.</p>
      <p><b>Capacitor mismatch.</b> Weight <var>w<sub>j</sub></var> is built from <var>w<sub>j</sub></var>/<var>w</var><sub>min</sub> unit capacitors, each with relative mismatch σ, so its relative error is σ/√units. New chip draws another set of errors.</p>
      <p><b>Comparator noise.</b> Gaussian, drawn anew for every decision. The stepped conversion uses one draw; New noise replaces it.</p>
      <p><b>Weight calibration.</b> A separate, fixed {TRAIN_SAMPLES}-sample sine record estimates each digital reconstruction weight. Those weights are then applied to the independent spectrum record selected above. At exactly zero capacitor mismatch the known nominal weights are retained: fitting them again would only learn finite-record quantisation error. A digital weight fit can correct the value of observed decisions; it cannot recreate an input interval that a non-redundant search skipped.</p>
      <p><b>Spectrum.</b> {fftPoints} conversions of a full-code-range sine, rectangular window. Its target code spans 0 through 2<sup><var>N</var></sup> − 1, using the complete available range without clipping against a nonexistent code 2<sup><var>N</var></sup>. ENOB = (SNDR − 1.76) / 6.02. The largest spur is labelled with its harmonic order when it is one.</p>
      <p><b>Sampling.</b> <var>f</var><sub>s</sub> = 100 MS/s. The calibration and spectrum tones use coherent bins, so the FFT needs no window.</p>
      <p><b>Input frequency and clock jitter.</b> Mismatch and comparator noise act on a held sample and do not care about the input frequency; the sampling instant does. Gaussian jitter σ<sub>t</sub> turns the slope of the input into a voltage error, so it alone limits the converter to SNR = −20 log₁₀(2π<var>f</var><sub>in</sub>σ<sub>t</sub>) — 6 dB per doubling of the input frequency. Applied as ADCToolbox's <code>siggen.apply_jitter</code> does, by sampling the sine at <var>t</var> + Δ<var>t</var>.</p>
    </Notes>
  </header>

  <section class="tuner" aria-label="Input voltage">
    <div class="tuner-left">
      <label class="label" for="vin-num">Input</label>
      <ValueField id="vin-num" value={vin} digits={n > 12 ? 5 : 4} unit="V" step={1 / 2 ** n} onchange={(v) => { vin = clamp(v, 0, 1); reset(); }} title="Type a voltage between 0 and 1 V, or use ↑ ↓ to step one LSB (Shift: ten)" />
      <div class="transport">
        <button type="button" onclick={() => step(-1)} disabled={at === 0} aria-label="Previous comparison">‹</button>
        <button type="button" onclick={() => step(1)} disabled={at >= slots} aria-label="Next comparison">›</button>
        <button type="button" class="play" onclick={play}>{playing ? 'Pause' : 'Play'}</button>
        <span class="mono count">{at}/{slots}</span>
        <button class:ghost={noiseLsb <= 0} aria-hidden={noiseLsb <= 0} disabled={noiseLsb <= 0} type="button" onclick={() => seed++} title="Draw a new comparator-noise sample for this conversion">New noise</button>
      </div>
    </div>
    <InputRuler {vin} {n} codeA={conversions[0].code} codeB={conversions[1].code} gaps={gaps.map((g) => g.bands)} onchange={(v) => { vin = v; reset(); }} />
  </section>

  <section class="compare">
    <div class="imp">
      <div class="imp-group">
        <span class="label group-label">Stimulus &amp; impairments</span>
        <Range id="mismatch" min={0} max={0.1} step={0.001} output="{nf(sigma * 100, 1)} %" bind:value={sigma}>Unit-cap mismatch</Range>
        <Range id="noise" min={0} max={1} step={0.05} output="{nf(noiseLsb, 2)} LSB" bind:value={noiseLsb}>Comparator noise</Range>
        <Range id="fin" min={51} max={2045} step={2} output="{nf(testTone.fin * 1e-6, 2)} MHz" bind:value={bin}>Input frequency</Range>
        <Range id="fft-points" min={10} max={14} step={1} output="{fftPoints} pts" bind:value={fftExponent}>FFT points</Range>
        <Range id="jitter" min={0} max={5} step={0.1} output="{nf(jitterPs, 1)} ps" bind:value={jitterPs}>Clock jitter</Range>
        <button type="button" onclick={() => chip++} title="Draw another set of capacitor errors">New chip</button>
      </div>
    </div>

    {@render header(0)}
    {@render header(1)}
    {#each nominals as w, i (i)}
      <div class="col{i + 1}"><CdacDiagram weights={w} trace={conversions[i].trace} shown={at} series={i ? 2 : 1} label="{NAMES[i]} capacitor DAC switch states" /></div>
    {/each}
    {#each conversions as c, i (i)}
      <div class="chart">
        <div class="cap">
          <span class="left"><span class="label"><span class="tag">{NAMES[i]}</span>Successive approximation</span><span>residue, log scale</span></span>
          <span class="keys"><i class="sw"></i>DAC bounds<i class="sw lost"></i>outside bounds<i class="sw wrong"></i>wrong bit</span>
        </div>
        <ResidueChart trace={c.trace} {x} {n} {slots} shown={at} series={i ? 2 : 1} hover={hoverK} onhover={(k) => (hoverK = k)} label="{NAMES[i]} SAR residue per comparison" />
      </div>
    {/each}
    {#each spectra as _, i (i)}
      <div class="pair">{@render spectrumChart(i, 0)}{@render spectrumChart(i, 1)}</div>
    {/each}
  </section>
</main>

<style>
  .compare { --rows: auto auto 78px minmax(0, 1fr) minmax(0, 1fr); padding-top: 10px; }
  .imp { grid-column: 1 / -1; }
  .imp-group { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 7px 22px; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 6px; }
  .imp :global(.range) { --range-width: 96px; --range-output-width: 9ch; }
  .imp .label { color: var(--ink-3); }
  .group-label { flex: 0 0 100%; }
  .meta { font-size: 12.5px; color: var(--ink-3); }
  .chip.off { color: var(--bad); box-shadow: inset 0 0 0 1px var(--bad); background: transparent; }
  .unreachable { display: inline-block; min-width: 28ch; font-weight: 500; color: var(--bad); font-variant-numeric: tabular-nums; }
  .unreachable::before { content: '· '; color: var(--ink-3); }
  .ghost { visibility: hidden; }
  .transport { display: flex; align-items: center; gap: 6px; }
  button { font: 500 13px/1 var(--sans); color: var(--ink-2); background: var(--plot); border: 1px solid var(--rule); border-radius: 7px; padding: 5px 10px; min-width: 30px; cursor: pointer; }
  button:hover:not(:disabled) { color: var(--ink); border-color: var(--ink-3); }
  button:disabled { opacity: 0.45; cursor: default; }
  .play { min-width: 58px; }
  .count { font-size: 12.5px; color: var(--ink-3); min-width: 5ch; }
  .keys { display: flex; align-items: center; gap: 5px; color: var(--ink-3); }
  .keys i { display: inline-block; margin-left: 9px; }
  .gain { margin-left: 8px; color: var(--s2); font-weight: 500; text-transform: none; letter-spacing: 0; }
  .sw { width: 8px; height: 11px; border-radius: 2px; background: var(--chip); }
  .sw.lost { background: color-mix(in srgb, var(--bad) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bad) 60%, transparent); }
  .sw.wrong { width: 9px; height: 9px; border-radius: 50%; background: transparent; box-shadow: inset 0 0 0 1.5px var(--bad); }
  .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; min-height: 0; }
  @media (max-width: 900px) {
    .pair { order: 3; grid-template-columns: minmax(0, 1fr); row-gap: 16px; }
    .head .readout { min-height: 49.5px; align-content: center; }
    .pair .cap { min-height: 39px; }
  }
</style>
