<script lang="ts">
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import { drawEye } from './eyes';
  import { PRE, berOf, type BudgetPart, type LinkAnalysis, type Metrics } from './model';
  import PulseChart from './PulseChart.svelte';
  import ResponseChart from './ResponseChart.svelte';
  import type { EyeStream } from './streams';

  let { a, live, dsp, adapting, decisions, errors, light, eyes }: {
    a: LinkAnalysis; live: Metrics; dsp: boolean; adapting: boolean; decisions: number; errors: number; light: boolean; eyes: EyeStream;
  } = $props();

  let tab = $state<'eyes' | 'channel'>('eyes');
  let canvases: HTMLCanvasElement[] = $state([]);

  const PARTS: { key: BudgetPart; name: string; color: string }[] = [
    { key: 'isi', name: 'ISI', color: 'var(--ink-3)' },
    { key: 'th', name: 'thermal', color: 'var(--s1)' },
    { key: 'xt', name: 'crosstalk', color: '#c2579a' },
    { key: 'adc', name: 'ADC', color: 'var(--s2)' },
    { key: 'jit', name: 'jitter', color: '#8f7cf0' },
    { key: 'tx', name: 'TX', color: '#2a9d8f' },
  ];
  const snrDb = $derived(10 * Math.log10(live.snr));
  const ber = $derived(berOf(live.snr));
  const exponent = $derived(Math.floor(Math.log10(Math.max(ber, 1e-300))));
  const status = $derived(ber < 1e-5 ? { s: 'good', text: 'Link healthy' } : ber <= 2.4e-4 ? { s: 'warn', text: 'Marginal · FEC carrying it' } : { s: 'bad', text: 'Beyond KP4 FEC limit' });

  /** True while the eye diagrams are on screen, so the caller only feeds them then. */
  export function showsEyes(): boolean {
    return tab === 'eyes' && !!canvases[0]?.clientWidth;
  }
  /** Repaint the three eye diagrams from the stream's density images. */
  export function draw(): void {
    const styles = [
      { range: a.padRange, amplitude: null, corner: `±${Math.round(a.padRange * 1000)} mV` },
      { range: 1, amplitude: a.h[PRE], corner: '±1 FS · dashed: slicer' },
      { range: 1.6, amplitude: 1, corner: 'levels ±1, ±⅓' },
    ];
    canvases.forEach((c, i) => c && drawEye(c, eyes.eyes[i], { light, ...styles[i] }));
  }
  function sized(node: HTMLCanvasElement) {
    const ro = new ResizeObserver(() => {
      const d = Math.min(devicePixelRatio, 2);
      node.width = Math.round(node.clientWidth * d);
      node.height = Math.round(node.clientHeight * d);
    });
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }
</script>

