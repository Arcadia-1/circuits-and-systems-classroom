<script lang="ts">
  import { onMount } from 'svelte';
  import { isLightTheme } from '../../lib/theme';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { freqText, nf } from '../../lib/format';
  import { drawEye } from '../serdes/eyes';
  import { BAUD, CdrSim, DEFAULTS, EYE_CLOSURE, JTOL_HZ, NPI, jtolAt, wrap, type CdrSettings, type Pattern, type UiSample } from './model';
  import { NrzEyes } from './eyes';
  import JtolPlot from './JtolPlot.svelte';
  import PhasePlot from './PhasePlot.svelte';
  import type { CdrScene } from './scene';
  import { AHEAD, BELT_SPAN, COLORS, WINDOW, type CdrView, type History } from './view';

  /** Span of the phase plot, points drawn of it, and the frequency offset at the ends of its slider (ppm). */
  const SPAN = 4096, PLOT_POINTS = 512, PPM_MAX = 40000;
  const VIEWS: { value: CdrView; label: string }[] = [
    { value: 'belt', label: 'Conveyor belt' },
    { value: 'tunnel', label: 'Phase tunnel' },
    { value: 'wheel', label: 'Top: phase wheel' },
    { value: 'loop', label: 'Loop' },
  ];

  interface Step {
    title: string;
    body: string;
    look: string;
    s: CdrSettings;
    view: CdrView;
    /** Bits per second on screen and UI run before the step starts. */
    speed: number;
    prefill: number;
    /** Knock the clock this far off, two seconds in (UI). */
    kick?: number;
    action?: 'kick' | 'integral' | 'jitter';
  }
  /** A loop that answers every edge at once, so each verdict turns the knob while you watch. */
  const QUICK = { kp: 2, integral: false, kiLog2: -3, decim: 1, latency: 0 };
  const CALM = { sjUipp: 0, sjHz: 1e9, rjUi: 0.01, pattern: 'prbs31' as Pattern };
  const TOUR: Step[] = [
    {
      title: 'Bits arrive, but no clock',
      body: 'Data reaches the receiver as a stream of high and low levels: here tall blocks are 1s and short blocks are 0s. No clock signal comes with it, so the receiver has to decide on its own when to look at each bit. Its <b class="g">reader</b> looks once per bit, and the safest moment is the middle of a block, far from where the level changes.',
      look: 'Each green dot marks one look, with the bit it read floating above it. The dots land mid-block, so every read matches its block.',
      s: { ...CALM, ...QUICK, ppm: 0, cdr: false },
      view: 'belt', speed: 5, prefill: 30,
    },
    {
      title: 'Two clocks never quite agree',
      body: 'Transmitter and receiver each run from their own quartz crystal, and no two crystals tick at exactly the same rate. Here the receiver’s clock runs 3% fast. Real links are off by only about 0.03%, which does the same thing, just slower. Nothing corrects it yet.',
      look: 'The dots creep along the blocks and turn red near the edges, where the level is changing and a bit can be misread. Every 33 bits the reader has looked once too often and reads one bit twice.',
      s: { ...CALM, ...QUICK, ppm: 30000, cdr: false },
      view: 'belt', speed: 5, prefill: 30,
    },
    {
      title: 'Clock recovery: steer by the edges',
      body: 'A CDR adds a second head, the <b>edge checker</b>, which looks halfway between two reads, just where the level may change. When two neighbouring bits differ, that look shows whether the clock is early (it still sees the old bit: <b class="o">orange</b> mark) or late (it already sees the new one: <b class="b">blue</b> mark). Every mark turns the timing knob one notch to correct it.',
      look: 'We knock the clock a third of a bit off. Blue marks pile up, the knob turns back notch by notch, and the dots return to the middle. Once centred, orange and blue take turns.',
      s: { ...CALM, ...QUICK, ppm: 0, cdr: true },
      view: 'belt', speed: 5, prefill: 30, kick: 0.35, action: 'kick',
    },
    {
      title: 'Keeping up with a clock that is off',
      body: 'Now the receiver’s clock is 3% fast again. Random data has an edge only about half the time, so proportional corrections alone cannot keep up. The reader slips by whole bits. An <b>integral path</b> learns the clock error and keeps the timing knob turning between edges.',
      look: 'Switch it on. Within a few seconds the dots settle mid-block, and “Learned clock error” on the right climbs to about 30,000 ppm, which is 3%.',
      s: { ...CALM, ...QUICK, ppm: 30000, cdr: true },
      view: 'belt', speed: 5, prefill: 30, action: 'integral',
    },
    {
      title: 'Jitter: edges that wobble',
      body: 'Real edges also shift back and forth in time: jitter. A slow wobble is just a clock error that keeps changing, and the loop follows it as before. This one repeats a billion times a second, far too fast for the knob, so the reader stays put and the wobble has to fit inside the bit. (The loop now runs at real-world settings.)',
      look: 'The blocks drift back and forth under the reader, so the dots swing inside them. Past about half a bit of wobble they reach the edges and turn red.',
      s: { ...CALM, ppm: 0, cdr: true, kp: 1, integral: true, kiLog2: -6, decim: 32, latency: 2, sjUipp: 0.4 },
      view: 'belt', speed: 8, prefill: 2000, action: 'jitter',
    },
    {
      title: 'The real link: 56 billion bits a second',
      body: 'The link runs at 56 billion bits/s. This view shows 800 bits/s: 70 million times slower. The phase tunnel shows the last 800 bits: time runs upwards, and angle is phase inside one bit. Dots are data edges, the grey stripe is the edge checker, and the green stripe, half a turn away, is the reader.',
      look: 'The dots hug the edge-checker stripe, so the reader stays clear of them. The charts and controls follow the same loop.',
      s: { ...DEFAULTS },
      view: 'tunnel', speed: 800, prefill: 16000,
    },
  ];

  let ppm = $state(TOUR[0].s.ppm), sjUipp = $state(TOUR[0].s.sjUipp), sjLog = $state(Math.log10(TOUR[0].s.sjHz)), rjMui = $state(TOUR[0].s.rjUi * 1000), pattern = $state<Pattern>(TOUR[0].s.pattern);
  let cdr = $state(TOUR[0].s.cdr), kp = $state(TOUR[0].s.kp), integral = $state(TOUR[0].s.integral), kiLog2 = $state(TOUR[0].s.kiLog2), decim = $state(TOUR[0].s.decim), latency = $state(TOUR[0].s.latency);
  let playing = $state(true), speed = $state(TOUR[0].speed), labels = $state(true), spin = $state(false);
  let view = $state<CdrView | null>('belt'), shown = $state<CdrView>('belt');
  let tour = $state(0), tourOpen = $state(true);
  let light = $state(true), noGl = $state(false);
  let host: HTMLDivElement | undefined = $state();
  let eyeCanvas: HTMLCanvasElement[] = $state([]);
  let jtol = $state.raw<{ hz: number; uipp: number }[] | null>(null);
  let readout = $state({ rmsMui: 0, ppm: 0, slips: 0, errors: 0, bits: 0, recentSlips: 0, recentErrors: 0 });
  let phasePlot = $state.raw({ input: new Float32Array(0), recovered: new Float32Array(0), span: 0 });

  const step = $derived(TOUR[tour]);
  const sjHz = $derived(10 ** sjLog);
  const settings = (): CdrSettings => ({ ppm, sjUipp, sjHz, rjUi: rjMui / 1000, pattern, cdr, kp, integral, kiLog2, decim, latency });
  const pOnlyPpm = $derived((kp / (NPI * decim)) * 1e6);
  const randomDataPpm = $derived(pOnlyPpm * (1 - 2 ** -decim));
  const int = (v: number) => Math.round(v).toLocaleString('en-US').replace('-', '−');
  const slowText = $derived.by(() => {
    const k = BAUD / speed;
    return k >= 1e9 ? `${nf(k / 1e9, k >= 1e10 ? 0 : 1)} billion` : k >= 1e6 ? `${nf(k / 1e6, k >= 1e7 ? 0 : 1)} million` : int(k);
  });
  const status = $derived(
    !cdr ? (ppm === 0 && sjUipp === 0 ? { s: 'warn', text: 'No CDR · the clocks happen to match' } : { s: 'bad', text: 'No CDR · the reader drifts' })
    : readout.recentSlips > 0 ? { s: 'bad', text: 'Cycle slips' }
    : readout.recentErrors > 0 ? { s: 'warn', text: 'Sampling margin violated' }
    : { s: 'good', text: 'Tracking · margin clear' },
  );

  /** The running loop, the display clock (UI) and a pending push on the clock; plain fields so the frame loop stays out of reactivity. */
  const run = { sim: new CdrSim(settings()), clock: 0, ppmAvg: 0, kickAt: -1, kickSign: 1 };
  const eyes = new NrzEyes();
  const hist: History = {
    end: 0, bit: new Uint8Array(WINDOW), edge: new Float32Array(WINDOW), theta: new Float32Array(WINDOW), decision: new Int8Array(WINDOW), error: new Uint8Array(WINDOW), transition: new Uint8Array(WINDOW),
    ahead: 0, nextBit: new Uint8Array(AHEAD), nextEdge: new Float32Array(AHEAD),
  };
  const inRing = new Float32Array(SPAN), thRing = new Float32Array(SPAN);
  /** Slip and error counts every SNAP UI, for "recently" in the status line. */
  const SNAP = 10, SNAPS = 2048;
  const snapSlips = new Int32Array(SNAPS), snapErrors = new Int32Array(SNAPS);
  let scene: CdrScene | null = null;

  function record(s: UiSample): void {
    const i = s.n % WINDOW;
    hist.bit[i] = s.bit;
    hist.edge[i] = s.edge;
    hist.theta[i] = s.theta;
    hist.decision[i] = s.decision;
    hist.error[i] = s.error ? 1 : 0;
    hist.transition[i] = s.transition ? 1 : 0;
    hist.end = s.n + 1;
    inRing[s.n % SPAN] = s.edge;
    thRing[s.n % SPAN] = s.theta;
    eyes.push(s);
    if (s.n % SNAP === 0) {
      snapSlips[(s.n / SNAP) % SNAPS] = run.sim.slips;
      snapErrors[(s.n / SNAP) % SNAPS] = run.sim.errors;
    }
  }
  /** The bits still on their way, as far as the far end of the belt. */
  function lookAhead(): void {
    for (let k = 0; k < AHEAD; k++) {
      const p = run.sim.peek(k);
      hist.nextBit[k] = p.bit;
      hist.nextEdge[k] = p.edge;
      hist.ahead = k + 1;
      if (k >= 1 && run.sim.n + k + p.edge > run.clock + BELT_SPAN + 2) break;
    }
  }
  function restart(prefill: number): void {
    run.sim = new CdrSim(settings());
    hist.end = 0;
    eyes.clear();
    snapSlips.fill(0);
    snapErrors.fill(0);
    for (let i = 0; i < prefill; i++) record(run.sim.step());
    run.clock = run.sim.n + run.sim.theta - 1e-6;
    run.ppmAvg = run.sim.trackedPpm;
    run.kickAt = -1;
    lookAhead();
  }
  function applyStep(i: number): void {
    const st = TOUR[i];
    tour = i;
    ppm = st.s.ppm;
    sjUipp = st.s.sjUipp;
    sjLog = Math.log10(st.s.sjHz);
    rjMui = Math.round(st.s.rjUi * 1000);
    pattern = st.s.pattern;
    cdr = st.s.cdr;
    kp = st.s.kp;
    integral = st.s.integral;
    kiLog2 = st.s.kiLog2;
    decim = st.s.decim;
    latency = st.s.latency;
    speed = st.speed;
    playing = true;
    restart(st.prefill);
    if (st.kick) {
      run.kickAt = run.clock + 10;
      run.kickSign = 1;
    }
    go(st.view);
  }
  /** Knock the recovered clock a third of a UI off, alternating the direction. */
  function push(): void {
    run.sim.kick(0.35 * run.kickSign);
    run.kickSign = -run.kickSign;
    run.kickAt = -1;
  }

  // Settings reach the running loop immediately; only the pattern restarts its generator.
  $effect(() => {
    const s = settings();
    const { pattern: p, ...rest } = s;
    Object.assign(run.sim.s, rest);
    run.sim.setPattern(p);
  });
  // The tolerance curve depends on the loop and the data, not on the jitter being applied now.
  $effect(() => {
    const s: CdrSettings = { ppm, sjUipp: 0, sjHz: 1e7, rjUi: rjMui / 1000, pattern, cdr, kp, integral, kiLog2, decim, latency };
    if (!s.cdr) {
      jtol = [];
      return;
    }
    jtol = null;
    // Yield between frequencies so controls and animation remain responsive; cancel stale sweeps.
    let cancelled = false, index = 0;
    const curve: { hz: number; uipp: number }[] = [];
    const next = () => {
      if (cancelled) return;
      const hz = JTOL_HZ[index++];
      curve.push({ hz, uipp: jtolAt(s, hz) });
      if (index < JTOL_HZ.length) timer = setTimeout(next, 0);
      else jtol = curve;
    };
    let timer = setTimeout(next, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  });

  onMount(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) playing = false;
    light = isLightTheme();
    const themeWatch = new MutationObserver(() => {
      light = isLightTheme();
      scene?.setTheme(light);
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    restart(TOUR[0].prefill);
    let raf = 0, frame = 0, last = performance.now(), gone = false;
    import('./scene').then(({ CdrScene }) => {
      if (gone || !host) return;
      try {
        scene = new CdrScene(host, { reducedMotion: reduced, onUserMove: () => { view = null; spin = false; scene?.setSpin(false); } });
      } catch {
        noGl = true;
        return;
      }
      scene.setTheme(light);
      scene.setLabels(labels);
      scene.setSpin(spin);
      if (shown !== 'belt') scene.flyTo(shown, 0.001);
    });
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frame++;
      const before = run.sim.n;
      if (playing) {
        run.clock += dt * speed;
        if (run.kickAt >= 0 && run.clock >= run.kickAt) push();
        // step each UI once the display reaches its edge sampler, so a change to the loop shows on the very next bit
        for (let k = 0; run.sim.n + run.sim.theta <= run.clock; k++) {
          if (k === 4000) {
            run.clock = run.sim.n + run.sim.theta;
            break;
          }
          record(run.sim.step());
        }
      }
      lookAhead();
      const steps = run.sim.n - before;
      if (steps) eyes.decay(Math.pow(0.9985, steps));
      run.ppmAvg += (run.sim.trackedPpm - run.ppmAvg) * (1 - Math.exp(-dt / 0.6));
      scene?.setCdr(cdr);
      scene?.update(dt, hist, run.clock, run.ppmAvg, run.sim.updates, run.sim.lastVote);
      const styles = [{ corner: cdr ? 'with CDR' : 'loop off' }, { corner: 'fixed clock' }];
      eyeCanvas.forEach((c, i) => c && drawEye(c, i ? eyes.free : eyes.recovered, { light, range: 1.35, amplitude: null, corner: styles[i].corner }));
      if (frame % 6 === 0) {
        const n = hist.end, count = Math.min(SPAN, n), stride = Math.max(1, Math.ceil(count / PLOT_POINTS));
        let sum2 = 0;
        const input = new Float32Array(Math.ceil(count / stride)), recovered = new Float32Array(input.length);
        for (let j = 0; j < count; j++) {
          const i = (n - count + j) % SPAN, e = wrap(inRing[i] - thRing[i]);
          sum2 += e * e;
          const k = Math.floor(j / stride);
          if (j % stride === 0 && k < input.length) {
            input[k] = inRing[i];
            recovered[k] = thRing[i];
          }
        }
        phasePlot = { input, recovered, span: count };
        // "recently" is the last eight seconds on screen, at least 60 UI
        const back = Math.ceil((n - Math.min(20000, Math.max(60, speed * 8))) / SNAP), j = Math.max(0, back, Math.floor(n / SNAP) - SNAPS + 1);
        const old = j * SNAP < n ? { slips: snapSlips[j % SNAPS], errors: snapErrors[j % SNAPS] } : { slips: run.sim.slips, errors: run.sim.errors };
        readout = { rmsMui: count ? Math.sqrt(sum2 / count) * 1e3 : 0, ppm: run.ppmAvg, slips: run.sim.slips, errors: run.sim.errors, bits: run.sim.n, recentSlips: run.sim.slips - old.slips, recentErrors: run.sim.errors - old.errors };
      }
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

  function sized(node: HTMLCanvasElement) {
    const ro = new ResizeObserver(() => {
      const d = Math.min(devicePixelRatio, 2);
      node.width = Math.round(node.clientWidth * d);
      node.height = Math.round(node.clientHeight * d);
    });
    ro.observe(node);
    return { destroy: () => ro.disconnect() };
  }
  function go(v: CdrView): void {
    view = shown = v;
    scene?.flyTo(v);
  }
</script>

<main class="page scene-lesson cdr">
  <section class="work">
    <aside class="side" aria-label="Guided tour and settings">
      <section class="tour" aria-label="Guided tour">
        {#if tourOpen}
          <div class="tour-top">
            <span class="label">Guided tour · {tour + 1} of {TOUR.length}</span>
            <button type="button" class="link" onclick={() => (tourOpen = false)}>Hide</button>
          </div>
          <div class="dots" role="group" aria-label="Tour steps">
            {#each TOUR as t, i (t.title)}<button type="button" aria-label={`Step ${i + 1}: ${t.title}`} aria-current={i === tour ? 'step' : undefined} onclick={() => applyStep(i)}></button>{/each}
          </div>
          <h2>{step.title}</h2>
          <p>{@html step.body}</p>
          {#if step.action === 'kick'}
            <button type="button" onclick={push}>Knock the clock off again</button>
          {:else if step.action === 'integral'}
            <button type="button" class:primary={!integral} aria-pressed={integral} onclick={() => (integral = !integral)}>{integral ? 'Integral path on · switch off' : 'Add the integral path'}</button>
          {:else if step.action === 'jitter'}
            <Range id="cdr-tour-sj" bind:value={sjUipp} min={0} max={1} step={0.05} output={`${sjUipp.toFixed(2)} bit`}>Wobble, peak to peak</Range>
          {/if}
          <p class="look"><b>Look for</b>{step.look}</p>
          <div class="nav">
            <button type="button" disabled={tour === 0} onclick={() => applyStep(tour - 1)}>Back</button>
            {#if tour < TOUR.length - 1}
              <button type="button" class="primary" onclick={() => applyStep(tour + 1)}>Next</button>
            {:else}
              <button type="button" class="primary" onclick={() => (tourOpen = false)}>Explore on your own</button>
            {/if}
          </div>
        {:else}
          <button type="button" class="primary wide" onclick={() => { tourOpen = true; applyStep(0); }}>Start the guided tour</button>
        {/if}
      </section>
      <section>
        <h2 class="label">Incoming data</h2>
        <Range id="cdr-ppm" bind:value={() => Math.cbrt(ppm / PPM_MAX), (x: number) => { const v = PPM_MAX * x ** 3; ppm = Math.abs(v) < 10 ? 0 : Number(v.toPrecision(2)); }} min={-1} max={1} step={0.005} output={`${int(ppm)} ppm`}>Clock error</Range>
        <Range id="cdr-sj" bind:value={sjUipp} min={0} max={3} step={0.05} output={`${sjUipp.toFixed(2)} UIpp`}>Sinusoidal jitter</Range>
        <Range id="cdr-sjf" bind:value={sjLog} min={6} max={9} step={0.05} output={freqText(sjHz)}>Jitter frequency</Range>
        <Range id="cdr-rj" bind:value={rjMui} min={0} max={50} step={1} output={`${rjMui} mUI`}>Random jitter</Range>
        <div class="row"><span>Pattern</span><Segmented size="sm" label="Data pattern" options={[{ value: 'prbs31', label: 'PRBS31' }, { value: 'prbs7', label: 'PRBS7' }, { value: 'cid', label: 'CID 72' }]} bind:value={pattern} /></div>
        <p class="hint">56 GBd NRZ · 1 UI = one bit = {nf(1e12 / BAUD, 2)} ps · {freqText(Math.abs(ppm) * 1e-6 * BAUD)} off · +ppm means the local clock is fast; ±300 ppm is a typical example (10,000 ppm = 1%)</p>
      </section>
      <section>
        <h2 class="label">CDR loop</h2>
        <div class="row"><span>Loop</span><Segmented size="sm" label="Clock recovery loop" options={[{ value: false, label: 'Off' }, { value: true, label: 'On' }]} bind:value={cdr} /></div>
        <Range id="cdr-kp" bind:value={kp} min={1} max={8} step={1} output={`${kp} step${kp > 1 ? 's' : ''}`}>Proportional gain</Range>
        <div class="row"><span>Integral path</span><Segmented size="sm" label="Integral path" options={[{ value: false, label: 'Off' }, { value: true, label: 'On' }]} bind:value={integral} /></div>
        {#if integral}<Range id="cdr-ki" bind:value={kiLog2} min={-9} max={-3} step={1} output={`1/${2 ** -kiLog2} step`}>Integral gain</Range>{/if}
        <div class="row"><span>Vote every</span><Segmented size="sm" mono label="Loop update interval in UI" options={[{ value: 1, label: '1' }, { value: 8, label: '8' }, { value: 16, label: '16' }, { value: 32, label: '32' }]} bind:value={decim} /></div>
        <Range id="cdr-lat" bind:value={latency} min={0} max={8} step={1} output={`${latency} vote${latency === 1 ? '' : 's'}`}>Loop latency</Range>
        <p class="hint">P-only slew ceiling: {kp}/({NPI} × {decim}) × 10⁶ = {int(pOnlyPpm)} ppm. Random data: about {int(randomDataPpm)} ppm; long runs of identical bits reduce tracking.</p>
      </section>
      <section>
        <h2 class="label">Playback</h2>
        <div class="row start">
          <button type="button" class="primary" aria-pressed={playing} onclick={() => (playing = !playing)}>{playing ? 'Pause' : 'Play'}</button>
          <button type="button" onclick={() => restart(shown === 'belt' ? 30 : 16000)}>Restart</button>
          <button type="button" aria-pressed={spin} onclick={() => { spin = !spin; scene?.setSpin(spin); }}>Auto-rotate</button>
          <button type="button" aria-pressed={labels} onclick={() => { labels = !labels; scene?.setLabels(labels); }}>Labels</button>
        </div>
        <Range id="cdr-speed" bind:value={() => Math.log10(speed), (x: number) => (speed = Number((10 ** x).toPrecision(2)))} min={0} max={4.2} step={0.01} output={`${int(speed)} bits/s`}>Speed</Range>
        <p class="hint">{slowText} times slower than the real link{speed > 40 ? ' · the belt now shows snapshots; the tunnel suits this speed' : ''}</p>
      </section>
      <section>
        <h2 class="label">Key</h2>
        {#if shown === 'belt'}
          <ul class="legend-list">
            <li><i class="blk"></i>tall block: a 1 · short block: a 0</li>
            <li><i style:background={COLORS.dataSampler}></i>where the reader looked, and the bit it read</li>
            <li><i style:background={COLORS.error}></i>looked too near an edge: the bit may be wrong (?)</li>
            <li><i class="bar" style:background={COLORS.early}></i>edge checker early: clock moves later</li>
            <li><i class="bar" style:background={COLORS.late}></i>edge checker late: clock moves earlier</li>
            <li><i class="bar" style:background="#9aa6b2"></i>same bit on both sides: no verdict</li>
          </ul>
        {:else}
          <ul class="legend-list">
            <li><i style:background={COLORS.early}></i>edge, clock early</li>
            <li><i style:background={COLORS.late}></i>edge, clock late</li>
            <li><i style:background={COLORS.error}></i>edge in keep-out: timing margin violated</li>
            <li><i class="bar" style:background="var(--ink)"></i>edge checker (recovered clock)</li>
            <li><i class="bar" style:background={COLORS.dataSampler}></i>reader, ½ UI later</li>
            <li><i class="band"></i>eye keep-out, ±{EYE_CLOSURE} UI</li>
          </ul>
          <p class="hint">Height is time, the angle is the position inside one UI. A clock error winds the edges into a helix; the loop turns the samplers with them.</p>
        {/if}
      </section>
    </aside>

    <div class="stage" bind:this={host}>
      {#if noGl}<p class="nogl">This view needs WebGL, which is turned off or unavailable in this browser.</p>{/if}
      <div class="views" role="group" aria-label="Camera views">
        {#each VIEWS as v (v.value)}<button type="button" aria-pressed={view === v.value} onclick={() => go(v.value)}>{v.label}</button>{/each}
      </div>
    </div>

    <aside class="scope" aria-label="Loop measurements">
      <div class="numbers">
        <div class="metric"><span class="label">Reader off-centre</span><span class="mono big">{nf(readout.rmsMui, 0)}</span><span class="unit">mUI rms</span></div>
        <div class="metric"><span class="label">Learned clock error</span><span class="mono big">{cdr && integral ? int(readout.ppm) : '—'}</span><span class="unit">ppm</span></div>
      </div>
      <p class="hint">Wrapped timing error, including random jitter. 1,000 mUI = 1 bit. The integral path estimates the clock offset.</p>
      <p class="hint">Model: ideal early/late decisions at known transitions, a 64-step phase interpolator, and a fixed 0.6 UI timing window. Analog slicer noise and Alexander three-sample logic are not simulated.</p>
      <div class="line">
        <span class="status" data-s={status.s}>{status.text}</span>
        <span class="counts mono">{int(readout.slips)} slips · {int(readout.errors)} margin violations / {int(readout.bits)} bits</span>
      </div>
      <div class="chart">
        <div class="cap"><span class="label">Phase tracking</span><span><i class="k1"></i>data edges <i class="k2"></i>recovered clock</span></div>
        <PhasePlot input={phasePlot.input} recovered={phasePlot.recovered} span={phasePlot.span} />
      </div>
      <p class="hint">Where the data edges are and where the loop puts its clock, in UI. Locked, the lines run together.</p>
      <div class="eyes">
        <figure><figcaption class="label">Eye · {cdr ? 'with CDR' : 'loop off'}</figcaption><canvas bind:this={eyeCanvas[0]} use:sized></canvas></figure>
        <figure><figcaption class="label">Eye · without</figcaption><canvas bind:this={eyeCanvas[1]} use:sized></canvas></figure>
      </div>
      <p class="hint">Every bit drawn on top of the others, lined up by the clock. An open eye in the middle gives the reader a clean place to look.</p>
      <div class="chart tall">
        <div class="cap"><span class="label">Jitter tolerance</span><span><i class="k1"></i>limit <i class="dot"></i>applied</span></div>
        <JtolPlot curve={jtol} {sjHz} {sjUipp} />
      </div>
      <p class="hint">{cdr ? 'Finite simulation with no timing-margin violations or cycle slips; not a BER guarantee. Fast jitter must fit inside the 0.6 UI opening. The crossover changes with loop gain, update interval and latency.' : 'Enable the CDR loop to calculate its jitter tolerance.'}</p>
    </aside>
  </section>
</main>

<style>
  .cdr { grid-template-rows: minmax(0, 1fr); }
  .work { display: grid; grid-template-columns: 290px minmax(0, 1fr) 320px; gap: 18px; min-height: 0; }
  .side, .scope { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
  .side { --accent: var(--brand); --accent-soft: var(--brand-soft); }
  .side section { display: grid; gap: 8px; padding: 12px 0; border-top: 1px solid var(--rule); }
  .side section:first-child { border-top: 0; padding-top: 2px; }
  .side h2 { margin: 0; }
  .side section :global(.range) { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'label out' 'input input'; align-items: center; gap: 5px 8px; }
  .side section :global(.range label) { grid-area: label; }
  .side section :global(.range input) { grid-area: input; width: 100%; }
  .side section :global(.range output) { grid-area: out; width: auto; text-align: right; }
  .side section.tour { gap: 10px; padding: 14px; margin-bottom: 4px; border: 0; border-radius: 10px; background: var(--plot); box-shadow: inset 0 0 0 1px var(--rule); }
  .tour-top { display: flex; align-items: center; justify-content: space-between; }
  .tour h2 { font: 600 17px/1.25 var(--sans); color: var(--ink); letter-spacing: -0.01em; }
  .tour p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--ink-2); }
  .tour p :global(b) { color: var(--ink); font-weight: 600; }
  .tour p :global(b.g) { color: var(--brand); }
  .tour p :global(b.o) { color: var(--s2); }
  .tour p :global(b.b) { color: var(--s1); }
  .tour .look { padding: 8px 10px; border-radius: 8px; background: var(--brand-soft); color: var(--ink); font-size: 13px; }
  .tour .look b { display: block; margin-bottom: 2px; font: 500 11px/1.3 var(--sans); letter-spacing: 0.09em; text-transform: uppercase; color: var(--brand); }
  .dots { display: flex; gap: 6px; }
  .dots button { width: 22px; height: 6px; padding: 0; border-radius: 3px; background: var(--rule); box-shadow: none; }
  .dots button[aria-current='step'] { background: var(--brand); }
  .nav { display: flex; justify-content: space-between; gap: 8px; }
  .nav button { min-width: 84px; }
  button.link { padding: 2px 4px; background: none; box-shadow: none; color: var(--ink-3); font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
  button.wide { width: 100%; padding: 10px; }
  button:disabled { opacity: 0.4; cursor: default; }
  .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--ink-2); }
  .row.start { justify-content: flex-start; gap: 6px; }
  .hint { margin: -2px 0 0; font: 11px/1.45 var(--mono); color: var(--ink-3); }
  .legend-list { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--ink-2); }
  .legend-list i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; vertical-align: -1px; }
  .legend-list i.bar { width: 4px; height: 13px; border-radius: 1px; margin: 0 10px 0 3px; vertical-align: -2px; }
  .legend-list i.blk { width: 7px; height: 13px; border-radius: 1px; margin-right: 2px; vertical-align: -2px; background: #8fa3bf; box-shadow: 9px 8px 0 -4px #4a5566; margin-right: 11px; }
  .legend-list i.band { width: 14px; height: 9px; border-radius: 2px; background: color-mix(in srgb, #f27d8a 30%, transparent); }
  .stage { position: relative; min-height: 0; overflow: hidden; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--rule); background: var(--plot); }
  .stage :global(.cdr-canvas) { position: absolute; inset: 0; display: block; touch-action: none; }
  .stage :global(.cdr-labels) { position: absolute; inset: 0; pointer-events: none; }
  .stage :global(.cdr-lbl) { position: relative; top: -14px; padding: 3px 7px; border-radius: 5px; background: color-mix(in srgb, var(--plot) 88%, transparent); box-shadow: 0 0 0 1px var(--rule); color: var(--ink); font: 500 11.5px/1.2 var(--sans); white-space: nowrap; transition: opacity 0.3s; }
  .stage :global(.cdr-lbl.tick) { top: 0; padding: 1px 5px; font: 500 11px var(--mono); color: var(--ink-2); }
  .stage :global(.cdr-lbl.reader) { color: var(--brand); box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 55%, transparent); }
  .stage :global(.cdr-bit) { font: 600 15px/1 var(--mono); color: var(--brand); text-shadow: 0 0 3px var(--plot), 0 0 6px var(--plot); }
  .stage :global(.cdr-bit.bad) { color: var(--bad); }
  .nogl { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 20px; color: var(--ink-2); text-align: center; }
  .views { position: absolute; z-index: 2; top: 10px; left: 10px; display: flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 8px; background: color-mix(in srgb, var(--plot) 86%, transparent); box-shadow: inset 0 0 0 1px var(--rule); }
  button { font: 500 12.5px/1 var(--sans); color: var(--ink-2); background: var(--plot); border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; white-space: nowrap; box-shadow: inset 0 0 0 1px var(--rule); }
  button:hover:not(:disabled) { color: var(--ink); }
  .views button { box-shadow: none; background: transparent; }
  button[aria-pressed='true'] { color: var(--ink); background: var(--brand-soft); box-shadow: inset 0 0 0 1px var(--brand); }
  button.primary { color: var(--ground); background: var(--brand); box-shadow: none; min-width: 58px; }
  button.primary:hover:not(:disabled) { color: var(--ground); filter: brightness(1.08); }
  .scope { gap: 10px; }
  .numbers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .metric { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 5px; }
  .metric .label { width: 100%; }
  .big { font-size: 24px; letter-spacing: -0.02em; color: var(--ink); }
  .unit { font-size: 12px; color: var(--ink-2); }
  .line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; padding: 3px 10px; border-radius: 999px; box-shadow: inset 0 0 0 1px currentColor; }
  .status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .status[data-s='good'] { color: var(--brand); }
  .status[data-s='warn'] { color: var(--s2); }
  .status[data-s='bad'] { color: var(--bad); }
  .counts { font-size: 11px; color: var(--ink-3); }
  .chart { display: flex; flex-direction: column; gap: 2px; height: 150px; flex: none; }
  .chart.tall { height: 170px; }
  .cap { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 10px; font-size: 12px; color: var(--ink-2); }
  .cap i { display: inline-block; width: 10px; height: 2px; margin: 0 5px 3px 8px; vertical-align: middle; }
  .cap i.dot { width: 8px; height: 8px; border-radius: 50%; margin-bottom: 0; background: var(--s2); }
  .k1 { background: var(--s1); }
  .k2 { background: var(--s2); }
  .eyes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; flex: none; }
  figure { margin: 0; display: grid; gap: 4px; }
  canvas { display: block; width: 100%; height: 92px; border-radius: 6px; background: var(--plot); box-shadow: inset 0 0 0 1px var(--rule); }
  .scope .hint { margin: -4px 0 2px; }
  @media (max-width: 1180px) { .work { grid-template-columns: 260px minmax(0, 1fr) 290px; gap: 14px; } }
  @media (max-width: 900px) {
    .work { grid-template-columns: minmax(0, 1fr); }
    .stage { order: -1; height: 62vh; min-height: 380px; }
    .side, .scope { overflow: visible; padding-right: 0; }
  }
</style>
