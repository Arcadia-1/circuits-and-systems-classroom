<script lang="ts">
  import { untrack } from 'svelte';
  import Notes from '../../components/ui/Notes.svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { freqText, nf } from '../../lib/format';
  import ActivityChart from './ActivityChart.svelte';
  import EnobChart from './EnobChart.svelte';
  import { ARRAYS, enobSweep, N, nominalWeights, read, TONE, type ArrayName, type Fault } from './model';
  import SegmentChart from './SegmentChart.svelte';
  import WeightChart from './WeightChart.svelte';

  const NAMES: { value: ArrayName; label: string }[] = [
    { value: 'binary', label: 'Binary 12' },
    { value: 'redundant', label: 'Redundant 13' },
    { value: 'subradix', label: 'Sub-radix 14' },
  ];
  const FAULTS: { value: Fault; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'contact', label: 'Poor contact' },
    { value: 'lsb', label: 'Random LSB' },
  ];

  // exp_d11's converter and tone, a little below full scale, with exp_d12's noise
  let array = $state<ArrayName>('binary');
  let amplitude = $state(98);
  let offset = $state(0);
  let noise = $state(200);
  let fault = $state<Fault>('none');
  let hoverActivity = $state<number | null>(null);
  let hoverSegment = $state<number | null>(null);
  let hoverWeight = $state<number | null>(null);
  let hoverEnob = $state<number | null>(null);

  const r = $derived(read(array, amplitude / 200, offset / 100, noise * 1e-6, fault, false));
  const m = $derived(r.caps.length);
  const worst = $derived(r.activity.reduce((b, v, j) => (Math.abs(v - 50) > Math.abs(r.activity[b] - 50) ? j : b), 0));
  const clipped = $derived(r.overflow.atZero[0] + r.overflow.atOne[0]);

  // the sweep is most of the work: run it once the controls rest, and show the last one faded meanwhile
  let sweep = $state.raw<number[] | null>(null);
  let sweptFor = $state.raw<object | null>(null);
  $effect(() => {
    const reading = r;
    const id = setTimeout(() => {
      sweep = enobSweep(reading.bits, reading.caps.length, reading.weights);
      sweptFor = reading;
    }, untrack(() => sweep) ? 90 : 0);
    return () => clearTimeout(id);
  });
</script>

