<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import { creditLimit, type LinkParams } from './model';

  /** Share of packet slots used against the credits, as the round trip allows it, with the value measured now. */
  let { p, measured }: { p: LinkParams; measured: number } = $props();
  const left = 36, right = 8, top = 8, bottom = 20, most = 32;
  const x = (c: number, w: number) => left + ((c - 1) / (most - 1)) * Math.max(1, w - left - right);
  const y = (v: number, h: number) => top + (1 - Math.min(1, Math.max(0, v))) * Math.max(1, h - top - bottom);
  const curve = $derived(Array.from({ length: most }, (_, i) => ({ c: i + 1, v: creditLimit({ ...p, credits: i + 1 }) })));
</script>

<Plot label="Share of the link used against advertised packet slots">
  {#snippet children({ width: w, height: h })}
    {#if w > 0 && h > 60}
      {#each [0, 0.25, 0.5, 0.75, 1] as v (v)}
        <line class="gr" x1={left} x2={w - right} y1={y(v, h)} y2={y(v, h)} />
        <text class="tx" text-anchor="end" x={left - 6} y={y(v, h) + 4}>{v * 100}%</text>
      {/each}
      {#each [1, 8, 16, 24, 32] as c (c)}
        <text class="tx" text-anchor={c === 1 ? 'start' : c === most ? 'end' : 'middle'} x={x(c, w)} y={h - 4}>{c}</text>
      {/each}
      <path class="c1" stroke-width="2" d={curve.map((q, i) => `${i ? 'L' : 'M'}${x(q.c, w).toFixed(1)},${y(q.v, h).toFixed(1)}`).join('')} />
      <circle class="f1" cx={x(p.credits, w)} cy={y(creditLimit(p), h)} r="3" />
      <circle class="f2" cx={x(p.credits, w)} cy={y(measured, h)} r="4.5" />
    {/if}
  {/snippet}
</Plot>
