<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import { NFPRE, PRE, type Analysis224g, type DetectorMode } from './model';

  let {
    a,
    detector,
  }: {
    a: Analysis224g;
    detector: DetectorMode;
  } = $props();

  let zoomTails = $state(false);
  let showRaw = $state(true);

  const left = 46, right = 14, top = 26, bot = 24;
  const k0 = -3, k1 = 38;

  const activeEq = $derived(
    detector === 'bypass' ? a.eqBypass : detector === 'ffe' ? a.eqFfe : a.eqPr1,
  );

  // Extract normalized post-EQ cursor k (with DFE subtracting k = +1 when detector === 'dfe')
  const afterEqAt = (k: number): number => {
    const idx = k - activeEq.kMin;
    if (idx < 0 || idx >= activeEq.effectiveCursors.length) return 0;
    if (detector === 'dfe' && k === 1) return 0;
    return activeEq.effectiveCursors[idx];
  };

  const ySpan = $derived(zoomTails ? { lo: -0.22, hi: 0.28 } : { lo: -0.28, hi: 1.12 });
  const xU = (u: number, w: number) => left + ((u - k0) / (k1 - k0)) * Math.max(1, w - left - right);
  const yV = (v: number, h: number) => {
    const c = Math.max(ySpan.lo, Math.min(ySpan.hi, v));
    return top + ((ySpan.hi - c) / (ySpan.hi - ySpan.lo)) * Math.max(1, h - top - bot);
  };

  const cursors = $derived(
    Array.from({ length: k1 - k0 + 1 }, (_, i) => {
      const k = k0 + i;
      return {
        k,
        raw: a.rawCursors[k + PRE] ?? 0,
        adc: a.adcCursors[k + PRE] ?? 0,
        eq: afterEqAt(k),
      };
    }),
  );

  const farBefore = $derived(Math.abs(a.adcCursors[a.farEchoUi + PRE] ?? 0));
  const farAfter = $derived(Math.abs(afterEqAt(a.farEchoUi)));

  // FFE tap weights chart bounds
  const tapMax = $derived.by(() => {
    let m = 0.25;
    for (let i = 0; i < activeEq.taps.length; i++) {
      if (i !== NFPRE) m = Math.max(m, Math.abs(activeEq.taps[i] / (activeEq.taps[NFPRE] || 1)));
    }
    return Math.min(1.2, Math.max(0.25, m * 1.18));
  });
  const yTap = (v: number, h: number) => {
    const c = Math.max(-tapMax, Math.min(tapMax, v));
    return 18 + ((tapMax - c) / (2 * tapMax)) * Math.max(1, h - 18 - 22);
  };

  const REGIONS = [
    { u0: -3.4, u1: -0.5, label: 'h(−1)', owner: 'TX/RX FFE', fill: 'rgba(36, 109, 193, 0.08)' },
    { u0: 0.5, u1: 1.5, label: 'h(+1)', owner: 'DFE', fill: 'rgba(179, 105, 22, 0.12)' },
    { u0: 1.5, u1: 14.5, label: 'Long tail', owner: 'RX FFE', fill: 'rgba(8, 127, 88, 0.07)' },
    { u0: 14.5, u1: 37.5, label: 'Far reflection', owner: 'Far FFE taps', fill: 'rgba(124, 77, 255, 0.08)' },
  ];
</script>

