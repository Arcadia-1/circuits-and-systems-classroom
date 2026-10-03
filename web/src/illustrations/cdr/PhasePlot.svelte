<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import { niceStep } from '../../lib/scale';

  /** Input phase and recovered phase over the last `input.length` UI, oldest first, in UI. */
  let { input, recovered, span }: { input: Float32Array; recovered: Float32Array; span: number } = $props();
  const left = 54, right = 8, top = 18, bottom = 24;
  const range = $derived.by(() => {
    let lo = Infinity, hi = -Infinity;
    for (const arr of [input, recovered]) for (const v of arr) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) return { lo: -0.5, hi: 0.5 };
    const pad = Math.max(0.15, (hi - lo) * 0.12);
    return { lo: lo - pad, hi: hi + pad };
  });
  const ticks = $derived.by(() => {
    const span = range.hi - range.lo, step = niceStep(span / 4);
    const out: number[] = [];
    for (let v = Math.ceil(range.lo / step) * step; v <= range.hi; v += step) out.push(Number(v.toFixed(3)));
    return out;
  });
  const x = (i: number, n: number, w: number) => left + (i / Math.max(1, n - 1)) * Math.max(1, w - left - right);
  const y = (v: number, h: number) => top + ((range.hi - v) / (range.hi - range.lo)) * Math.max(1, h - top - bottom);
  const path = (arr: Float32Array, w: number, h: number) => {
    let d = '';
    for (let i = 0; i < arr.length; i++) d += `${i ? 'L' : 'M'}${x(i, arr.length, w).toFixed(1)},${y(arr[i], h).toFixed(1)}`;
    return d;
  };
</script>

<Plot label="Input phase and recovered clock phase over time">
  {#snippet children({ width: w, height: h })}
    {#if w > 0 && h > 60}
      <text class="tx" x={left} y="11">phase / UI</text>
      {#each ticks as v (v)}
        <line class="gr" x1={left} x2={w - right} y1={y(v, h)} y2={y(v, h)} />
        <text class="tx" text-anchor="end" x={left - 6} y={y(v, h) + 4}>{v}</text>
      {/each}
      <text class="tx" x={left} y={h - 4}>−{span.toLocaleString('en-US')} UI</text>
      <text class="tx" text-anchor="end" x={w - right} y={h - 4}>now</text>
      <path class="c1" d={path(input, w, h)} stroke-width="1.4" />
      <path class="c2" d={path(recovered, w, h)} stroke-width="1.8" />
    {/if}
  {/snippet}
</Plot>
