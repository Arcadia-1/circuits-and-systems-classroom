<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import type { EyeReadout } from './streams';

  let { histogram }: { histogram: EyeReadout['histogram'] } = $props();
  const peak = $derived(Math.max(1, ...histogram.counts));
  const x = (v: number, w: number) => 12 + (v / histogram.range + 1) * 0.5 * (w - 24);
  const bars = (w: number, h: number) => {
    const step = (w - 24) / histogram.counts.length, bottom = h - 23;
    let path = '';
    for (let i = 0; i < histogram.counts.length; i++) {
      const y = bottom - histogram.counts[i] / peak * (h - 49), left = 12 + i * step;
      path += `M${left},${bottom}V${y}h${step}V${bottom}Z`;
    }
    return path;
  };
</script>

<Plot label="Distribution of actual receiver decision samples; amplitude on the horizontal axis, sample count on the vertical axis">
  {#snippet children({ width: w, height: h })}
    <text class="tx2" x="12" y="14">sample count</text>
    <text class="tx" text-anchor="end" x={w - 12} y="14">peak {peak}</text>
    <path class="f1" d={bars(w, h)} opacity="0.75" />
    {#each [-2 / 3, 0, 2 / 3] as threshold (threshold)}
      <line class="c2" stroke-dasharray="3 3" x1={x(threshold, w)} x2={x(threshold, w)} y1="24" y2={h - 23} />
    {/each}
    <line class="zero" x1="12" x2={w - 12} y1={h - 23} y2={h - 23} />
    {#each [{ v: -1, label: '−1' }, { v: -1 / 3, label: '−⅓' }, { v: 1 / 3, label: '+⅓' }, { v: 1, label: '+1' }] as tick (tick.v)}
      <text class="tx" text-anchor="middle" x={x(tick.v, w)} y={h - 5}>{tick.label}</text>
    {/each}
  {/snippet}
</Plot>
