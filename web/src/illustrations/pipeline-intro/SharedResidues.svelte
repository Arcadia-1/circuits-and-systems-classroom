<script lang="ts">
  import { residueRamps } from './configurable';
  import { progressiveWindows } from './progressive';
  import { VOLTAGE_DOMAIN } from './display';
  import { actualResidueCurves, normalizeErrorSettings, type PipelineErrorSettings, type ErrorConversion, type LinearityAnalysis, type ResiduePoint } from './errors';

  let { bits, settings, analysis, conversion }: {
    bits: readonly number[];
    settings: PipelineErrorSettings;
    analysis: LinearityAnalysis;
    conversion: ErrorConversion;
  } = $props();

  type Domain = [number, number];
  type Row = { key: string; domain: Domain; actual: ResiduePoint[][]; ideal: ResiduePoint[][]; yDomain: readonly [number, number]; flash: boolean; bits: number; color: string; injected: boolean; gainError: number; nonlinearity: number };
  const id = $props.id();
  let width = $state(860), height = $state(630);
  const w = $derived(Math.max(1, width)), h = $derived(Math.max(1, height));
  const narrow = $derived(w < 480);
  const left = $derived(narrow ? 70 : 112);
  const right = $derived(Math.max(left + 1, w - (narrow ? 12 : 20)));
  const rowHeight = $derived(Math.max(bits.length, h - 20) / bits.length);
  const gap = $derived(Math.max(1, Math.min(26, rowHeight * (rowHeight < 42 ? 0.12 : 0.2))));
  const tickBand = $derived(Math.min(rowHeight * 0.32, rowHeight < 50 ? 10 : 12));
  const compressed = $derived(rowHeight < 65);
  const rowTop = (index: number) => index * rowHeight;
  const chartTop = (index: number) => rowTop(index) + Math.min(6, rowHeight * 0.09);
  const chartBottom = (index: number) => Math.max(chartTop(index) + 1, rowTop(index + 1) - gap - tickBand);
  const y = (value: number, index: number, domain: readonly [number, number]) => chartBottom(index) - (value - domain[0]) / (domain[1] - domain[0]) * (chartBottom(index) - chartTop(index));
  const format = (value: number) => String(Number(value.toPrecision(4)));
  const voltage = (value: number, span: number) => String(Number(value.toFixed(Math.min(9, Math.max(2, Math.ceil(-Math.log10(span / 4)) + 1)))));
  const windows = $derived(progressiveWindows(conversion, analysis));
  const stageErrors = $derived(normalizeErrorSettings(bits, settings));
  const errorKey = $derived(stageErrors.map(error => `${error.stage}:${error.gainError},${error.nonlinearity}`).join(';'));
  const x = (value: number, domain: Domain) => left + (value - domain[0]) / (domain[1] - domain[0]) * (right - left);

  // Only prefix crossings change these domains. Sweeping within a selected
  // interval reuses both model curves and SVG paths; only the sample moves.
  const rowCache = new Map<string, Row>();
  const pathCache = new Map<string, { actualPath: string; idealPath: string }>();
  function buildRow(index: number, domain: Domain): Row {
    const key = `${bits.join(',')}|${errorKey}|${index}|${domain.join(',')}`;
    const cached = rowCache.get(key);
    if (cached) return cached;
    const stageBits = bits[index], flash = index === bits.length - 1;
    const error = stageErrors[index];
    const injected = error !== undefined && (error.gainError !== 0 || error.nonlinearity !== 0);
    const actual: ResiduePoint[][] = [], ideal: ResiduePoint[][] = [];
    const yDomain = flash ? [0, 2 ** stageBits - 1] as const : VOLTAGE_DOMAIN;
    if (flash) {
      const gain = 2 ** stageBits;
      for (let code = 0; code < analysis.levels; code++) {
        const x0 = Math.max(domain[0], analysis.thresholds[code]), x1 = Math.min(domain[1], analysis.thresholds[code + 1]);
        if (x1 > x0) actual.push([{ x: x0, y: code % gain }, { x: x1, y: code % gain }]);
      }
      const first = Math.floor(domain[0] * analysis.levels), last = Math.min(analysis.levels - 1, Math.ceil(domain[1] * analysis.levels) - 1);
      for (let code = first; code <= last; code++) ideal.push([
        { x: Math.max(domain[0], code / analysis.levels), y: code % gain },
        { x: Math.min(domain[1], (code + 1) / analysis.levels), y: code % gain },
      ]);
    } else {
      actual.push(...actualResidueCurves(bits, settings, analysis, index, domain));
      for (const ramp of residueRamps(bits, index, domain)) ideal.push([{ x: ramp.x0, y: ramp.y0 }, { x: ramp.x1, y: ramp.y1 }]);
    }
    const row = { key, domain, actual, ideal, yDomain, flash, bits: stageBits, injected, gainError: error?.gainError ?? 0, nonlinearity: error?.nonlinearity ?? 0, color: flash ? '#aa710c' : injected ? '#c46a29' : '#008b91' };
    if (rowCache.size > 192) rowCache.clear();
    rowCache.set(key, row);
    return row;
  }

  function path(segments: ResiduePoint[][], index: number, row: Row): string {
    const commands: string[] = [];
    for (const segment of segments) {
      let start = true;
      for (const point of segment) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) { start = true; continue; }
        commands.push(`${start ? 'M' : 'L'}${x(point.x, row.domain).toFixed(2)},${y(point.y, index, row.yDomain).toFixed(2)}`);
        start = false;
      }
    }
    return commands.join(' ');
  }
  const geometry = $derived(windows.map((window, index) => {
    const row = buildRow(index, window.domain);
    const key = `${row.key}|${w}|${h}`;
    let paths = pathCache.get(key);
    if (!paths) {
      paths = { actualPath: path(row.actual, index, row), idealPath: path(row.ideal, index, row) };
      if (pathCache.size > 192) pathCache.clear();
      pathCache.set(key, paths);
    }
    // Keep every row's display values together. A shorter topology must never
    // let an old SVG row dereference an index in a newer conversion array.
    return { ...row, ...paths, stage: conversion.stages[index], window, input: conversion.input, nextDomain: windows[index + 1]?.domain ?? null };
  }));
  const boundedX = (value: number, domain: Domain) => Math.min(right, Math.max(left, x(value, domain)));
