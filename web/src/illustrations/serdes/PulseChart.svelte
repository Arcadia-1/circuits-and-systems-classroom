<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import { NFPOST, NFPRE, OS, type LinkAnalysis } from './model';

  let { a }: { a: LinkAnalysis } = $props();
  const left = 38, right = 10, top = 12, k0 = -3, k1 = 14;
  const at = (u: number) => a.adc[Math.round(a.tsOff + u * OS)] ?? 0;
  const span = $derived.by(() => {
    let lo = -0.05, hi = 0.05;
    for (let u = k0; u <= k1; u += 1 / OS) {
      const v = at(u);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return { lo: lo * 1.15, hi: hi * 1.18 };
  });
  const cursors = $derived(Array.from({ length: k1 - k0 + 1 }, (_, i) => ({ k: k0 + i, v: at(k0 + i) })));
  const x = (u: number, w: number) => left + ((u - k0) / (k1 - k0)) * Math.max(1, w - left - right);
  const y = (v: number, h: number) => top + ((span.hi - v) / (span.hi - span.lo)) * Math.max(1, h - top - 22);
  const curve = (w: number, h: number) => {
    let d = '';
    for (let u = k0; u <= k1 + 1e-9; u += 1 / OS) d += `${d ? 'L' : 'M'}${x(u, w).toFixed(1)},${y(at(u), h).toFixed(1)}`;
    return d;
  };
</script>

<Plot label="Pulse response at the ADC input with sampled cursors and the FFE span">
  {#snippet children({ width: w, height: h })}
    {#if w > 0 && h > 60}
      <rect class="a1" x={x(-NFPRE - 0.5, w)} y={top} width={x(NFPOST + 0.5, w) - x(-NFPRE - 0.5, w)} height={Math.max(1, h - top - 22)} />
      <text class="tx2" x={x((NFPOST - NFPRE) / 2, w)} y={top + 11} text-anchor="middle">FFE span</text>
      <line class="zero" x1={left} x2={w - right} y1={y(0, h)} y2={y(0, h)} />
      <text class="tx" text-anchor="end" x={left - 6} y={y(0, h) + 4}>0</text>
      <text class="tx" text-anchor="end" x={left - 6} y={y(cursors[3].v, h) + 4}>{cursors[3].v.toFixed(2)}</text>
      {#each [0, 5, 10] as u (u)}
        <text class="tx" text-anchor="middle" x={x(u, w)} y={h - 5}>{u ? `+${u} UI` : '0'}</text>
      {/each}
      <path class="c1" d={curve(w, h)} stroke-width="1.6" />
      {#each cursors as c (c.k)}
        <line class={c.k === 1 && a.dfe ? 'c2' : c.k === 0 ? 'c1' : 'cross'} x1={x(c.k, w)} x2={x(c.k, w)} y1={y(0, h)} y2={y(c.v, h)} />
        <circle class={c.k === 1 && a.dfe ? 'f2' : c.k === 0 ? 'f1' : 'ghost'} cx={x(c.k, w)} cy={y(c.v, h)} r={c.k === 0 ? 3.5 : 2.4} />
      {/each}
      {#if a.dfe}<text class="tx2" x={x(1, w) + 6} y={y(cursors[4].v, h) - 4}>DFE</text>{/if}
    {/if}
  {/snippet}
</Plot>