<section class="panel eq-pulse-panel" aria-label="224G pulse response equalizer division of labor and FFE tap weights">
  <div class="head-row">
    <div>
      <h2>3 · 224G pulse response: equalizer division of labor</h2>
      <p class="note">
        Echo @ <b class="mono">+{a.farEchoUi} UI</b>:
        <b class="mono">{(farBefore * 100).toFixed(1)}%</b> of h<sub>0</sub> at ADC →
        <b class="mono" class:good={farAfter < farBefore * 0.35} class:warn={farAfter >= farBefore * 0.35}>
          {(farAfter * 100).toFixed(1)}%
        </b> after {detector === 'bypass' ? 'bypass' : `${a.cfg.ffePostTaps + 4}-tap ${detector.toUpperCase()}`}
        {#if a.cfg.ffePostTaps < a.farEchoUi && detector !== 'bypass'}
          <span class="badge-warn">Outside {a.cfg.ffePostTaps + 4}-tap FFE span (+{a.cfg.ffePostTaps} UI max)</span>
        {/if}
      </p>
    </div>
    <div class="right-controls">
      <label class="chk"><input type="checkbox" bind:checked={showRaw} /> Raw channel</label>
      <Segmented
        size="sm"
        label="Vertical scale"
        options={[
          { value: false, label: 'Full h₀' },
          { value: true, label: 'Zoom tails (±0.25)' },
        ]}
        bind:value={zoomTails}
      />
    </div>
  </div>

  <div class="legend-strip">
    {#if showRaw}<span><i class="dash-g"></i>Raw channel (before TX FFE/CTLE)</span>{/if}
    <span><i style:background="var(--s2)"></i>Before RX DSP (at ADC)</span>
    <span><i style:background="var(--brand)"></i>After {detector === 'bypass' ? 'Bypass' : detector === 'ffe' ? `${a.cfg.ffePostTaps + 4}-tap FFE` : detector === 'dfe' ? 'FFE + 1-tap DFE' : 'FFE (1 + αD target for MLSE)'}</span>
  </div>

  <div class="pulse-box">
    <Plot label="224G single-pulse response cursors from -3 to +38 UI showing pre-cursor, main cursor, first post-cursor, long tail and far reflection">
      {#snippet children({ width: w, height: h })}
        {#if w > 0 && h > 70}
          {#each REGIONS as reg (reg.label)}
            <rect
              x={xU(reg.u0, w)}
              y={top}
              width={Math.max(1, xU(reg.u1, w) - xU(reg.u0, w))}
              height={Math.max(1, h - top - bot)}
              fill={reg.fill}
            />
            <text class="tx2" x={xU((reg.u0 + reg.u1) / 2, w)} y={12} text-anchor="middle" font-weight="600">{reg.label}</text>
            <text class="tx" x={xU((reg.u0 + reg.u1) / 2, w)} y={23} text-anchor="middle">{reg.owner}</text>
          {/each}

          {#each (zoomTails ? [-0.2, -0.1, 0, 0.1, 0.2] : [-0.2, 0, 0.5, 1.0]) as tick (tick)}
            <line class={tick === 0 ? 'zero' : 'gr'} x1={left} x2={w - right} y1={yV(tick, h)} y2={yV(tick, h)} />
            <text class="tx" text-anchor="end" x={left - 6} y={yV(tick, h) + 4}>{tick === 0 ? '0' : nf(tick, 1)}</text>
          {/each}

          {#each [0, 5, 10, 15, 20, 25, 30, 35] as u (u)}
            <text class="tx" text-anchor="middle" x={xU(u, w)} y={h - 6}>{u === 0 ? '0' : `+${u}`}</text>
          {/each}
          <text class="tx" text-anchor="end" x={w - right} y={h - 6}>UI</text>

          <!-- Dashed marker at far reflection UI -->
          <line x1={xU(a.farEchoUi, w)} x2={xU(a.farEchoUi, w)} y1={top} y2={h - bot} stroke="#7c4dff" stroke-width="1" stroke-dasharray="3 3" opacity="0.65" />

          {#if showRaw}
            <path
              d={cursors.map((c, i) => `${i ? 'L' : 'M'}${xU(c.k, w).toFixed(1)},${yV(c.raw, h).toFixed(1)}`).join('')}
              fill="none"
              stroke="var(--ink-3)"
              stroke-width="1.3"
              stroke-dasharray="4 3"
              opacity="0.7"
            />
          {/if}

          <!-- Before RX DSP (ADC cursors) -->
          {#each cursors as c (c.k)}
            <line x1={xU(c.k, w) - 1.5} x2={xU(c.k, w) - 1.5} y1={yV(0, h)} y2={yV(c.adc, h)} stroke="var(--s2)" stroke-width="1.6" opacity="0.7" />
            <circle cx={xU(c.k, w) - 1.5} cy={yV(c.adc, h)} r={c.k === 0 ? 3.2 : 2.1} fill="var(--s2)" opacity="0.75" />
          {/each}

          <!-- After active equalizer cursors -->
          {#each cursors as c (c.k)}
            {@const isPrTarget = detector === 'mlse' && c.k === 1}
            <line
              x1={xU(c.k, w) + 1.5}
              x2={xU(c.k, w) + 1.5}
              y1={yV(0, h)}
              y2={yV(c.eq, h)}
              stroke={isPrTarget ? '#7c4dff' : 'var(--brand)'}
              stroke-width="2"
            />
            <circle
              cx={xU(c.k, w) + 1.5}
              cy={yV(c.eq, h)}
              r={c.k === 0 ? 3.6 : isPrTarget ? 3.2 : 2.3}
              fill={isPrTarget ? '#7c4dff' : 'var(--brand)'}
            />
          {/each}

          {#if detector === 'mlse'}
            <text class="tx halo" x={xU(2.2, w)} y={Math.max(top + 14, yV(afterEqAt(1), h) - 4)} fill="#6d28d9">
              α = {a.eqPr1.b1.toFixed(2)} (MLSE target)
            </text>
          {:else if detector === 'dfe'}
            <text class="tx halo" x={xU(2.2, w)} y={yV(0, h) - 8} fill="var(--brand)">
              b₁ = {a.eqPr1.b1.toFixed(2)} subtracted
            </text>
          {/if}
        {/if}
      {/snippet}
    </Plot>
  </div>

  <!-- RX FFE tap weights bar chart aligned to the EXACT same UI horizontal axis -->
  <div class="taps-head">
    <span class="label">RX FFE tap weights (normalized to main tap w<sub>0</sub>) · {detector === 'bypass' ? 'DSP bypassed' : `${a.cfg.ffePostTaps + 4} taps (−3 … +${a.cfg.ffePostTaps} UI)`}</span>
    <span class="note">Gray area = taps beyond current FFE length</span>
  </div>
  <div class="taps-box">
    <Plot label="RX FFE equalizer tap weights from -3 to +38 UI showing main, long-tail and far reflection cancellation taps">
      {#snippet children({ width: w, height: h })}
        {#if w > 0 && h > 50}
          <!-- Unreachable span beyond current FFE post-cursor length -->
          {#if a.cfg.ffePostTaps < k1}
            <rect
              x={xU(a.cfg.ffePostTaps + 0.5, w)}
              y={14}
              width={Math.max(0, xU(k1 + 0.5, w) - xU(a.cfg.ffePostTaps + 0.5, w))}
              height={Math.max(1, h - 36)}
              fill="rgba(101, 116, 138, 0.13)"
            />
          {/if}
          <line class="zero" x1={left} x2={w - right} y1={yTap(0, h)} y2={yTap(0, h)} />
          <text class="tx" text-anchor="end" x={left - 6} y={yTap(0, h) + 4}>0</text>
          <text class="tx" text-anchor="end" x={left - 6} y={yTap(tapMax * 0.85, h) + 4}>+{nf(tapMax * 0.85, 2)}</text>
          <text class="tx" text-anchor="end" x={left - 6} y={yTap(-tapMax * 0.85, h) + 4}>{nf(-tapMax * 0.85, 2)}</text>
          <line x1={xU(a.farEchoUi, w)} x2={xU(a.farEchoUi, w)} y1={14} y2={h - 22} stroke="#7c4dff" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />

          {#each Array.from({ length: Math.min(k1, activeEq.nfPost) - k0 + 1 }, (_, i) => k0 + i) as k (k)}
            {@const rawW = activeEq.taps[k + NFPRE] / (activeEq.taps[NFPRE] || 1)}
            {@const isMain = k === 0}
            {@const isFar = Math.abs(k - a.farEchoUi) <= 2 && k >= 10}
            {@const barTop = isMain ? 16 : Math.min(yTap(0, h), yTap(rawW, h))}
            {@const barBot = isMain ? yTap(0, h) : Math.max(yTap(0, h), yTap(rawW, h))}
            <rect
              x={xU(k, w) - 3}
              y={barTop}
              width="6"
              height={Math.max(1.5, barBot - barTop)}
              rx="1.5"
              fill={isMain ? 'var(--s1)' : isFar ? '#7c4dff' : rawW >= 0 ? 'var(--brand)' : 'var(--bad)'}
              opacity={isMain ? 0.45 : 0.9}
            />
          {/each}

          {#each [0, 8, 16, 24, 32] as u (u)}
            <text class="tx" text-anchor="middle" x={xU(u, w)} y={h - 5}>{u === 0 ? 'w₀' : `+${u}`}</text>
          {/each}
        {/if}
      {/snippet}
    </Plot>
  </div>
</section>

<style>
  .eq-pulse-panel { display: grid; gap: 10px; }
  .head-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 10px 16px; }
  .head-row h2 { margin: 0 0 3px; }
  .head-row b { color: var(--ink); font-weight: 550; }
  .head-row b.good { color: var(--brand); }
  .head-row b.warn { color: var(--bad); }
  .badge-warn { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; font-size: 11px; font-weight: 500; }
  .right-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink-2); cursor: pointer; }
  .chk input { accent-color: var(--brand); margin: 0; }
  .legend-strip { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--ink-2); }
  .legend-strip span { display: inline-flex; align-items: center; gap: 6px; }
  .legend-strip i { display: inline-block; width: 12px; height: 3px; border-radius: 2px; }
  .legend-strip i.dash-g { background: repeating-linear-gradient(90deg, var(--ink-3) 0 4px, transparent 4px 7px); }
  .pulse-box { height: 245px; display: flex; }
  .taps-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px 12px; padding-top: 6px; border-top: 1px solid var(--rule-soft); }
  .taps-box { height: 122px; display: flex; }
</style>
