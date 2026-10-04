<script lang="ts">
  import { onMount } from 'svelte';
  import { isLightTheme } from '../../lib/theme';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import { BLOCKS, CATEGORY, ERROR_COLOR, SYMBOL_COLORS, type BlockId } from './blocks';
  import { analyzeLink, design, lineResponses, type LinkAnalysis, type LinkSettings, type Metrics } from './model';
  import { CHANNELS, type ChannelExample } from './channels';
  import Scope from './Scope.svelte';
  import type { SerdesScene, ViewName } from './scene';
  import { EyeStream, Receiver, SymbolStream } from './streams';

  /** Slow motion: 8 UI of 17.86 ps each play per second at 1×. */
  const UIPS = 8, START = 480;
  const VIEWS: { value: ViewName; label: string }[] = [
    { value: 'overview', label: 'Overview' }, { value: 'tx', label: 'TX chip' }, { value: 'channel', label: 'Channel' }, { value: 'rx', label: 'RX chip' }, { value: 'adc', label: 'TI-ADC' },
  ];
  const LEVEL_NAMES = ['−3', '−1', '+1', '+3'];
  const EXAMPLE: LinkSettings = { lossDb: 28, echo: 0, sharedFrontEnd: true, xtV: 1.5e-3, rxNoiseV: 0.8e-3, txFfe: true, autoCtle: true, gdc: -17, gdc2: -3, dsp: true, dfe: false };
  const settingsKey = (s: LinkSettings) => JSON.stringify([s.lossDb, s.echo, s.sharedFrontEnd, s.xtV, s.rxNoiseV, s.txFfe, s.dsp, s.dfe, s.autoCtle, s.autoCtle ? 0 : s.gdc, s.autoCtle ? 0 : s.gdc2]);

  let lossDb = $state(28), xtMv = $state(1.5), rxnMv = $state(0.8), txFfe = $state(true);
  let echo = $state(0), sharedFrontEnd = $state(true);
  let equalizer = $state<'off' | 'ffe' | 'dfe'>('ffe');
  const dsp = $derived(equalizer !== 'off');
  const dfe = $derived(equalizer === 'dfe');
  let ctle = $state<'auto' | 'manual'>('auto'), gdc = $state(-17), gdc2 = $state(-3);
  let playing = $state(true), speed = $state(1), labels = $state(true), spin = $state(true);
  let view = $state<ViewName | null>('overview');
  let light = $state(true), noGl = $state(false);
  let hover = $state<{ id: BlockId; x: number; y: number } | null>(null);
  let picked = $state<BlockId | null>(null);
  let host: HTMLDivElement | undefined = $state();
  let scope: ReturnType<typeof Scope> | undefined = $state();

  const first = analyzeLink(EXAMPLE);
  let appliedSettings = settingsKey(EXAMPLE);
  let a = $state.raw<LinkAnalysis>(first);
  const rx = new Receiver(first, true), stream = new SymbolStream(), eyes = new EyeStream();
  let measured = $state.raw(eyes.measurements());
  let live = $state.raw<Metrics>(rx.live);
  let adapting = $state(false), decisions = $state(0), errors = $state(0);
  let line = lineResponses(28, true), lineKey = '28|true|0';
  let scene: SerdesScene | null = null;
  const eqComparison = $derived.by(() => ({
    ffe: 10 * Math.log10(design(a.h, a.noise, true, false).snr),
    dfe: 10 * Math.log10(design(a.h, a.noise, true, true).snr),
  }));

  // Re-solve the link shortly after the settings stop moving; the running taps then adapt toward the new optimum.
  $effect(() => {
    const auto = ctle === 'auto';
    const s: LinkSettings = { lossDb, echo, sharedFrontEnd, xtV: xtMv * 1e-3, rxNoiseV: rxnMv * 1e-3, txFfe, dsp, dfe, autoCtle: auto, gdc: auto ? 0 : gdc, gdc2: auto ? 0 : gdc2 };
    const timer = setTimeout(() => {
      const next = settingsKey(s);
      if (next === appliedSettings) return;
      appliedSettings = next;
      a = analyzeLink(s);
      rx.retarget(a, s.dsp);
      if (auto) {
        gdc = a.gdc;
        gdc2 = a.gdc2;
      }
      const key = `${s.lossDb}|${s.txFfe}|${s.echo}`;
      if (key !== lineKey) {
        lineKey = key;
        line = lineResponses(s.lossDb, s.txFfe, s.echo);
      }
      scene?.setPadLoss(a.channelLossDb);
    }, 90);
    return () => clearTimeout(timer);
  });

  onMount(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      playing = false;
      spin = false;
    }
    light = isLightTheme();
    const themeWatch = new MutationObserver(() => {
      light = isLightTheme();
      scene?.setTheme(light);
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    let t = START, clockT = 0, frame = 0, raf = 0, last = performance.now(), gone = false;
    stream.start(t, rx);
    eyes.run(1500, rx);
    measured = eyes.measurements();
    let eyeModel = a, eyeWasMoving = false;
    import('./scene').then(({ SerdesScene }) => {
      if (gone || !host) return;
      try {
        scene = new SerdesScene(host, {
          reducedMotion: reduced,
          onHover: (id, x, y) => {
            const r = host?.getBoundingClientRect();
            hover = id && r ? { id, x: x - r.left, y: y - r.top } : null;
          },
          onPick: (id) => (picked = id === 'pcb' ? null : id),
          onUserMove: () => {
            view = null;
            spin = false;
            scene?.setSpin(false);
          },
        });
      } catch {
        noGl = true;
        return;
      }
      scene.setTheme(light);
      scene.setLabels(labels);
      scene.setSpin(spin);
      scene.setPadLoss(a.channelLossDb);
    });
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frame++;
      if (playing) {
        t += dt * UIPS * speed;
        clockT += dt;
      }
      const moving = rx.adapt(dt);
      stream.advance(t, rx, (n, v) => scene?.sampled(n, v, rx.tSample));
      scene?.update(dt, t, clockT, rx, stream, line, txFfe);
      if (playing || moving || eyeWasMoving || eyeModel !== a) {
        const k = Math.pow(0.955, dt * 60);
        for (const e of eyes.eyes) e.decay(k);
        eyes.run(!playing && !moving ? 4200 : Math.max(8, Math.round(44 * dt * 60)), rx);
        eyeModel = a;
      }
      eyeWasMoving = moving;
      if (frame % 8 === 0) {
        live = rx.live;
        measured = eyes.measurements();
        adapting = moving;
        decisions = stream.decisions;
        errors = stream.errors;
      }
      scope?.draw();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
      themeWatch.disconnect();
      scene?.dispose();
      scene = null;
    };
  });

  const go = (v: ViewName) => {
    view = v;
    scene?.flyTo(v);
  };
  const example = $derived(CHANNELS.find((c) => c.lossDb === lossDb && Math.abs(c.echo - echo) < 1e-9));
  function chooseChannel(channel: ChannelExample): void {
    lossDb = channel.lossDb;
    echo = channel.echo;
  }
  const slowMs = $derived(1000 / (UIPS * speed));
  const facts = $derived.by((): [string, string][] => {
    switch (picked) {
      case 'ctle': return [['g_DC / g_DC2', `${nf(a.gdc, 0)} / ${nf(a.gdc2, 0)} dB`], ['Boost, 28 GHz vs DC', `${nf(a.ctleBoostDb, 1)} dB`], ['Setting', ctle === 'auto' ? a.sharedFrontEnd ? 'auto, FFE calibration' : 'auto, best SNR' : 'manual']];
      case 'vga': return [['Gain', `${nf(20 * Math.log10(a.vga), 1)} dB`]];
      case 'dsp': return [['Model SNR at slicer', `${nf(10 * Math.log10(live.snr), 1)} dB`], ['DFE b₁', a.dfe ? nf(live.b1, 3) : 'off']];
      case 'cdr': return [['Sampling phase', `${nf(a.phaseUi, 2)} UI from the pulse peak`]];
      case 'chan': return [['Loss at 28 GHz', `${nf(a.channelLossDb, 1)} dB bump to bump`], ['Delayed path', `${Math.round(a.echo * 100)}% at +1 UI`], ['Velocity', '≈ 0.5 c, 2.7 mm per UI']];
      case 'txdsp': return [['Taps', txFfe ? '−0.10 / 0.75 / −0.15' : '0 / 1 / 0 (off)']];
      case 'deser': return [['Decisions', decisions.toLocaleString('en-US')], ['Errors seen', String(errors)]];
      default: return [];
    }
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') picked = null; }} />

<main class="page scene-lesson serdes">
  <section class="work">
    <aside class="side" aria-label="Link settings">
      <section>
        <h2 class="label">Channel</h2>
        <div class="channel-options" role="group" aria-label="Channel examples">
          {#each CHANNELS as channel (channel.id)}
            <button type="button" aria-pressed={example?.id === channel.id} onclick={() => chooseChannel(channel)}><span>{channel.name}</span><small>{channel.detail}</small></button>
          {/each}
        </div>
        {#if example}<p class="hint">{example.note}</p>{/if}
      </section>
      <section>
        <h2 class="label">Channel settings</h2>
        <Range id="serdes-loss" bind:value={lossDb} min={8} max={44} step={1} output={`${lossDb} dB`}>Distributed loss at 28 GHz</Range>
        {#if !echo}<div class="ticks" aria-hidden="true"><span style:left="22.2%">VSR</span><span style:left="33.3%">MR</span><span style:left="55.6%">LR</span></div>{/if}
        <Range id="serdes-echo" bind:value={echo} min={0} max={0.9} step={0.05} output={`${Math.round(echo * 100)}%`}>Echo amplitude · +1 UI</Range>
        <p class="hint">Total channel loss at 28 GHz: {nf(a.channelLossDb, 1)} dB</p>
        <Range id="serdes-xt" bind:value={xtMv} min={0} max={4} step={0.1} output={`${xtMv.toFixed(1)} mV`}>Crosstalk (ICN)</Range>
      </section>
      <section>
        <h2 class="label">Transmitter</h2>
        <div class="row"><span>3-tap FFE</span><Segmented size="sm" label="Transmitter feed-forward equalizer" options={[{ value: false, label: 'Off' }, { value: true, label: 'On' }]} bind:value={txFfe} /></div>
        <p class="hint">{txFfe ? 'c(−1) −0.10 · c(0) 0.75 · c(+1) −0.15' : 'c(−1) 0 · c(0) 1 · c(+1) 0'}</p>
      </section>
      <section>
        <h2 class="label">Receiver</h2>
        <div class="row"><span>CTLE</span><Segmented size="sm" label="CTLE setting" options={[{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }]} bind:value={ctle} /></div>
        {#if ctle === 'manual'}<Range id="serdes-gdc" bind:value={gdc} min={-20} max={0} step={1} output={`${nf(gdc, 0)} dB`}><var>g</var><sub>DC</sub></Range>{/if}
        <div class="row"><span>DSP</span><Segmented size="sm" label="Receiver DSP equalizer" options={[{ value: 'off', label: 'Off' }, { value: 'ffe', label: 'FFE' }, { value: 'dfe', label: 'FFE + DFE' }]} bind:value={equalizer} /></div>
        <label class="match-front-end"><input type="checkbox" bind:checked={sharedFrontEnd} /> Same CTLE &amp; clock across DSP modes</label>
        {#if a.sharedFrontEnd}
          <div class="eq-comparison" aria-label="Model SNR comparison at the same front end">
            <span>FFE <b class="mono">{nf(eqComparison.ffe, 1)} dB</b></span>
            <span>FFE + DFE <b class="mono">{nf(eqComparison.dfe, 1)} dB</b></span>
            <small>Model · correct feedback <b class="mono">+{nf(eqComparison.dfe - eqComparison.ffe, 1)} dB</b></small>
          </div>
        {/if}
        <p class="hint">{ctle === 'auto' ? `auto: g_DC ${nf(a.gdc, 0)} dB, g_DC2 ${nf(a.gdc2, 0)} dB` : 'manual g_DC, g_DC2 kept'} · {dsp ? dfe ? '12-tap FFE + 1-tap DFE' : '12-tap FFE' : 'DSP bypassed'}</p>
        <Range id="serdes-rxn" bind:value={rxnMv} min={0.2} max={2.5} step={0.1} output={`${rxnMv.toFixed(1)} mV`}>RX input noise</Range>
      </section>
      <section>
        <h2 class="label">Playback</h2>
        <div class="row">
          <button type="button" class="primary" aria-pressed={playing} onclick={() => (playing = !playing)}>{playing ? 'Pause' : 'Play'}</button>
          <Segmented size="sm" mono label="Playback speed" options={[{ value: 0.25, label: '¼×' }, { value: 0.5, label: '½×' }, { value: 1, label: '1×' }, { value: 2, label: '2×' }, { value: 4, label: '4×' }]} bind:value={speed} />
        </div>
        <p class="hint">1 UI = 17.86 ps, shown as {nf(slowMs, slowMs < 100 ? 1 : 0)} ms</p>
        <div class="row start">
          <button type="button" aria-pressed={spin} onclick={() => { spin = !spin; scene?.setSpin(spin); }}>Auto-rotate</button>
          <button type="button" aria-pressed={labels} onclick={() => { labels = !labels; scene?.setLabels(labels); }}>Labels</button>
        </div>
      </section>
      <section>
        <h2 class="label">Key</h2>
        <ul class="legend-list" aria-label="Symbol colours">
          {#each SYMBOL_COLORS as c, i (c)}<li><i style:background={c}></i>{LEVEL_NAMES[i]}</li>{/each}
          <li><i style:background={ERROR_COLOR}></i>error</li>
        </ul>
        <ul class="floor" aria-label="Floorplan colours">
          {#each Object.values(CATEGORY) as c (c.name)}<li><i style:background="#{c.color.toString(16).padStart(6, '0')}"></i>{c.name}</li>{/each}
        </ul>
      </section>
    </aside>

    <div class="stage" bind:this={host}>
      {#if noGl}<p class="nogl">This view needs WebGL, which is turned off or unavailable in this browser.</p>{/if}
      <div class="views" role="group" aria-label="Camera views">
        {#each VIEWS as v (v.value)}<button type="button" aria-pressed={view === v.value} onclick={() => go(v.value)}>{v.label}</button>{/each}
      </div>
      {#if hover && !picked}
        <div class="tip" style:left="{hover.x + 14}px" style:top="{hover.y + 16}px">{BLOCKS[hover.id].title}<small>Click for details</small></div>
      {/if}
      {#if picked}
        {@const info = BLOCKS[picked]}
        <article class="info" aria-live="polite">
          <div class="info-head">
            <div>
              <span class="cat"><i style:background="#{CATEGORY[info.category].color.toString(16).padStart(6, '0')}"></i>{CATEGORY[info.category].name}</span>
              <h2>{info.title}</h2>
            </div>
            <button type="button" onclick={() => (picked = null)}>Close</button>
          </div>
          <p>{info.text}</p>
          {#if facts.length}<dl>{#each facts as [k, v] (k)}<dt>{k}</dt><dd class="mono">{v}</dd>{/each}</dl>{/if}
          {#if picked !== 'pcb'}<button type="button" class="primary" onclick={() => { if (picked) scene?.focus(picked); view = null; }}>Fly to block</button>{/if}
        </article>
      {/if}
    </div>

    <Scope bind:this={scope} {a} {live} {dsp} {adapting} {decisions} {errors} {light} {eyes} {measured} />
  </section>
</main>

<style>
  .serdes { grid-template-rows: minmax(0, 1fr); }
  .work { display: grid; grid-template-columns: 250px minmax(0, 1fr) 320px; gap: 18px; min-height: 0; }
  .side { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; --accent: var(--brand); --accent-soft: var(--brand-soft); }
  .side section { display: grid; gap: 8px; padding: 12px 0; border-top: 1px solid var(--rule); }
  .side section:first-child { border-top: 0; padding-top: 2px; }
  .side h2 { margin: 0; }
  .side section :global(.range) { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'label out' 'input input'; align-items: center; gap: 5px 8px; }
  .side section :global(.range label) { grid-area: label; white-space: normal; line-height: 1.4; }
  .side section :global(.range input) { grid-area: input; width: 100%; }
  .side section :global(.range output) { grid-area: out; width: auto; text-align: right; }
  .ticks { position: relative; height: 11px; margin-top: -5px; font: 10px var(--mono); color: var(--ink-3); }
  .ticks span { position: absolute; transform: translateX(-50%); }
  .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--ink-2); }
  .row.start { justify-content: flex-start; }
  .hint { margin: -3px 0 0; font: 11px/1.4 var(--mono); color: var(--ink-3); }
  .legend-list, .floor { display: grid; gap: 5px 10px; margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--ink-2); }
  .legend-list { grid-template-columns: repeat(5, max-content); font-family: var(--mono); font-size: 11.5px; }
  .floor { grid-template-columns: 1fr 1fr; }
  .legend-list i, .floor i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .stage { position: relative; min-height: 0; overflow: hidden; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--rule); background: var(--plot); }
  .stage :global(.serdes-canvas) { position: absolute; inset: 0; display: block; touch-action: none; }
  .stage :global(.serdes-labels) { position: absolute; inset: 0; pointer-events: none; }
  .stage :global(.serdes-lbl) { position: relative; top: -17px; display: flex; align-items: center; gap: 5px; padding: 3px 7px 3px 6px; border-radius: 5px; background: color-mix(in srgb, var(--plot) 88%, transparent); box-shadow: 0 0 0 1px var(--rule), 0 2px 8px rgba(0, 0, 0, 0.14); color: var(--ink); font: 500 11.5px/1.2 var(--sans); white-space: nowrap; transition: opacity 0.3s; }
  .stage :global(.serdes-lbl::after) { content: ''; position: absolute; left: 50%; top: 100%; width: 1px; height: 12px; background: var(--ink-3); opacity: 0.6; }
  .stage :global(.serdes-lbl i) { width: 7px; height: 7px; border-radius: 2px; background: var(--ink-3); }
  .stage :global(.serdes-lbl.big) { font-size: 13px; font-weight: 600; }
  .stage :global(.far .serdes-lbl) { opacity: 0; }
  .nogl { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 20px; color: var(--ink-2); text-align: center; }
  .views { position: absolute; z-index: 2; top: 10px; left: 10px; display: flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 8px; background: color-mix(in srgb, var(--plot) 86%, transparent); box-shadow: inset 0 0 0 1px var(--rule); }
  button { font: 500 12.5px/1 var(--sans); color: var(--ink-2); background: var(--plot); border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; white-space: nowrap; box-shadow: inset 0 0 0 1px var(--rule); }
  button:hover { color: var(--ink); }
  .channel-options { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .channel-options button { display: grid; gap: 6px; text-align: left; padding: 10px; }
  .channel-options small { font-size: 11px; font-weight: 400; color: var(--ink-3); }
  .match-front-end { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ink-2); }
  .match-front-end input { accent-color: var(--brand); margin: 0; }
  .eq-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 9px; background: var(--plot); border-radius: 6px; font-size: 11px; color: var(--ink-2); }
  .eq-comparison span { display: grid; gap: 4px; }
  .eq-comparison b { color: var(--ink); font-weight: 500; }
  .eq-comparison small { display: flex; justify-content: space-between; gap: 6px; grid-column: 1 / -1; font-size: 10px; border-top: 1px solid var(--rule); padding-top: 6px; }
  .views button { box-shadow: none; background: transparent; }
  button[aria-pressed='true'] { color: var(--ink); background: var(--brand-soft); box-shadow: inset 0 0 0 1px var(--brand); }
  button.primary { color: var(--ground); background: var(--brand); box-shadow: none; min-width: 58px; }
  .tip { position: absolute; z-index: 3; pointer-events: none; padding: 6px 9px; border-radius: 6px; background: var(--plot); box-shadow: 0 0 0 1px var(--rule), 0 8px 24px rgba(0, 0, 0, 0.2); font-size: 12.5px; font-weight: 500; white-space: nowrap; }
  .tip small { display: block; font-size: 11px; font-weight: 400; color: var(--ink-3); }
  .info { position: absolute; z-index: 3; left: 10px; bottom: 10px; width: min(360px, calc(100% - 20px)); display: grid; gap: 8px; padding: 14px 16px; border-radius: 10px; background: var(--plot); box-shadow: 0 0 0 1px var(--rule), 0 14px 36px rgba(10, 14, 20, 0.22); }
  .info-head { display: flex; justify-content: space-between; align-items: start; gap: 10px; }
  .info h2 { margin: 3px 0 0; font-size: 17px; font-weight: 550; letter-spacing: -0.015em; }
  .cat { display: flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-2); }
  .cat i { width: 8px; height: 8px; border-radius: 2px; }
  .info p { margin: 0; color: var(--ink-2); font-size: 13px; line-height: 1.55; }
  .info dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; font-size: 12.5px; }
  .info dt { color: var(--ink-3); }
  .info dd { margin: 0; font-size: 12px; }
  .info .primary { justify-self: start; }
  @media (max-width: 1180px) { .work { grid-template-columns: 220px minmax(0, 1fr) 290px; gap: 14px; } }
  @media (max-width: 900px) {
    .work { grid-template-columns: minmax(0, 1fr); }
    .stage { order: -1; height: 60vh; min-height: 360px; }
    .side { overflow: visible; padding-right: 0; }
  }
</style>
