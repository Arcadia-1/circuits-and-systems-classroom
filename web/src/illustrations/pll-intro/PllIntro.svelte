<script lang="ts">
  import { onMount } from 'svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import CoursePlot from '../../components/chart/CoursePlot.svelte';
  import { DEFAULTS, DT, DURATION, canLock, simulate, type PllSettings } from './model';
  let s = $state<PllSettings>({ ...DEFAULTS }), cursor = $state(0), playing = $state(true);
  const trace = $derived(simulate(s));
  const current = $derived(trace[Math.max(0, Math.min(trace.length - 1, Math.round((Number.isFinite(cursor) ? cursor : 0) / DT)))]);
  const target = $derived(s.refMHz * s.divider);
  const points = $derived(trace.filter((_, i) => i % 6 === 0));
  const extent = $derived(Math.max(0.25, ...points.map(p => Math.abs(p.error / (2 * Math.PI)))));
  const freqExtent = $derived([Math.floor(Math.min(target, ...points.map(p => p.frequency)) - 1), Math.ceil(Math.max(target, ...points.map(p => p.frequency)) + 1)] as [number, number]);
  const status = $derived(!s.closed ? 'Loop open' : !canLock(s) ? 'Target outside VCO tuning range' : Math.abs(current.frequency - target) < .02 && Math.abs(current.error) < .025 ? 'Phase locked' : !s.integral && Math.abs(current.frequency - target) < .02 ? 'Frequency matched · phase offset remains' : 'Correcting phase');
  $effect(() => { trace; cursor = 0; });
  onMount(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) playing = false;
    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      if (playing) { cursor = Math.min(DURATION, cursor + dt * 2.4); if (cursor === DURATION) playing = false; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame); return () => cancelAnimationFrame(raf);
  });
  function preset(mode: string) {
    s = { ...DEFAULTS, closed: mode !== 'open', damping: mode === 'ring' ? .2 : .707, integral: mode !== 'p', kick: mode === 'kick' };
    cursor = 0; playing = true;
  }
  function clockPath(phase: number, frequency: number, row: number): string {
    return Array.from({ length: 1100 }, (_, i) => {
      const t = i / 1099 * 4 / s.refMHz;
      const high = Math.sin(phase + 2 * Math.PI * frequency * t) >= 0;
      return `${i ? 'L' : 'M'}${120 + i / 1099 * 748},${row + (high ? 0 : 20)}`;
    }).join(' ');
  }
</script>

