<script lang="ts">
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import { drawEye } from './eyes';
  import { PRE, berOf, type BudgetPart, type LinkAnalysis, type Metrics } from './model';
  import PulseChart from './PulseChart.svelte';
  import ResponseChart from './ResponseChart.svelte';
  import DecisionChart from './DecisionChart.svelte';
  import { plainPam4Eye, type EyeReadout, type EyeStream } from './streams';

  let { a, live, dsp, adapting, decisions, errors, light, eyes, measured }: {
    a: LinkAnalysis; live: Metrics; dsp: boolean; adapting: boolean; decisions: number; errors: number; light: boolean; eyes: EyeStream; measured: EyeReadout;
  } = $props();

  let tab = $state<'compare' | 'eyes' | 'plain' | 'channel'>('compare');
  let canvases: HTMLCanvasElement[] = $state([]);
  let plainCanvas: HTMLCanvasElement | undefined = $state();
  const plainEye = plainPam4Eye();
  let plainPaint: { canvas: HTMLCanvasElement; width: number; height: number; light: boolean } | null = null;

  const PARTS: { key: BudgetPart; name: string; color: string }[] = [
    { key: 'isi', name: 'ISI', color: 'var(--ink-3)' },
    { key: 'th', name: 'thermal', color: 'var(--s1)' },
    { key: 'xt', name: 'crosstalk', color: '#c2579a' },
    { key: 'adc', name: 'ADC', color: 'var(--s2)' },
    { key: 'jit', name: 'jitter', color: '#8f7cf0' },
    { key: 'tx', name: 'TX', color: '#2a9d8f' },
  ];
  const snrDb = $derived(10 * Math.log10(measured.snr));
  const padSnrDb = $derived(10 * Math.log10(measured.padSnr));
  const ber = $derived(berOf(live.snr));
  const observedBer = $derived(measured.bits ? measured.bitErrors / measured.bits : 0);
  const exponent = $derived(Math.floor(Math.log10(Math.max(observedBer, 1e-300))));
  const status = $derived(!dsp ? { s: 'warn', text: 'DSP bypassed' } : measured.bits < 512 ? { s: 'warn', text: 'Collecting samples' } : observedBer > 2.4e-4 ? { s: 'bad', text: 'Errors remain after EQ' } : measured.bitErrors ? { s: 'warn', text: 'Some errors observed' } : { s: 'good', text: 'Equalized · no errors observed' });

  /** Repaint the visible eye diagrams from the stream's density images. */
  export function draw(): void {
    if (tab === 'channel') return;
    if (tab === 'plain') {
      if (plainCanvas && (plainPaint?.canvas !== plainCanvas || plainPaint.width !== plainCanvas.width || plainPaint.height !== plainCanvas.height || plainPaint.light !== light)) {
        drawEye(plainCanvas, plainEye, { light, range: 0.6, amplitude: null, corner: '±600 mV' });
        plainPaint = { canvas: plainCanvas, width: plainCanvas.width, height: plainCanvas.height, light };
      }
      return;
    }
    if (tab === 'compare') {
      if (canvases[0]) drawEye(canvases[0], eyes.eyes[0], { light, range: a.padRange, amplitude: null, corner: `±${Math.round(a.padRange * 1000)} mV` });
      if (canvases[1]) drawEye(canvases[1], measured.samplingEye, { light, range: measured.histogram.range, amplitude: 1, corner: 'levels ±1, ±⅓' });
      return;
    }
    const styles = [
      { range: a.padRange, amplitude: null, corner: `±${Math.round(a.padRange * 1000)} mV` },
      { range: 1, amplitude: a.h[PRE], corner: '±1 FS · dashed: slicer' },
      { range: 1.6, amplitude: 1, corner: 'levels ±1, ±⅓' },
    ];
    canvases.forEach((c, i) => c && drawEye(c, eyes.eyes[i], { light, ...styles[i] }));
  }
  // Paint new snapshots in the same Svelte flush as the histogram, including while playback is paused.
  $effect(() => { draw(); });

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
    <div class="metric"><span class="label">SNR · measured</span><span class="mono big">{measured.bits ? nf(snrDb, 1) : '—'}</span><span class="unit">dB</span></div>
    <div class="metric"><span class="label">BER · observed</span>
      {#if !measured.bits}<span class="mono big">—</span>{:else if !measured.bitErrors}<span class="mono big">0</span><span class="unit">/ {measured.bits.toLocaleString('en-US')} bits</span>{:else}<span class="mono big">{(observedBer / 10 ** exponent).toFixed(1)}×10<sup>{nf(exponent, 0)}</sup></span>{/if}
    </div>
  </div>
  <div class="line">
    <span class="status" data-s={status.s}>{status.text}</span>
    {#if adapting}<span class="adapt">adapting taps…</span>{/if}
  </div>
  <Segmented size="sm" label="Scope view" options={[{ value: 'compare', label: 'Compare' }, { value: 'eyes', label: 'Stages' }, { value: 'plain', label: 'Plain PAM4' }, { value: 'channel', label: 'Channel' }]} bind:value={tab} />
  {#if tab === 'compare'}
    <figure class="eye comparison-eye"><figcaption><span class="label">Before RX EQ</span><span class="mono val">SNR {measured.bits ? nf(padSnrDb, 1) : '—'} dB</span></figcaption><canvas bind:this={canvases[0]} use:sized aria-label="PAM4 eye before receiver equalization, at the RX pad"></canvas></figure>
    <figure class="eye comparison-eye"><figcaption><span class="label">{a.dfe ? 'After FFE + DFE' : dsp ? 'After CTLE + FFE' : 'DSP bypassed'}</span><span class="mono val">SNR {measured.bits ? nf(snrDb, 1) : '—'} dB</span></figcaption><canvas bind:this={canvases[1]} use:sized aria-label="Receiver sampling eye at the slicer input, including DFE when enabled"></canvas></figure>
    <figure class="eye"><figcaption><span class="label">Eye centre · samples</span><span class="mono val">{(measured.bits / 2).toLocaleString('en-US')} samples</span></figcaption><div class="decision-chart"><DecisionChart histogram={measured.histogram} /></div></figure>
    <p class="response-note">Histogram = centre slice of the receiver eye. Both use the same {(measured.bits / 2).toLocaleString('en-US')} samples and amplitude scale.</p>
    {#if a.dfe}<p class="response-note">DFE sampling eye: clock-phase sweep with feedback decisions at each phase.</p>{/if}
  {:else if tab === 'eyes'}
    <figure class="eye"><figcaption><span class="label">RX pad</span>after the channel<span class="mono val">h₀ {Math.round(a.padH0 * 1000)} mV</span></figcaption><canvas bind:this={canvases[0]} use:sized></canvas></figure>
    <figure class="eye"><figcaption><span class="label">ADC input</span>after CTLE + VGA<span class="mono val">h₀ {a.h[PRE].toFixed(2)} FS</span></figcaption><canvas bind:this={canvases[1]} use:sized></canvas></figure>
    <figure class="eye"><figcaption><span class="label">{dsp ? 'FFE waveform' : 'ADC, normalized'}</span>{a.dfe ? 'before DFE' : dsp ? 'at slicer' : 'DSP bypassed'}</figcaption><canvas bind:this={canvases[2]} use:sized></canvas></figure>
    <p class="response-note">Continuous waveforms, overlaid in 2-UI windows.</p>
  {:else if tab === 'plain'}
    <figure class="eye plain-eye"><figcaption><span class="label">PAM4 · TX reference</span><span class="mono val">56 GBd · 1 Vppd</span></figcaption><canvas bind:this={plainCanvas} use:sized aria-label="Plain PAM4 eye: 2 UI of the transmitter waveform, with four voltage levels and three eye openings"></canvas></figure>
    <p class="response-note">2-UI cuts from one waveform, directly overlaid. Four levels: −500, −167, +167, +500 mV.</p>
    <p class="response-note">TX driver only (two 50 GHz poles). No channel, equalizers or added noise. This reference is independent of the link settings.</p>
  {:else}
    <span class="label">Model error budget{a.dfe ? ' · correct feedback' : ''}</span>
    <div class="budget" role="img" aria-label="Model error budget, assuming correct DFE feedback">
      {#each PARTS as p (p.key)}<span style:width="{(100 * live.parts[p.key]) / live.total}%" style:background={p.color}></span>{/each}
    </div>
    <ul class="bkey">
      {#each PARTS as p (p.key)}<li><i style:background={p.color}></i>{p.name} <b class="mono">{Math.round((100 * live.parts[p.key]) / live.total)}%</b></li>{/each}
    </ul>
    <div class="chart">
      <div class="cap"><span class="label">Frequency response</span><span><i class="k0"></i>channel <i class="k2"></i>CTLE <i class="k1"></i>TX → ADC</span></div>
      <ResponseChart {a} />
    </div>
    <p class="response-note">TX → ADC includes TX FFE, driver, channel, CTLE and VGA.</p>
    <div class="chart">
      <div class="cap"><span class="label">Pulse response</span><span>at the ADC, cursors marked</span></div>
      <PulseChart {a} />
    </div>
    <dl class="kv">
      <dt>Model SNR{a.dfe ? ' · correct feedback' : ''}</dt><dd class="mono">{nf(10 * Math.log10(live.snr), 1)} dB</dd>
      <dt>Gaussian BER estimate</dt><dd class="mono">{ber.toExponential(2)}</dd>
      <dt>Observed errors / bits</dt><dd class="mono">{measured.bitErrors} / {measured.bits.toLocaleString('en-US')}</dd>
      <dt>CTLE g<sub>DC</sub> / g<sub>DC2</sub></dt><dd class="mono">{nf(a.gdc, 0)} / {nf(a.gdc2, 0)} dB</dd>
      <dt>CTLE boost, 28 GHz vs DC</dt><dd class="mono">{nf(a.ctleBoostDb, 1)} dB</dd>
      <dt>VGA gain</dt><dd class="mono">{nf(20 * Math.log10(a.vga), 1)} dB</dd>
      <dt>Sampling phase</dt><dd class="mono">{nf(a.phaseUi, 2)} UI from peak</dd>
      <dt>Channel loss at 28 GHz</dt><dd class="mono">{nf(a.channelLossDb, 1)} dB</dd>
      <dt>Echo at +1 UI</dt><dd class="mono">{Math.round(a.echo * 100)}% of direct path</dd>
      <dt>DFE tap b₁</dt><dd class="mono">{a.dfe ? nf(live.b1, 3) : 'off'}</dd>
      <dt>Slow-motion decisions</dt><dd class="mono">{decisions.toLocaleString('en-US')} · {errors} errors</dd>
    </dl>
    <div class="about">
      <span class="label">Model</span>
      <p><b>Channel.</b> The distributed loss at 28 GHz is split 35% skin effect, exp(−a√(jf/f<sub>N</sub>)), and 65% dielectric, exp(−b(jf/f<sub>N</sub>)<sup>0.9</sup>), with f<sub>N</sub> = 28 GHz. One small echo adds ripple (ρ₁ρ₂ = 0.02, 9 UI). The adjustable one-UI echo is a two-path teaching model: H<sub>echo</sub>(f) = (1 + r exp(−j2πf·UI))/(1 + r). It has unity DC gain and adds a Nyquist notch; total channel loss includes it. The TX driver has two poles at 50 GHz, the RX front end one at 45 GHz.</p>
      <p><b>Receiver.</b> The CTLE uses the IEEE 802.3ck COM reference form; Auto searches g<sub>DC</sub> 0 … −20 dB and g<sub>DC2</sub> ∈ {'{'}0, −3, −6{'}'} dB with the sampling phase for the best SNR. A VGA sets the rms to 0.3 FS. The 12-tap MMSE FFE cancels ISI on its own by default. FFE + DFE jointly optimizes it with one feedback tap, leaving the first postcursor for DFE to cancel.</p>
      <p>With “Same CTLE &amp; clock”, the front end is calibrated for the best FFE and reused across DSP modes. Channel buttons change only distributed loss and echo strength. Noise and TX/RX settings stay at their selected values.</p>
      <p><b>Noise and BER.</b> The model uses RX noise, crosstalk, ADC noise (0.010 FS rms), TX distortion (28 dB SNDR), and a 0.2 ps rms jitter budget. For Gray-coded PAM4, BER ≈ (3/4) Q(√(10<sup>SNR<sub>dB</sub>/10</sup>/5)) assumes Gaussian errors and correct past DFE decisions. The measured readouts use the last 4,096 eye-stream symbols and include DFE error propagation. SNR = signal power / mean squared error against the transmitted levels. No observed errors in this finite window is not proof of zero BER.</p>
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
  .plain-eye canvas { height: 240px; }
  .comparison-eye canvas { height: 148px; }
  .decision-chart { display: flex; height: 124px; border-radius: 6px; background: var(--plot); box-shadow: inset 0 0 0 1px var(--rule); }
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