<aside class="scope" aria-label="Receiver measurements">
  <div class="numbers">
    <div class="metric"><span class="label">DSP SNR</span><span class="mono big">{nf(snrDb, 1)}</span><span class="unit">dB</span></div>
    <div class="metric"><span class="label">BER · estimate</span>
      {#if ber < 1e-15}<span class="mono big">&lt;10<sup>−15</sup></span>{:else}<span class="mono big">{(ber / 10 ** exponent).toFixed(1)}×10<sup>{nf(exponent, 0)}</sup></span>{/if}
    </div>
  </div>
  <div class="line">
    <span class="status" data-s={status.s}>{status.text}</span>
    {#if adapting}<span class="adapt">adapting taps…</span>{/if}
  </div>
  <div class="budget" role="img" aria-label="Error budget at the slicer">
    {#each PARTS as p (p.key)}<span style:width="{(100 * live.parts[p.key]) / live.total}%" style:background={p.color}></span>{/each}
  </div>
  <ul class="bkey">
    {#each PARTS as p (p.key)}<li><i style:background={p.color}></i>{p.name} <b class="mono">{Math.round((100 * live.parts[p.key]) / live.total)}%</b></li>{/each}
  </ul>
  <Segmented size="sm" label="Scope view" options={[{ value: 'eyes', label: 'Eye diagrams' }, { value: 'channel', label: 'Channel' }]} bind:value={tab} />
  {#if tab === 'eyes'}
    <figure class="eye"><figcaption><span class="label">RX pad</span>after the channel<span class="mono val">h₀ {Math.round(a.padH0 * 1000)} mV</span></figcaption><canvas bind:this={canvases[0]} use:sized></canvas></figure>
    <figure class="eye"><figcaption><span class="label">ADC input</span>after CTLE + VGA<span class="mono val">h₀ {a.h[PRE].toFixed(2)} FS</span></figcaption><canvas bind:this={canvases[1]} use:sized></canvas></figure>
    <figure class="eye"><figcaption><span class="label">DSP output</span>{dsp ? 'FFE + DFE' : 'bypassed'}<span class="mono val">SNR {nf(snrDb, 1)} dB</span></figcaption><canvas bind:this={canvases[2]} use:sized></canvas></figure>
  {:else}
    <div class="chart">
      <div class="cap"><span class="label">Frequency response</span><span><i class="k0"></i>channel <i class="k2"></i>CTLE <i class="k1"></i>TX → ADC</span></div>
      <ResponseChart {a} />
    </div>
    <p class="response-note">TX → ADC includes TX FFE, driver, channel, CTLE and VGA.</p>
    <div class="chart">
      <div class="cap"><span class="label">Pulse response</span><span>at the ADC, cursors marked</span></div>
      <PulseChart {a} {dsp} />
    </div>
    <dl class="kv">
      <dt>CTLE g<sub>DC</sub> / g<sub>DC2</sub></dt><dd class="mono">{nf(a.gdc, 0)} / {nf(a.gdc2, 0)} dB</dd>
      <dt>CTLE boost, 28 GHz vs DC</dt><dd class="mono">{nf(a.ctleBoostDb, 1)} dB</dd>
      <dt>VGA gain</dt><dd class="mono">{nf(20 * Math.log10(a.vga), 1)} dB</dd>
      <dt>Sampling phase</dt><dd class="mono">{nf(a.phaseUi, 2)} UI from peak</dd>
      <dt>DFE tap b₁</dt><dd class="mono">{dsp ? nf(live.b1, 3) : 'off'}</dd>
      <dt>Slow-motion decisions</dt><dd class="mono">{decisions.toLocaleString('en-US')} · {errors} errors</dd>
    </dl>
    <div class="about">
      <span class="label">Model</span>
      <p><b>Channel.</b> The distributed loss at 28 GHz is split 35% skin effect, exp(−a√(jf/f<sub>N</sub>)), and 65% dielectric, exp(−b(jf/f<sub>N</sub>)<sup>0.9</sup>), with f<sub>N</sub> = 28 GHz. One echo adds a small ripple (ρ₁ρ₂ = 0.02, 9 UI). The TX driver has two poles at 50 GHz, the RX front end one at 45 GHz.</p>
      <p><b>Receiver.</b> The CTLE uses the IEEE 802.3ck COM reference form; Auto searches g<sub>DC</sub> 0 … −20 dB and g<sub>DC2</sub> ∈ {'{'}0, −3, −6{'}'} dB with the sampling phase for the best SNR. A VGA sets the rms to 0.3 FS. The 12-tap FFE and 1-tap DFE are the MMSE solution, which the running taps approach after every change.</p>
      <p><b>Noise and BER.</b> RX noise is white at the pad, crosstalk band-pass, both shaped by the CTLE; the ADC adds 0.010 FS rms, the TX has 28 dB SNDR, random jitter is 0.2 ps rms. For Gray-coded PAM4, BER ≈ (3/4) Q(√(10<sup>SNR<sub>dB</sub>/10</sup>/5)). This Gaussian estimate assumes independent errors; 2.4×10⁻⁴ is a common KP4 FEC reference, not a guarantee for burst errors.</p>
      <p><b>Scale.</b> The animation runs about 7×10⁹ times slower than the link and is not to scale: a 30 cm trace holds about 110 symbols, 44 are drawn. <code>python/serdes_112g_link.py</code> is the NumPy reference the tests compare against.</p>
    </div>
  {/if}
</aside>

<style>
  .scope { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
  .numbers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .metric { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 5px; }
  .metric .label { width: 100%; }
  .big { font-size: 24px; letter-spacing: -0.02em; color: var(--ink); }
  .big sup { font-size: 0.55em; }
  .unit { font-size: 12.5px; color: var(--ink-2); }
  .line { display: flex; align-items: center; gap: 10px; min-height: 26px; }
  .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; padding: 3px 10px; border-radius: 999px; box-shadow: inset 0 0 0 1px currentColor; }
  .status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .status[data-s='good'] { color: var(--brand); }
  .status[data-s='warn'] { color: var(--s2); }
  .status[data-s='bad'] { color: var(--bad); }
  .adapt { font: 11.5px var(--mono); color: var(--ink-2); }
  .budget { display: flex; height: 7px; border-radius: 4px; overflow: hidden; background: var(--chip); }
  .budget span { display: block; height: 100%; transition: width 0.35s ease; }
  .bkey { display: flex; flex-wrap: wrap; gap: 3px 12px; margin: 0; padding: 0; list-style: none; font-size: 11.5px; color: var(--ink-2); }
  .bkey i, .cap i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .bkey b { font-weight: 500; color: var(--ink); }
  .eye { margin: 0; display: grid; gap: 4px; }
  figcaption { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; color: var(--ink-3); }
  figcaption .val { margin-left: auto; font-size: 11.5px; color: var(--ink-2); white-space: nowrap; }
  canvas { display: block; width: 100%; height: 104px; border-radius: 6px; background: var(--plot); box-shadow: inset 0 0 0 1px var(--rule); }
  .chart { display: flex; flex-direction: column; gap: 2px; height: 170px; }
  .cap { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 10px; font-size: 12px; color: var(--ink-2); }
  .cap i { width: 10px; height: 2px; margin: 0 5px 3px 8px; vertical-align: middle; }
  .k0 { background: var(--ink-3); }
  .k1 { background: var(--s1); }
  .k2 { background: var(--s2); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 4px 0 0; font-size: 12.5px; }
  .kv dt { color: var(--ink-2); }
  .kv dd { margin: 0; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
  .about { display: grid; gap: 6px; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--rule); font-size: 12px; line-height: 1.55; color: var(--ink-2); }
  .about p { margin: 0; }
  .response-note { margin: 0; color: var(--ink-3); font-size: 11.5px; line-height: 1.5; }
  .about b { color: var(--ink); font-weight: 500; }
  .about code { font: 11px var(--mono); color: var(--ink); background: var(--chip); padding: 0 4px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) { .budget span { transition: none; } }
  @media (max-width: 900px) { .scope { overflow: visible; } }
</style>
