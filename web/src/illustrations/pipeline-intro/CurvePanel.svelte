<script lang="ts">
  type Point = { x: number; y: number };
  type Series = { points: Point[]; ghost?: boolean };
  let { title, detail, color, xDomain, yDomain, xLabel, yLabel, series, marker, vertical, zero = true }: {
    title: string;
    detail?: string;
    color: string;
    xDomain: [number, number];
    yDomain: [number, number];
    xLabel: string;
    yLabel: string;
    series: Series[];
    marker?: Point;
    vertical?: number;
    zero?: boolean;
  } = $props();

  const id = $props.id();
  let width = $state(640), height = $state(150);
  const w = $derived(Math.max(1, width));
  const h = $derived(Math.max(1, height));
  const xSpan = $derived(Math.max(Number.EPSILON, xDomain[1] - xDomain[0]));
  const ySpan = $derived(Math.max(Number.EPSILON, yDomain[1] - yDomain[0]));
  const narrow = $derived(w < 350);
  const left = $derived(Math.max(narrow ? 48 : 58,
    ...[yDomain[0], yDomain[0] + ySpan / 2, yDomain[1]].map(value => tick(value, ySpan).length * 5.8 + 12)));
  const right = $derived(Math.max(left + 1, w - (narrow ? 16 : 23)));
  const top = $derived(h < 130 ? 15 : 19);
  const bottom = $derived(Math.max(top + 1, h - 35));
  const xFractions = $derived(narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]);
  const yFractions = [0, 0.5, 1];
  const x = (value: number) => left + (value - xDomain[0]) / xSpan * (right - left);
  const y = (value: number) => bottom - (value - yDomain[0]) / ySpan * (bottom - top);

  function tick(value: number, span: number): string {
    if (!Number.isFinite(value)) return '';
    const decimals = Math.min(8, Math.max(0, Math.ceil(-Math.log10(span / 4)) + 1));
    const rounded = Number(value.toFixed(decimals));
    return Object.is(rounded, -0) ? '0' : String(rounded);
  }

  /** One M command per independent segment preserves true discontinuities. */
  function path(ghost: boolean): string {
    const parts: string[] = [];
    for (const segment of series) {
      if (Boolean(segment.ghost) !== ghost) continue;
      let start = true;
      for (const point of segment.points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) { start = true; continue; }
        parts.push(`${start ? 'M' : 'L'}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`);
        start = false;
      }
    }
    return parts.join(' ');
  }

  const actualPath = $derived(path(false));
  const ghostPath = $derived(path(true));
  const markerVisible = $derived(marker !== undefined && Number.isFinite(marker.x) && Number.isFinite(marker.y)
    && marker.x >= xDomain[0] && marker.x <= xDomain[1] && marker.y >= yDomain[0] && marker.y <= yDomain[1]);
  const markerText = $derived(marker ? String(Number(marker.y.toPrecision(5))) : '');
  const labelWidth = $derived(Math.max(35, markerText.length * 6.2 + 12));
  const labelX = $derived(marker ? Math.min(right - labelWidth, Math.max(left, x(marker.x) + (x(marker.x) + labelWidth + 12 > right ? -labelWidth - 10 : 10))) : left);
  const labelY = $derived(marker ? Math.min(bottom - 17, Math.max(top + 2, y(marker.y) - 23)) : top);
</script>

