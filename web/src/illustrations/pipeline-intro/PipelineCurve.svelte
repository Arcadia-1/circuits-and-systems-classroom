<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import { convert } from './model';
  import { prefix, residueSegments, transferSegments } from './curves';
  let { kind, input, stages, domain = [0, 1] }: {
    kind: 'resolved' | 'residue' | 'output'; input: number; stages: 1 | 2 | 3; domain?: [number, number];
  } = $props();
  const result = $derived(prefix(input, stages));
  const residue = $derived(convert(input).stages[stages - 1].residue);
  const levels = $derived(4 ** stages);
  const centre = $derived(kind === 'output');
  const value = $derived(kind === 'residue' ? residue : centre ? result.estimate : result.lower);
  const color = $derived(kind === 'residue' ? 'var(--s2)' : 'var(--s1)');
  const segments = $derived(kind === 'residue' ? [] : transferSegments(stages, centre));
  const ramps = $derived(kind === 'residue' ? residueSegments(stages as 1 | 2) : []);
  const yDomain = $derived<[number,number]>(kind === 'output' ? domain : [0, 1]);
  const label = $derived(kind === 'residue' ? `Stage ${stages} residue versus original input voltage` : kind === 'resolved' ? `Resolved lower edge after stage ${stages} versus input voltage` : `${2 * stages}-bit ADC transfer curve`);
  const tick = (v: number) => Number(v.toFixed(4)).toString();
</script>

<Plot {label}>
  {#snippet children({ width, height })}
    {@const left = 43}
    {@const right = width - 14}
    {@const top = 27}
    {@const bottom = height - 40}
    {@const x = (v: number) => left + (v - domain[0]) / (domain[1] - domain[0]) * (right - left)}
    {@const y = (v: number) => bottom - (v - yDomain[0]) / (yDomain[1] - yDomain[0]) * (bottom - top)}
    {@const activeX0 = Math.max(domain[0], result.lower)}
    {@const activeX1 = Math.min(domain[1], result.lower + 1 / levels)}
    <rect x={x(activeX0)} y={top} width={Math.max(0,x(activeX1)-x(activeX0))} height={bottom-top} fill={kind === 'residue' ? 'var(--s2-soft)' : 'var(--s1-soft)'} />
    {#each [0,1,2,3,4] as i}
      {@const xt = domain[0] + i * (domain[1] - domain[0]) / 4}
      {@const yt = yDomain[0] + i * (yDomain[1] - yDomain[0]) / 4}
      <line x1={left} x2={right} y1={y(yt)} y2={y(yt)} stroke="var(--grid)" />
      <line x1={x(xt)} x2={x(xt)} y1={top} y2={bottom} stroke="var(--grid)" />
      <text x={left-9} y={y(yt)+4} text-anchor="end">{tick(yt)}</text>
      <text x={x(xt)} y={bottom+19} text-anchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>{tick(xt)}</text>
    {/each}
    <text x={left} y={13} class="axis-label">{kind === 'residue' ? `r${stages === 1 ? '₁' : '₂'} · V` : kind === 'resolved' ? 'resolved input · V' : 'code centre · V'}</text>
    <text x={right} y={height-1} text-anchor="end" class="axis-label">original input Vᵢₙ · V</text>
    {#if kind !== 'residue'}
      <path d={`M${x(domain[0])},${y(domain[0])} L${x(domain[1])},${y(domain[1])}`} stroke="var(--ghost)" stroke-width="1.4" stroke-dasharray="5 5" fill="none" />
      {#each segments.filter(s => s.x1 > domain[0] && s.x0 < domain[1]) as segment}
        {@const a = Math.max(segment.x0,domain[0])}
        {@const b = Math.min(segment.x1,domain[1])}
        <path d={`M${x(a)},${y(segment.y)} H${x(b)}`} stroke={color} stroke-width="2.4" fill="none" />
        {#if segment.x1 < domain[1]}<line x1={x(segment.x1)} x2={x(segment.x1)} y1={y(segment.y)} y2={y(segment.y + 1/levels)} stroke={color} opacity=".3" stroke-width="1" stroke-dasharray="2 3" />{/if}
        {#if kind === 'resolved' || domain[1]-domain[0] < 1}
          <circle cx={x(a)} cy={y(segment.y)} r="2.5" fill={color} />
          <circle cx={x(b)} cy={y(segment.y)} r="2.5" fill={segment.x1 === 1 ? color : 'var(--plot)'} stroke={color} stroke-width="1.3" />
        {/if}
      {/each}
    {:else}
      {#each ramps as ramp}
        <path d={`M${x(ramp.x0)},${y(0)} L${x(ramp.x1)},${y(.25)}`} stroke="var(--ghost)" stroke-width="1.5" stroke-dasharray="4 4" fill="none" />
        <path d={`M${x(ramp.x0)},${y(0)} L${x(ramp.x1)},${y(1)}`} stroke={color} stroke-width="2.2" fill="none" />
        <circle cx={x(ramp.x0)} cy={y(0)} r="2.5" fill={color} />
        <circle cx={x(ramp.x1)} cy={y(1)} r="2.8" fill={ramp.x1 === 1 ? color : 'var(--plot)'} stroke={color} stroke-width="1.4" />
      {/each}
    {/if}
    <line x1={x(input)} x2={x(input)} y1={top} y2={bottom} stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 4" opacity=".7" />
    {#if kind === 'resolved'}
      <line x1={x(input)} x2={x(input)} y1={y(input)} y2={y(value)} stroke="var(--s2)" stroke-width="4" />
      <circle cx={x(input)} cy={y(input)} r="3" fill="var(--plot)" stroke="var(--ink-3)" stroke-width="1.5" />
    {/if}
    <line x1={left} x2={x(input)} y1={y(value)} y2={y(value)} stroke={color} stroke-dasharray="3 4" opacity=".35" />
    <circle cx={x(input)} cy={y(value)} r="6" fill={color} stroke="var(--plot)" stroke-width="2" />
    <text x={x(input)+(input > domain[0]+.73*(domain[1]-domain[0]) ? -11 : 11)} y={y(value)+(value > yDomain[1]-.14*(yDomain[1]-yDomain[0]) ? 19 : -12)} text-anchor={input > domain[0]+.73*(domain[1]-domain[0]) ? 'end' : 'start'} class="point-label" style:fill={color}>{value.toFixed(kind === 'output' ? 4 : 3)} V</text>
  {/snippet}
</Plot>

<style>
  text { fill:var(--ink-3); font:10px var(--mono); }
  .axis-label { font:10px var(--sans); }
  .point-label { font:500 12px var(--mono); paint-order:stroke; stroke:var(--plot); stroke-width:4px; stroke-linejoin:round; }
</style>
