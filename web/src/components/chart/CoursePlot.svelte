<script lang="ts">
  import Plot from './Plot.svelte';
  let { label, series, xDomain, yDomain, xLabel, yLabel, cursor }: {
    label: string;
    series: { name: string; color: string; points: { x: number; y: number }[]; dashed?: boolean; dots?: boolean }[];
    xDomain: [number, number]; yDomain: [number, number]; xLabel: string; yLabel: string; cursor?: number;
  } = $props();
  const tick = (v: number) => Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toPrecision(3)).toString();
</script>

<div class="course-plot">
  <div class="plot-key">{#each series as s}{#if s.name}<span><i style:background={s.color}></i>{s.name}</span>{/if}{/each}</div>
  <Plot {label}>
    {#snippet children({ width, height })}
      {@const left = 48}
      {@const right = width - 14}
      {@const top = 22}
      {@const bottom = height - 36}
      {@const x = (v: number) => left + (v - xDomain[0]) / (xDomain[1] - xDomain[0]) * (right - left)}
      {@const y = (v: number) => bottom - (Math.max(yDomain[0], Math.min(yDomain[1], v)) - yDomain[0]) / (yDomain[1] - yDomain[0]) * (bottom - top)}
      {#each [0, 1, 2, 3, 4] as i}
        {@const yt = yDomain[0] + i * (yDomain[1] - yDomain[0]) / 4}
        {@const xt = xDomain[0] + i * (xDomain[1] - xDomain[0]) / 4}
        <line x1={left} x2={right} y1={y(yt)} y2={y(yt)} stroke="var(--rule)" />
        <text x={left - 8} y={y(yt) + 4} text-anchor="end">{tick(yt)}</text>
        <text x={x(xt)} y={bottom + 17} text-anchor="middle">{tick(xt)}</text>
      {/each}
      <text x={left} y={12}>{yLabel}</text>
      <text x={right} y={height - 2} text-anchor="end">{xLabel}</text>
      {#each series as s}
        {#if s.dots}
          {#each s.points as p}<circle cx={x(p.x)} cy={y(p.y)} r="3.5" fill={s.color} />{/each}
        {:else}
          <path d={s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`).join(' ')} fill="none" stroke={s.color} stroke-width="2" stroke-dasharray={s.dashed ? '5 4' : undefined} />
        {/if}
      {/each}
      {#if cursor !== undefined}<line x1={x(cursor)} x2={x(cursor)} y1={top} y2={bottom} stroke="var(--ink-3)" stroke-dasharray="3 4" />{/if}
    {/snippet}
  </Plot>
</div>

<style>
  .course-plot { height: 100%; min-height: 220px; display: flex; flex-direction: column; gap: 8px; }
  .plot-key { display: flex; flex-wrap: wrap; gap: 5px 18px; font-size: 12px; color: var(--ink-2); }
  .plot-key i { display: inline-block; width: 12px; height: 3px; vertical-align: middle; margin-right: 6px; }
  text { fill: var(--ink-3); font: 11px var(--mono); }
</style>
