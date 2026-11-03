<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import CoursePlot from '../../components/chart/CoursePlot.svelte';
  import Plot from '../../components/chart/Plot.svelte';
  import { nf } from '../../lib/format';
  import { linear, log10Scale, niceSpan } from '../../lib/scale';
  import {
    CYCLES, DEFAULTS, N_DIV, PRESETS, PS_PER_KHZ, SETTLED_FROM, SWEEP_BETAS, US_PER_CYCLE, dcoStepPs, detectorSlope,
    limitCyclePeriod, limitCyclePp, meanDecision, pullInKHz, simulate, stepPs, summarize, sweep, type BbSettings, type PresetKey,
  } from './model';

  let s = $state<BbSettings>({ ...DEFAULTS }), cursor = $state(0), playing = $state(true), speed = $state(450);
  let phaseView = $state<'run' | 'settled'>('run');
  const run = $derived(simulate(s));
  const m = $derived(summarize(run, s));
  const k = $derived(Math.max(0, Math.min(CYCLES - 1, Math.round(Number.isFinite(cursor) ? cursor : 0))));
  const step = $derived(stepPs(s)), pullIn = $derived(pullInKHz(s)), walk = $derived(dcoStepPs(s.dcoDbc));
  const sigma = $derived(s.noise ? s.refJitterPs : 0);

  // the sweep starts locked, so the offset does not change it
  const sweepKey = $derived(`${s.betaKHz}|${s.alphaKHz}|${s.latency}|${s.refJitterPs}|${s.dcoDbc}|${s.noise}`);
  const bathtub = $derived.by(() => {
    void sweepKey;
    return sweep(untrack(() => ({ ...s })));
  });
  const best = $derived(bathtub.reduce((a, b) => (b.noisyPs < a.noisyPs ? b : a)));

  const keys = Object.keys(PRESETS) as PresetKey[];
  const same = (a: BbSettings, b: BbSettings) => (Object.keys(b) as (keyof BbSettings)[]).every((key) => a[key] === b[key]);
  const active = $derived(keys.find((key) => same(s, PRESETS[key])) ?? null);
  const LABELS: Record<PresetKey, string> = { acquire: 'Acquire', limit: 'Limit cycle', latency: 'More latency', dither: 'Jitter dithers', pullin: 'Beyond pull-in', small: 'Step too small' };

  const status = $derived(
    run.slips > 0 ? { text: `Cycle slipping: ${run.slips} slip${run.slips === 1 ? '' : 's'} in ${CYCLES} cycles`, warn: true }
    : m.acquiredAt === null ? { text: 'Still acquiring at the end of the run', warn: true }
    : k < m.acquiredAt ? { text: `Acquiring frequency: slewing ${nf(s.alphaKHz, 1)} kHz per cycle`, warn: false }
    : m.settledAt !== null && k < m.settledAt ? { text: 'Paying back the phase error: the frequency overshoots', warn: false }
    : s.noise && step < walk ? { text: 'Slew-limited: each step is smaller than the DCO noise moves the edge', warn: true }
    : sigma > 0 ? { text: 'Locked: the limit cycle is dithered by jitter', warn: false }
    : { text: 'Locked: a bang-bang limit cycle', warn: false },
  );

  const t = (i: number) => i * US_PER_CYCLE;
  const freqPoints = $derived(Array.from(run.freq, (y, i) => ({ x: t(i), y })));
  const slowPoints = $derived(Array.from(run.integral, (y, i) => ({ x: t(i), y: s.offsetKHz + y })));
  /** The tightest four equal, round divisions that cover lo … hi, so the axis ticks are round numbers. */
  function niceDomain(lo: number, hi: number): [number, number] {
    const p = 10 ** Math.floor(Math.log10((hi - lo) / 4));
    for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
      const d = f * p, a = Math.floor(lo / d) * d;
      if (a + 4 * d >= hi) return [a, a + 4 * d];
    }
    return [lo, hi];
  }
  const freqDomain = $derived.by(() => {
    let lo = -1.5 * s.betaKHz, hi = 1.5 * s.betaKHz;
    for (const v of run.freq) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    return niceDomain(lo, hi);
  });
  const deepest = $derived(Math.min(...run.err.subarray(0, m.settledAt ?? CYCLES)));
  const phaseFrom = $derived(phaseView === 'run' ? 0 : SETTLED_FROM);
  const phasePoints = $derived(Array.from(run.err.subarray(phaseFrom), (y, i) => ({ x: t(i + phaseFrom), y })));
  const phaseSpan = $derived(niceSpan(Math.max(0.5, ...phasePoints.map((p) => Math.abs(p.y)))));

  // the detector's average answer against the error: the jitter turns the sign into erf; the dots average this run's decisions
  const detSpan = $derived(sigma > 0 ? Math.max(4 * sigma, 2 * step) : 3 * Math.max(step, 0.25));
  const detCurve = $derived(Array.from({ length: 161 }, (_, i) => { const e = -detSpan + (2 * detSpan * i) / 160; return { x: e, y: meanDecision(e, sigma) }; }));
  const signCurve = $derived([{ x: -detSpan, y: -1 }, { x: 0, y: -1 }, { x: 0, y: 1 }, { x: detSpan, y: 1 }]);
  const slopeLine = $derived(sigma > 0 ? [{ x: -1 / detectorSlope(sigma), y: -1 }, { x: 1 / detectorSlope(sigma), y: 1 }] : []);
  const detDots = $derived.by(() => {
    const bins = 16, sum = new Float64Array(bins), count = new Uint32Array(bins);
    for (let i = 0; i < CYCLES; i++) {
      const b = Math.floor(((run.err[i] + detSpan) / (2 * detSpan)) * bins);
      if (b < 0 || b >= bins) continue;
      sum[b] += run.decision[i];
      count[b]++;
    }
    return Array.from(sum, (v, b) => ({ x: -detSpan + ((b + 0.5) * 2 * detSpan) / bins, y: v / count[b], n: count[b] })).filter((p) => p.n >= 25);
  });

  onMount(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) playing = false;
    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (playing) {
        cursor = Math.min(CYCLES - 1, cursor + dt * speed);
        if (cursor === CYCLES - 1) playing = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });

  function preset(key: PresetKey) {
    s = { ...PRESETS[key] };
    speed = key === 'limit' || key === 'latency' ? 15 : 450;
    cursor = 0;
    playing = true;
  }

  /** The largest error in the strip's window, so its stems fill the height. */
  function windowSpan(k0: number, w: number): number {
    let v = 0.5 * step;
    for (let i = k0; i < k0 + w; i++) v = Math.max(v, Math.abs(run.err[i]), sigma > 0 ? Math.abs(run.seen[i]) : 0);
    return v;
  }
  const late = 'var(--s2)', early = 'var(--s1)';
  const ps = (v: number) => `${nf(v, Math.abs(v) >= 100 ? 0 : 2)} ps`;