<main class="course">
  <div class="toolbar">
    <p class="course-intro">A PLL moves the oscillator until its divided clock lines up with the reference.</p>
    <div class="actions" aria-label="PLL examples">
      <button onclick={() => preset('open')}>Open loop</button><button onclick={() => preset('lock')}>Lock</button><button onclick={() => preset('p')}>P only</button><button onclick={() => preset('ring')}>Ringing</button><button onclick={() => preset('kick')}>Phase step</button>
    </div>
  </div>
  <section class="panel">
    <div class="flow" aria-label="PLL feedback path">
      <div><b>1 · Compare phase →</b><small>Reference − divided VCO</small><span class="value">{(current.error / (2 * Math.PI)).toFixed(3)} cycles</span></div>
      <div><b>2 · Loop filter →</b><small>{s.integral ? 'P corrects now; I remembers' : 'Proportional correction only'}</small><span class="value">{current.control.toFixed(3)} V</span></div>
      <div><b>3 · VCO →</b><small>f = f₀ + Kᵥ × V</small><span class="value">{current.frequency.toFixed(2)} MHz</span></div>
      <div><b>4 · Divide by {s.divider} ↴</b><small>Feed this clock back</small><span class="value">{(current.frequency / s.divider).toFixed(2)} MHz</span></div>
    </div>
    <div class="return-path">← divided clock returns to the phase detector ←</div>
    <div class="clock-panel">
      <svg viewBox="0 0 900 130" role="img" aria-label="Reference, divided clock and VCO clock at the cursor">
        {#each [{ name: 'Reference', phase: current.referencePhase, frequency: s.refMHz, color: 'var(--s1)' }, { name: 'VCO ÷ N', phase: current.feedbackPhase, frequency: current.frequency / s.divider, color: 'var(--brand)' }, { name: 'VCO', phase: current.feedbackPhase * s.divider, frequency: current.frequency, color: 'var(--s2)' }] as c, i}
          <text x="0" y={25 + i * 42}>{c.name}</text><path d={clockPath(c.phase, c.frequency, 10 + i * 42)} fill="none" stroke={c.color} stroke-width="2" />
        {/each}
      </svg>
    </div>
    <div class="toolbar"><span class="lock-status" class:warn={!canLock(s)}>{status}</span><span class="note">At lock: fᵥ꜀ₒ = N × fᵣₑꜰ = {target} MHz. Clock sketch uses the phase and frequency at the cursor.</span></div>
  </section>
  <section class="panel controls" aria-label="PLL controls">
    <Range id="pll-ref" bind:value={s.refMHz} min={5} max={20} step={5} output={`${s.refMHz} MHz`}>Reference frequency</Range>
    <div class="control"><span>Feedback divider N</span><Segmented label="Feedback divider" options={[2,4,6].map(value => ({value,label:`÷${value}`}))} bind:value={s.divider}/></div>
    <Range id="pll-free" bind:value={s.freeMHz} min={20} max={60} step={1} output={`${s.freeMHz} MHz`}>VCO free-running frequency</Range>
    <Range id="pll-speed" bind:value={s.naturalKHz} min={50} max={400} step={25} output={`${s.naturalKHz} kHz`}>Loop natural frequency</Range>
    <Range id="pll-damp" bind:value={s.damping} min={.15} max={1.5} step={.05} output={s.damping.toFixed(2)}>Damping ζ</Range>
    <div class="control"><span>Loop filter</span><Segmented label="PLL filter" options={[{value:false,label:'P only'},{value:true,label:'P + I'}]} bind:value={s.integral}/></div>
  </section>
  <div class="toolbar">
    <div class="actions"><button class="primary" onclick={() => { if(cursor >= DURATION) cursor = 0; playing = !playing; }}>{playing ? 'Pause' : 'Play'}</button><button onclick={() => { cursor = 0; playing = false; }}>Restart</button><button aria-pressed={s.closed} onclick={() => s.closed = !s.closed}>{s.closed ? 'Loop closed' : 'Loop open'}</button></div>
    <div class="scrub"><Range id="pll-time" bind:value={cursor} onstart={() => playing = false} min={0} max={DURATION} step={.05} output={`${cursor.toFixed(2)} µs`}>Inspect time</Range></div>
  </div>
  <div class="two">
    <section class="panel"><h2>Frequency finds the target</h2><div class="plot-box"><CoursePlot label="VCO frequency versus time" xDomain={[0,DURATION]} yDomain={freqExtent} xLabel="time · µs" yLabel="MHz" {cursor} series={[{name:'VCO',color:'var(--brand)',points:points.map(p=>({x:p.t,y:p.frequency}))},{name:'N × reference',color:'var(--s1)',dashed:true,points:[{x:0,y:target},{x:DURATION,y:target}]}]}/></div></section>
    <section class="panel"><h2>Phase error settles</h2><div class="plot-box"><CoursePlot label="Reference minus divided VCO phase" xDomain={[0,DURATION]} yDomain={[-extent,extent]} xLabel="time · µs" yLabel="phase error · cycles" {cursor} series={[{name:'Reference − feedback',color:'var(--s2)',points:points.map(p=>({x:p.t,y:p.error/(2*Math.PI)}))}]}/></div></section>
  </div>
  <details><summary>Model and next lesson</summary><p>Averaged, linear phase detector with a PI filter; Kᵥ = 12 MHz/V, control voltage limited to ±1 V with anti-windup. Natural frequency and damping describe the unsaturated P + I loop. P-only keeps the same proportional gain. This model illustrates tracking near lock; it does not model PFD cycle slipping, capture range, charge-pump pulses or reference spurs. The phase-step example adds ⅛ cycle to the reference at 10 µs.</p><p>Next: <a href="/pll/integer-vs-fractional/">Integer-N vs fractional-N PLLs</a>.</p></details>
</main>
<style>
  .return-path { text-align: center; padding: 12px; margin: 8px 20px 0; border-bottom: 2px solid var(--brand); color: var(--brand); font: 12px var(--mono); }
  .clock-panel { margin: 22px 0 12px; } svg { width: 100%; display: block; } text { fill: var(--ink-2); font: 13px var(--mono); }
  .lock-status { color: var(--brand); font-size: 14px; font-weight: 600; } .scrub { width: min(450px,100%); }
  @media(max-width:600px) { .clock-panel { overflow-x: auto; } svg { min-width: 560px; } }
</style>