<section class="curve-panel" style:--curve-color={color} aria-label={title}>
  <header><h3><i></i>{title}</h3>{#if detail}<span class="detail">{detail}</span>{/if}</header>
  <div class="chart" bind:clientWidth={width} bind:clientHeight={height}>
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{title}</title>
      <desc id={`${id}-description`}>{xLabel}: {xDomain[0]} to {xDomain[1]}. {yLabel}: {yDomain[0]} to {yDomain[1]}.{detail ? ` ${detail}.` : ''}{markerVisible && marker ? ` Selected point: ${marker.x}, ${marker.y}.` : ''}</desc>
      <defs><clipPath id={`${id}-clip`}><rect x={left - 1} y={top - 1} width={right - left + 2} height={bottom - top + 2} /></clipPath></defs>

      {#each yFractions as fraction}
        {@const value = yDomain[0] + fraction * ySpan}
        <line class="grid" x1={left} x2={right} y1={y(value)} y2={y(value)} />
        <text class="tick" x={left - 8} y={y(value)} dy=".34em" text-anchor="end">{tick(value, ySpan)}</text>
      {/each}
      {#each xFractions as fraction}
        {@const value = xDomain[0] + fraction * xSpan}
        <line class="grid vertical-grid" x1={x(value)} x2={x(value)} y1={top} y2={bottom} />
        <text class="tick" x={x(value)} y={bottom + 14} text-anchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{tick(value, xSpan)}</text>
      {/each}
      <text class="axis-title" x={left} y={11}>{yLabel}</text>
      <text class="axis-title" x={right} y={h - 3} text-anchor="end">{xLabel}</text>

      <g clip-path={`url(#${id}-clip)`}>
        {#if zero && yDomain[0] <= 0 && yDomain[1] >= 0}<line class="zero" x1={left} x2={right} y1={y(0)} y2={y(0)} />{/if}
        {#if ghostPath}<path class="ghost-curve" d={ghostPath} />{/if}
        {#if actualPath}<path class="actual-curve" d={actualPath} />{/if}
        {#if vertical !== undefined && Number.isFinite(vertical)}<line class="cursor" x1={x(vertical)} x2={x(vertical)} y1={top} y2={bottom} />{/if}
        {#if markerVisible && marker}
          <circle class="marker-halo" cx={x(marker.x)} cy={y(marker.y)} r="6.5" />
          <circle class="marker" cx={x(marker.x)} cy={y(marker.y)} r="3.7" />
        {/if}
      </g>
      {#if markerVisible && marker && right - left > labelWidth + 35 && bottom - top > 45}
        <g aria-hidden="true">
          <rect class="marker-label-bg" x={labelX} y={labelY} width={labelWidth} height="17" rx="4" />
          <text class="marker-label" x={labelX + 6} y={labelY + 12}>{markerText}</text>
        </g>
      {/if}
    </svg>
  </div>
</section>

<style>
  .curve-panel { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; color: var(--ink, #202c38); }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex: 0 0 auto; min-width: 0; padding: 0 2px 5px; }
  h3 { display: flex; align-items: center; gap: 7px; margin: 0; min-width: 0; font: 600 12px/1.3 var(--sans, sans-serif); }
  h3 i { display: inline-block; width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--curve-color); }
  .detail { min-width: 0; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3, #71808e); font: 10px/1.3 var(--mono, monospace); }
  .chart { position: relative; flex: 1 1 0; min-width: 0; min-height: 0; }
  svg { display: block; position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; }
  .grid { stroke: var(--rule, #dde3e8); stroke-width: .7; }
  .vertical-grid { opacity: .65; }
  .zero { stroke: var(--ink-3, #71808e); opacity: .4; stroke-width: .9; }
  .tick, .axis-title { fill: var(--ink-3, #71808e); font: 9.5px var(--mono, monospace); }
  .axis-title { font-size: 9px; }
  .actual-curve, .ghost-curve { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .actual-curve { stroke: var(--curve-color); stroke-width: 1.9; }
  .ghost-curve { stroke: var(--ink-3, #71808e); opacity: .47; stroke-width: 1.1; stroke-dasharray: 4 3; }
  .cursor { stroke: var(--curve-color); stroke-width: 1; stroke-dasharray: 2 4; opacity: .55; }
  .marker-halo { fill: var(--plot, #fff); opacity: .92; }
  .marker { fill: var(--curve-color); }
  .marker-label-bg { fill: var(--plot, #fff); fill-opacity: .96; }
  .marker-label { fill: var(--curve-color); font: 10px var(--mono, monospace); }
</style>