</script>

<main class="course">
  <div class="toolbar">
    <p class="course-intro">A bang-bang PLL's phase detector answers one bit: late or early. Each answer moves the DCO by the same fixed step, however large the error was.</p>
    <div class="actions" aria-label="Bang-bang PLL examples">
      {#each keys as key}<button aria-pressed={active === key} onclick={() => preset(key)}>{LABELS[key]}</button>{/each}
    </div>
  </div>

  <section class="panel">
    <div class="flow" aria-label="Bang-bang PLL feedback path">
      <div><b>1 · Late or early? →</b><small>e = {ps(run.err[k])}; only its sign is kept</small><span class="value" style:color={run.decision[k] > 0 ? late : early}>{run.decision[k] > 0 ? 'late · +1' : 'early · −1'}</span></div>
      <div><b>2 · Digital P + I →</b><small>{s.alphaKHz > 0 ? `±${s.betaKHz} kHz now, ±${s.alphaKHz} kHz kept` : `±${s.betaKHz} kHz, no integral path`}; acts {s.latency} cycle{s.latency === 1 ? '' : 's'} later</small><span class="value">I = {nf(run.integral[k], 0)} kHz</span></div>
      <div><b>3 · DCO →</b><small>f − N·f_ref = offset + I ± β</small><span class="value">{nf(run.freq[k], 0)} kHz</span></div>
      <div><b>4 · Divide by {N_DIV} ↴</b><small>The edge moves −f·T_ref / f_out each cycle</small><span class="value">{nf(-PS_PER_KHZ * run.freq[k], 2)} ps</span></div>
    </div>
    <div class="return-path">← divided DCO edge returns to the detector ←</div>

    <div class="strip-key">
      <span><i style:background={late}></i>late → +1</span><span><i style:background={early}></i>early → −1</span>
      {#if sigma > 0}<span><i class="ring"></i>what the detector saw, with reference jitter</span>{/if}
      <span class="cycle">cycle {k}</span>
    </div>
    <div class="strip">
      <Plot label="Timing error, decision and applied correction for the cycles around the cursor">
        {#snippet children({ width, height })}
          {@const left = width < 520 ? 58 : 92}
          {@const right = width - 6}
          {@const w = Math.max(16, Math.min(64, Math.floor((right - left) / 11)))}
          {@const k0 = Math.max(0, Math.min(CYCLES - w, k - Math.floor(w * 0.7)))}
          {@const cell = (right - left) / w}
          {@const span = windowSpan(k0, w)}
          {@const eTop = 10}
          {@const eBottom = height - 82}
          {@const ey = linear(-span, span, eBottom, eTop)}
          {@const cx = (i: number) => left + (i - k0 + 0.5) * cell}
          {@const box = Math.min(cell - 2, 15)}
          {@const rowD = height - 58}
          {@const rowA = height - 24}
          <rect x={cx(k) - cell / 2} y="0" width={cell} height={height} fill="var(--brand-soft)" />
          <line class="zero" x1={left} x2={right} y1={ey(0)} y2={ey(0)} />
          <text class="tx" x={left - 8} y={eTop + 8} text-anchor="end">{ps(span)}</text>
          <text class="tx" x={left - 8} y={ey(0) + 4} text-anchor="end">e = 0</text>
          <text class="tx" x={left - 8} y={eBottom} text-anchor="end">{ps(-span)}</text>
          <text class="tx" x={left - 8} y={rowD + 4} text-anchor="end">{width < 520 ? 'bit' : 'decision'}</text>
          <text class="tx" x={left - 8} y={rowA + 4} text-anchor="end">{width < 520 ? `+${s.latency}` : `applied, D = ${s.latency}`}</text>
          {#each Array.from({ length: w }, (_, j) => k0 + j) as i (i)}
            {@const d = run.decision[i]}
            {@const applied = i >= s.latency ? run.decision[i - s.latency] : 0}
            <line x1={cx(i)} x2={cx(i)} y1={ey(0)} y2={ey(run.err[i])} stroke={d > 0 ? late : early} stroke-width={Math.max(1.5, Math.min(4, cell * 0.35))} />
            <circle cx={cx(i)} cy={ey(run.err[i])} r={Math.max(1.5, Math.min(3, cell * 0.25))} fill={d > 0 ? late : early} />
            {#if sigma > 0}<circle cx={cx(i)} cy={ey(run.seen[i])} r={Math.min(3.5, cell * 0.3)} fill="none" stroke="var(--ink-3)" />{/if}
            <rect x={cx(i) - box / 2} y={rowD - box / 2} width={box} height={box} rx="2" fill={d > 0 ? late : early} />
            {#if applied}
              <rect x={cx(i) - box / 2} y={rowA - box / 2} width={box} height={box} rx="2" fill={applied > 0 ? late : early} opacity="0.55" />
            {:else}
              <rect x={cx(i) - box / 2} y={rowA - box / 2} width={box} height={box} rx="2" fill="none" stroke="var(--rule)" />
            {/if}
          {/each}
          {#if k + s.latency < k0 + w}
            <path d="M{cx(k)},{rowD + box / 2 + 2} L{cx(k + s.latency)},{rowA - box / 2 - 3}" stroke="var(--brand)" stroke-width="2" fill="none" />
          {/if}
        {/snippet}
      </Plot>
    </div>
    <div class="toolbar">
      <span class="lock-status" class:warn={status.warn}>{status.text}</span>
      <span class="note">Each correction moves the edge by Δ = β·T_ref / f_out = {ps(step)} per cycle. The strip shows the cycles around the cursor; the arrow follows this cycle's decision to the DCO.</span>
    </div>
  </section>

  {#if active}
    <section class="panel story" aria-live="polite">
      {#if active === 'acquire'}
        <p><b>Slew, not exponential.</b> The DCO starts {nf(s.offsetKHz / 1000, 1)} MHz fast. Every decision says early, and a one-bit detector cannot say how early, so the integral path walks the frequency down by α = {s.alphaKHz} kHz per cycle: a straight ramp. The frequency error is gone after {m.acquiredAt} cycles, but by then the edge is {ps(Math.abs(deepest))} early. The decisions still say early, so the ramp runs on past zero until that phase is paid back, and turns again. The error settles after about {m.settledAt} cycles ({nf(t(m.settledAt ?? 0), 1)} µs).</p>
      {:else if active === 'limit'}
        <p><b>The error never rests at zero.</b> No noise and no integral path. Each correction is a whole step Δ = {ps(step)}, and it arrives {s.latency} cycle late, so the error overshoots and settles into a limit cycle of (2D + 1)·Δ = {ps(limitCyclePp(s))} peak to peak with a period of 4D + 2 = {limitCyclePeriod(s)} cycles. The animation runs slowly: watch the decisions in the strip.</p>
      {:else if active === 'latency'}
        <p><b>Latency makes it worse.</b> With D = {s.latency}, the loop keeps correcting in the old direction for {s.latency} more cycles after the error has changed sign. The limit cycle grows to (2D + 1)·Δ = {ps(limitCyclePp(s))} peak to peak, period {limitCyclePeriod(s)}.</p>
      {:else if active === 'dither'}
        <p><b>Jitter gives the detector a gain.</b> With {s.refJitterPs} ps of reference jitter, decisions near e = 0 become coin flips. On average the detector answers erf(e / σ√2): a linear detector with gain √(2/π)/σ = {nf(detectorSlope(s.refJitterPs), 2)} per ps, set by the noise rather than by the circuit. The loop then behaves like a linear PLL.</p>
      {:else if active === 'pullin'}
        <p><b>Beyond pull-in, it never locks.</b> The ramp needs the phase error to stay within half a reference period while the frequency slews down. That holds up to about β + √(2α·(T_ref/2)·f_out/T_ref) = {nf(pullIn / 1000, 1)} MHz. From {nf(s.offsetKHz / 1000, 1)} MHz the edge slips a whole cycle, the decisions flip, and the integral path gives back what it learned.</p>
      {:else if active === 'small'}
        <p><b>Too small a step cannot keep up.</b> Δ = {ps(step)} per cycle is less than the {ps(walk)} the DCO's own noise moves the edge each cycle. The error wanders until it is large enough for the steps to win: the left side of the bathtub below.</p>
      {/if}
    </section>
  {/if}

  <section class="panel controls" aria-label="Bang-bang PLL controls">
    <Range id="bb-beta" bind:value={s.betaKHz} min={25} max={1600} step={25} output={`${s.betaKHz} kHz`}>Proportional step β</Range>
    <Range id="bb-alpha" bind:value={s.alphaKHz} min={0} max={20} step={0.5} output={`${s.alphaKHz} kHz`}>Integral step α</Range>
    <div class="control"><span>Latency D (reference cycles)</span><Segmented label="Latency" options={[0, 1, 2, 3, 4].map((value) => ({ value, label: String(value) }))} bind:value={s.latency} /></div>
    <Range id="bb-offset" bind:value={s.offsetKHz} min={0} max={8000} step={100} output={`${nf(s.offsetKHz / 1000, 1)} MHz`}>Initial DCO frequency error</Range>
    <Range id="bb-ref" bind:value={s.refJitterPs} min={0} max={3} step={0.05} output={`${s.refJitterPs.toFixed(2)} ps`}>Reference jitter (rms)</Range>
    <Range id="bb-dco" bind:value={s.dcoDbc} min={-110} max={-80} step={1} output={`${s.dcoDbc} dBc/Hz`}>DCO noise at 1 MHz</Range>
    <div class="control"><span>Noise</span><Segmented label="Noise" options={[{ value: true, label: 'On' }, { value: false, label: 'Off' }]} bind:value={s.noise} /></div>
    <p class="note">f_ref = 100 MHz, N = {N_DIV}, f_out = 4 GHz. DCO noise random-walks the edge by {ps(walk)} rms per cycle. Pull-in ≈ {nf(pullIn / 1000, 2)} MHz.</p>
  </section>

  <div class="toolbar">
    <div class="actions">
      <button class="primary" onclick={() => { if (cursor >= CYCLES - 1) cursor = 0; playing = !playing; }}>{playing ? 'Pause' : 'Play'}</button>
      <button onclick={() => { cursor = 0; playing = false; }}>Restart</button>
      <Segmented label="Playback speed" options={[{ value: 15, label: 'Slow' }, { value: 450, label: 'Fast' }]} bind:value={speed} />
    </div>
    <div class="scrub"><Range id="bb-time" bind:value={cursor} onstart={() => (playing = false)} min={0} max={CYCLES - 1} step={1} output={`cycle ${k} · ${nf(t(k), 2)} µs`}>Inspect cycle</Range></div>
  </div>

  <div class="two">
    <section class="panel">
      <h2>Frequency: a ramp, then hopping ±β</h2>
      <div class="plot-box"><CoursePlot label="DCO frequency error versus time" xDomain={[0, t(CYCLES)]} yDomain={freqDomain} xLabel="time · µs" yLabel="f − N·f_ref · kHz" cursor={t(k)} series={[{ name: 'DCO', color: 'var(--brand)', points: freqPoints }, { name: 'offset + integral path', color: 'var(--s2)', dashed: true, points: slowPoints }]} /></div>
    </section>
    <section class="panel">
      <div class="head"><h2>Phase error at every reference edge</h2><Segmented size="sm" label="Phase error view" options={[{ value: 'run', label: 'Whole run' }, { value: 'settled', label: 'Second half' }]} bind:value={phaseView} /></div>
      <div class="plot-box"><CoursePlot label="Feedback minus reference edge time" xDomain={[t(phaseFrom), t(CYCLES)]} yDomain={[-phaseSpan, phaseSpan]} xLabel="time · µs" yLabel="e · ps" cursor={k >= phaseFrom ? t(k) : undefined} series={[{ name: 'e (late > 0)', color: 'var(--s1)', points: phasePoints }]} /></div>
      <p class="note">Second half: {ps(m.rmsPs)} rms, {ps(m.ppPs)} peak to peak.{s.noise ? '' : ` A proportional-only loop would give ${ps(limitCyclePp(s))} peak to peak.`}</p>
    </section>
  </div>

  <div class="two">
    <section class="panel">
      <h2>The detector: a sign, smoothed by jitter</h2>
      <div class="plot-box"><CoursePlot label="Average decision versus timing error" xDomain={[-detSpan, detSpan]} yDomain={[-1, 1]} xLabel="e · ps" yLabel="average decision" series={[
        { name: 'sign alone', color: 'var(--ink-3)', dashed: true, points: signCurve },
        ...(sigma > 0 ? [{ name: `erf(e / σ√2), σ = ${s.refJitterPs} ps`, color: 'var(--brand)', points: detCurve }, { name: 'slope √(2/π)/σ', color: 'var(--s1)', dashed: true, points: slopeLine }] : []),
        { name: 'this run, averaged per bin', color: 'var(--s2)', dots: true, points: detDots },
      ]} /></div>
      <p class="note">{sigma > 0 ? `With jitter the average answer grows smoothly with e: ${nf(detectorSlope(sigma), 2)} per ps near zero.` : 'Without jitter there is no gain to speak of: any error, however small, gives a full ±1.'}</p>
    </section>
    <section class="panel">
      <h2>Jitter against the step size</h2>
      <div class="chart">
        <div class="plot-key"><span><i style:background="var(--brand)"></i>rms jitter with noise</span><span><i style:background="var(--s1)"></i>limit cycle alone, no noise</span><span><i style:background="var(--s2)"></i>β now</span></div>
        <Plot label="Settled rms timing error versus proportional step">
          {#snippet children({ width, height })}
            {@const left = 48}
            {@const right = width - 14}
            {@const top = 22}
            {@const bottom = height - 36}
            {@const yMax = niceSpan(Math.max(...bathtub.map((p) => Math.max(p.noisyPs, p.cleanPs))))}
            {@const x = log10Scale(SWEEP_BETAS[0], SWEEP_BETAS[SWEEP_BETAS.length - 1], left, right)}
            {@const y = linear(0, yMax, bottom, top)}
            {#each [0, 1, 2, 3, 4] as i}
              <line x1={left} x2={right} y1={y((i * yMax) / 4)} y2={y((i * yMax) / 4)} stroke="var(--rule)" />
              <text class="tx" x={left - 8} y={y((i * yMax) / 4) + 4} text-anchor="end">{Number(((i * yMax) / 4).toPrecision(3))}</text>
            {/each}
            {#each SWEEP_BETAS as b}<text class="tx" x={x(b)} y={bottom + 17} text-anchor="middle">{b}</text>{/each}
            <text class="tx" x={left} y="12">rms e · ps</text>
            <text class="tx" x={right} y={height - 2} text-anchor="end">β · kHz (log)</text>
            {#if s.betaKHz >= SWEEP_BETAS[0] && s.betaKHz <= SWEEP_BETAS[SWEEP_BETAS.length - 1]}
              <line x1={x(s.betaKHz)} x2={x(s.betaKHz)} y1={top} y2={bottom} stroke="var(--s2)" stroke-dasharray="3 4" />
            {/if}
            <path d={bathtub.map((p, i) => `${i ? 'L' : 'M'}${x(p.betaKHz).toFixed(1)},${y(p.cleanPs).toFixed(1)}`).join(' ')} fill="none" stroke="var(--s1)" stroke-width="2" stroke-dasharray="5 4" />
            <path d={bathtub.map((p, i) => `${i ? 'L' : 'M'}${x(p.betaKHz).toFixed(1)},${y(p.noisyPs).toFixed(1)}`).join(' ')} fill="none" stroke="var(--brand)" stroke-width="2" />
            {#each bathtub as p}<circle cx={x(p.betaKHz)} cy={y(p.noisyPs)} r={p === best ? 5 : 3.5} fill={p === best ? 'var(--plot)' : 'var(--brand)'} stroke="var(--brand)" stroke-width="2" />{/each}
          {/snippet}
        </Plot>
      </div>
      <p class="note">{s.noise ? `Lowest of these at β = ${best.betaKHz} kHz (${ps(best.noisyPs)} rms). Smaller steps fall behind the DCO's random walk; larger ones make a larger limit cycle.` : 'With noise off only the limit cycle is left, and it shrinks with the step. Turn noise on to see the trade-off.'} Each point averages three noise seeds over 10 000 settled cycles, starting locked, with α/β kept at the current ratio.</p>
    </section>
  </div>

  <details>
    <summary>Model and related lessons</summary>
    <p>A cycle-by-cycle model at the reference rate. The timing error e is the divided DCO edge minus the reference edge. A DCO frequency error f moves the next edge by −f·T_ref / f_out, {PS_PER_KHZ} ps per kHz per cycle. The detector compares each reference edge with the nearest feedback edge, so e wraps at ±T_ref / 2 = ±5 ns: a cycle slip. Reference jitter is white and enters only at the detector; the DCO's white FM noise L(1 MHz) adds a random walk of (1 MHz / f_out)·√(10^(L/10) / f_ref) per cycle. The integral path acts with the same latency as the proportional path. Not modelled: DCO quantization and its ΣΔ dithering, detector metastability, frequency-acquisition aids and divider retiming. <code>python/pll_bang_bang.py</code> reproduces each run exactly and checks the limit-cycle, pull-in and erf formulas against the simulation.</p>
    <p>Start with a linear detector in the <a href="/pll/introduction/">PLL introduction</a>. The same one-bit detector recovers a receiver's clock in <a href="/serdes/clock-and-data-recovery/">Clock and data recovery</a>. Next: <a href="/pll/integer-vs-fractional/">Integer-N vs fractional-N</a>.</p>
  </details>
</main>

<style>
  .return-path { text-align: center; padding: 12px; margin: 8px 20px 0; border-bottom: 2px solid var(--brand); color: var(--brand); font: 12px var(--mono); }
  .strip-key, .plot-key { display: flex; flex-wrap: wrap; gap: 5px 18px; font-size: 12px; color: var(--ink-2); }
  .strip-key { margin-top: 18px; }
  .strip-key i, .plot-key i { display: inline-block; width: 12px; height: 3px; vertical-align: middle; margin-right: 6px; }
  .strip-key i.ring { width: 8px; height: 8px; border: 1px solid var(--ink-3); border-radius: 50%; }
  .strip-key .cycle { margin-left: auto; font-family: var(--mono); }
  .strip { height: 230px; display: flex; margin: 6px 0 12px; }
  .chart { height: 260px; display: flex; flex-direction: column; gap: 8px; }
  .head { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .head h2 { margin: 0; }
  .story p { margin: 0; max-width: 100ch; color: var(--ink-2); line-height: 1.65; }
  .story b { color: var(--ink); }
  .controls .note { grid-column: 1 / -1; }
  .two .note { margin-top: 10px; }
  .lock-status { color: var(--brand); font-size: 14px; font-weight: 600; }
  .lock-status.warn { color: var(--s2); }
  .scrub { width: min(450px, 100%); }
  @media (max-width: 600px) { .strip { height: 210px; } .strip-key .cycle { margin-left: 0; } }
</style>