<main class="page">
  <header class="top">
    <div class="pick">
      <span class="label">Array</span>
      <Segmented size="sm" label="Capacitor array" options={NAMES} bind:value={array} />
    </div>
    <Notes>
      <p><b>Ported from ADCToolbox 0.9.1.</b> <code>dout/</code>: <a href="/doc/api/dout#adctoolbox.analyze_bit_activity"><code>analyze_bit_activity</code></a>, <a href="/doc/api/dout#adctoolbox.analyze_overflow"><code>analyze_overflow</code></a>, <a href="/doc/api/dout#adctoolbox.analyze_weight_radix"><code>analyze_weight_radix</code></a>, <a href="/doc/api/dout#adctoolbox.analyze_enob_sweep"><code>analyze_enob_sweep</code></a>. <code>calibration/</code>: <a href="/doc/api/calibration#adctoolbox.calibrate_weight_sine"><code>calibrate_weight_sine</code></a>. <code>spectrum/</code>: <a href="/doc/api/spectrum#adctoolbox.analyze_spectrum"><code>analyze_spectrum</code></a>. This page is the interactive companion to its examples <code>exp_d11</code>, <code>exp_d12</code>, <code>exp_d13</code> and <code>exp_d14</code>; <a href="https://github.com/Arcadia-1/circuits-and-systems-classroom/blob/main/web/python/adc_reading_the_bits.py">python/adc_reading_the_bits.py</a> runs <a href="https://github.com/Arcadia-1/ADCToolbox">ADCToolbox</a> on the same bits and every number here matches it.</p>
      <p><b>The converter.</b> The examples' SAR loop: each comparison asks whether what is left of the input is above zero, and its capacitor's share of the range is taken off or put back. The binary array is <code>exp_d11</code>'s, 1024 down to 2, 1, 1; the redundant one repeats the 256, as in <code>exp_d14</code>; the sub-radix one steps down by about 1.8, as in <code>exp_d13</code>. The last comparison moves nothing, so the last weight comes out half the one before it.</p>
      <p><b>Bit activity.</b> A full-scale sine around mid-scale sets every bit half the time. An offset tilts that, most in the middle bits, where the code spends its time near the offset. A bit that sometimes reads 0 when it should read 1, <code>exp_d11</code>'s poor contact on the second-last bit, sits below 50 on its own.</p>
      <p><b>Where each segment sits.</b> <code>analyze_overflow</code> takes the bits from one bit down to the LSB, weights them, and divides by their weights' total: a number from 0 to 1 for every sample. A redundant comparison keeps its segment away from both ends, and the gap is its margin. The orange figures are the percent of samples on 0 and on 1: at the top bit that is the input clipping, while at the LSB it is half the samples each way, since one bit is always at an end.</p>
      <p><b>The weights.</b> <code>calibrate_weight_sine</code> finds the weights that make the bits add up to a sine. From a good capture they are the capacitors, in units of the tone, and their ratios are the array's radix, which <code>analyze_weight_radix</code> reads along with the resolution the weights span. A clipped sine is not a sine: the fit bends the weights to explain the flat tops, and the ratios drift from the capacitors'.</p>
      <p><b>ENOB against bits.</b> <code>analyze_enob_sweep</code> calibrates once with every bit, then keeps only the first one, two, three of them. Each bit should add about one effective bit until the noise has the rest; one that adds nothing is noise itself, like the random LSB of <code>exp_d12</code>, or broken. The dashed line is all the bits with the capacitors as weights.</p>
      <p><b>The record.</b> {N} samples at 1 GS/s and a {freqText(TONE.fin)} tone, bin {TONE.bin}, on a ±1 range. The noise is added before the SAR loop and the faults after it. Every ENOB here comes from <code>analyze_spectrum</code> with the Hamming window and the side bins it detects by itself, as <code>analyze_enob_sweep</code> leaves them.</p>
    </Notes>
  </header>

  <section class="controls" aria-label="The input and the faults">
    <div class="group">
      <span class="label">Input</span>
      <Range id="amplitude" min={90} max={110} step={0.5} output="{nf(amplitude, 1)} %" bind:value={amplitude}>Amplitude</Range>
      <Range id="offset" min={-2} max={2} step={0.05} output="{offset > 0 ? '+' : ''}{nf(offset, 2)} %" bind:value={offset}>Offset</Range>
      <Range id="noise" min={0} max={1000} step={10} output="{noise} µV" bind:value={noise}>Noise</Range>
    </div>
    <div class="group accent2">
      <span class="label">Fault</span>
      <Segmented size="sm" label="Fault in the bits" options={FAULTS} bind:value={fault} />
    </div>
  </section>

  <section class="compare">
    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">Bit activity</span><span>bit 1 is the MSB</span></span>
        <span>furthest from 50: <b>bit {worst + 1}, {r.activity[worst] >= 50 ? '+' : ''}{nf(r.activity[worst] - 50, 2)} %</b></span>
      </div>
      <ActivityChart activity={r.activity} hover={hoverActivity} onhover={(j) => (hoverActivity = j)} label="Share of samples with each bit at 1" />
    </div>

    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">Where each segment sits</span><span>bits j … {m} as a share of their weight</span></span>
        <span>clipped <b>{nf(clipped, 2)} %</b> of samples</span>
      </div>
      <SegmentChart overflow={r.overflow} hover={hoverSegment} onhover={(j) => (hoverSegment = j)} label="Distribution of each segment of the code between 0 and 1" />
    </div>

    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">Calibrated weights</span><span>rings: the capacitors</span></span>
        <span>spans <b>{nf(r.radix.effres, 2)} bits</b> · capacitors {nf(r.nominal.effres, 2)}</span>
      </div>
      <WeightChart weights={r.weights} nominal={nominalWeights(ARRAYS[array])} radix={r.radix} nominalRadix={r.nominal} hover={hoverWeight} onhover={(j) => (hoverWeight = j)} label="Calibrated bit weights on a log scale with their ratios" />
    </div>

    <div class="chart">
      <div class="cap">
        <span class="left"><span class="label">ENOB against bits used</span><span>dashed: capacitors as weights</span></span>
        {#if sweep}<span>calibrated <b>{nf(sweep[sweep.length - 1], 2)}</b> · capacitors <b>{nf(r.uncalibrated, 2)}</b></span>{/if}
      </div>
      {#if sweep && sweep.length === m}
        <EnobChart {sweep} uncalibrated={r.uncalibrated} stale={sweptFor !== r} hover={hoverEnob} onhover={(j) => (hoverEnob = j)} label="ENOB against the number of bits used" />
      {:else}
        <div class="wait">calibrating…</div>
      {/if}
    </div>
  </section>
</main>

<style>
  .controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 30px; border-top: 1px solid var(--rule); padding-top: 10px; }
  .group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; }
  .group .label { color: var(--ink-3); }
  .controls :global(.range) { --range-width: 120px; }
  .wait { flex: 1 1 auto; display: grid; place-items: center; color: var(--ink-3); font-size: 13px; }
  .compare { --rows: minmax(0, 1fr) minmax(0, 1fr); }
</style>