</script>

<div class="shared-residues" class:narrow class:compressed bind:clientWidth={width} bind:clientHeight={height}>
  <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
    <title id={`${id}-title`}>Progressive magnification through all {bits.length} pipeline stages</title>
    <desc id={`${id}-description`}>Every row plots the original ADC input in volts. Each row expands the selected input interval in the row above; numerical axis limits show the magnification. Amplifier rows have a fixed residue axis from {VOLTAGE_DOMAIN[0]} to {VOLTAGE_DOMAIN[1]} volts; the final row shows the flash digit on its code scale. Colored solid curves are actual, gray dashed curves ideal. Dots follow the same sample.</desc>
    <defs>
      {#each geometry as row, index}
        <clipPath id={`${id}-row-${index}`}><rect x={left - 1} y={chartTop(index) - 3} width={right - left + 2} height={Math.max(1, chartBottom(index) - chartTop(index) + 6)} /></clipPath>
      {/each}
    </defs>

    {#each geometry as row, index}
      {@const stage = row.stage}
      {@const value = row.flash ? stage.digit : stage.residue}
      {@const interval = row.window.selected ?? row.domain}
      {@const rowSpan = row.domain[1] - row.domain[0]}
      {@const cursorX = boundedX(row.input, row.domain)}
      {@const outside = value < row.yDomain[0] || value > row.yDomain[1]}
      {@const selectedLeft = boundedX(interval[0], row.domain)}
      {@const selectedRight = boundedX(interval[1], row.domain)}
      {#if row.injected}<rect class="injected-row" x="0" y={rowTop(index)} width={w} height={chartBottom(index) - rowTop(index) + 4} rx="4" />{/if}
      <g role="group" aria-label={`Stage ${index + 1}, ${row.bits} bits. Original input range ${row.domain[0]} to ${row.domain[1]} volts. ${row.flash ? `Flash digit axis 0 to ${row.yDomain[1]}.` : `Residue axis ${row.yDomain[0]} to ${row.yDomain[1]} volts.`} Sample ${row.input} volts; ${row.flash ? 'flash digit' : 'residue volts'} ${value}.${row.injected ? ` Gain error ${row.gainError} percent; nonlinearity ${row.nonlinearity} percent.` : ''}${row.window.boundaryOnly ? ' Boundary-only decision; finite ancestor context remains visible.' : ''}`}>
        <title>Stage {index + 1}: {row.flash ? 'final flash digit' : 'residue'} versus original Vin, {row.domain[0]}–{row.domain[1]} V{row.injected ? ` · gain error ${row.gainError}% · nonlinearity ${row.nonlinearity}%` : ''}</title>
        <text class="stage-label" x={narrow ? 4 : 8} y={chartTop(index) + (chartBottom(index) - chartTop(index)) * 0.4} style:fill={row.color}>{narrow ? 'S' : 'Stage '}{index + 1}</text>
        <text class="stage-detail" x={narrow ? 4 : 8} y={chartTop(index) + (chartBottom(index) - chartTop(index)) * 0.4 + (compressed ? 10 : 14)}>{row.bits}b · {row.flash ? narrow ? 'digit' : 'Flash digit' : narrow ? 'V' : 'residue V'}</text>
        <text class="y-tick" x={left - 7} y={chartTop(index)} dy=".32em" text-anchor="end">{format(row.yDomain[1])}</text>
        <text class="y-tick" x={left - 7} y={chartBottom(index)} dy=".32em" text-anchor="end">{format(row.yDomain[0])}</text>
        {#if !row.flash && chartBottom(index) - chartTop(index) >= 32}<text class="y-tick" x={left - 7} y={y(0.5,index,row.yDomain)} dy=".32em" text-anchor="end">0.5</text>{/if}
        <line class="baseline" x1={left} x2={right} y1={y(0,index,row.yDomain)} y2={y(0,index,row.yDomain)} />
        {#each [0, 0.5, 1] as fraction}
          {@const v = row.domain[0] + fraction * rowSpan}
          <line class="grid" x1={x(v, row.domain)} x2={x(v, row.domain)} y1={chartTop(index)} y2={chartBottom(index)} />
          <text class="x-tick" x={x(v, row.domain)} y={chartBottom(index) + Math.max(5, tickBand - 1)} text-anchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{voltage(v, rowSpan)}</text>
        {/each}
        <g clip-path={`url(#${id}-row-${index})`}>
          {#if row.nextDomain}
            {#if selectedRight > selectedLeft}<rect class="selected-interval" x={selectedLeft} y={chartTop(index)} width={selectedRight - selectedLeft} height={chartBottom(index) - chartTop(index)} />
            {:else}<line class="boundary" x1={selectedLeft} x2={selectedLeft} y1={chartTop(index)} y2={chartBottom(index)} />{/if}
          {/if}
          <path class="ideal" d={row.idealPath} />
          <path class="actual" style:stroke={row.color} d={row.actualPath} />
          <line class="cursor" x1={cursorX} x2={cursorX} y1={chartTop(index)} y2={chartBottom(index)} />
          {#if outside}
            {@const edge = value > row.yDomain[1] ? chartTop(index) : chartBottom(index)}
            {@const inward = (value > row.yDomain[1] ? 1 : -1) * Math.min(6, (chartBottom(index) - chartTop(index)) / 2)}
            <path class="overflow-marker" style:fill={row.color} d={`M${cursorX},${edge}L${cursorX - 4},${edge + inward}L${cursorX + 4},${edge + inward}Z`}><title>Actual residue {value} V is outside the fixed {row.yDomain[0]} to {row.yDomain[1]} V plot range.</title></path>
          {:else}
            <circle class="dot-halo" cx={cursorX} cy={y(value, index, row.yDomain)} r={compressed ? 3.8 : 5.2} />
            <circle class="dot" style:fill={row.color} cx={cursorX} cy={y(value, index, row.yDomain)} r={compressed ? 2.5 : 3.5} />
          {/if}
        </g>
      </g>
      {#if row.nextDomain}
        {@const zoom = row.window.zoom}
        {@const startY = chartBottom(index) + tickBand + 2}
        {@const endY = chartTop(index + 1) - 3}
        {@const labelY = startY + (endY - startY) * 0.57 + 3}
        {#if zoom !== null && selectedRight > selectedLeft && endY > startY}
          <path class="zoom-lens" d={`M${selectedLeft},${startY}L${selectedRight},${startY}L${right},${endY}L${left},${endY}Z`} />
          <path class="lens-edges" d={`M${selectedLeft},${startY}L${left},${endY}M${selectedRight},${startY}L${right},${endY}`} />
          {#if endY - startY >= 7}<text class="zoom-label" x={(left + right) / 2} y={labelY} text-anchor="middle">×{format(zoom)} zoom</text>{/if}
        {:else}
          {#if endY - startY >= 7}<text class="zoom-label" x={(left + right) / 2} y={labelY} text-anchor="middle">Boundary-only decision · wider context</text>{/if}
        {/if}
        {#if endY > startY}<line class="cursor-link" x1={cursorX} y1={startY} x2={boundedX(row.input, row.nextDomain)} y2={endY} />{/if}
      {/if}
    {/each}
    <text class="axis-title" x={right} y={h - 2} text-anchor="end">Every x axis: original Vin · V</text>
  </svg>
</div>

<style>
  .shared-residues { position: relative; width: 100%; height: 100%; min-width: 0; min-height: 0; background: #fff; }
  svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; overflow: hidden; }
  .injected-row { fill: #c46a29; fill-opacity: .04; }
  .grid { stroke: #c7d1d9; stroke-width: .8; stroke-dasharray: 2 4; opacity: .58; }
  .cursor { stroke: #374f63; stroke-width: 1; stroke-dasharray: 3 3; opacity: .5; }
  .baseline { stroke: #d7e0e6; stroke-width: .8; }
  .selected-interval { fill: #008b91; fill-opacity: .09; }
  .boundary { stroke: #008b91; stroke-width: 2; }
  .zoom-lens { fill: #008b91; fill-opacity: .055; }
  .lens-edges { stroke: #008b91; stroke-width: .8; stroke-opacity: .28; fill: none; }
  .cursor-link { stroke: #526c79; stroke-width: .8; stroke-dasharray: 2 3; opacity: .4; }
  .zoom-label { fill: #557982; font: 10px var(--mono, monospace); paint-order: stroke; stroke: #fff; stroke-width: 4; stroke-linejoin: round; }
  .stage-label { font: 600 12px var(--sans, sans-serif); }
  .stage-detail { fill: #798591; font: 9px var(--mono, monospace); }
  .y-tick { fill: #7b8996; font: 9px var(--mono, monospace); }
  .x-tick { fill: #6d7b88; font: 9px var(--mono, monospace); }
  .axis-title { fill: #526574; font: 10px var(--mono, monospace); }
  .actual, .ideal { fill: none; stroke-linejoin: round; stroke-linecap: round; }
  .actual { stroke-width: 1.6; }
  .ideal { stroke: #9aa5ae; stroke-width: 3.2; stroke-dasharray: 6 4; opacity: .9; }
  .dot-halo { fill: #fff; fill-opacity: .94; }
  .compressed .stage-label { font-size: 10px; }
  .compressed .stage-detail, .compressed .y-tick, .compressed .x-tick, .compressed .zoom-label { font-size: 8px; }
  .narrow .stage-label { font-size: 11px; }
  .narrow .stage-detail { font-size: 7.5px; }
  .narrow .x-tick, .narrow .axis-title, .narrow .zoom-label { font-size: 8px; }
</style>
