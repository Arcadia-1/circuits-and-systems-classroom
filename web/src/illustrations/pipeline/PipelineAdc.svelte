<script lang="ts">
  import Notes from '../../components/ui/Notes.svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { clamp } from '../../lib/scale';
  import { nf } from '../../lib/format';
  import { idealCode, simulate, type StageResult } from './model';

  let vin = $state(0.37);
  let stageCount = $state(4);
  let shown = $state(4);
  let playing = $state(false);

  const result = $derived(simulate(vin, stageCount));
  const visible = $derived(Math.min(shown, stageCount));
  const code = $derived(idealCode(vin, stageCount));
  const lsb = $derived(2 / 2 ** stageCount);
  const signed = (value: number, digits = 3) => `${value >= 0 ? '+' : '−'}${nf(Math.abs(value), digits)}`;
  const flowStart = 130;
  const flowEnd = 930;
  const blockWidth = 168;
  const stageX = (index: number) => flowStart + ((index - 1) / Math.max(1, stageCount - 1)) * (flowEnd - flowStart);
  const pointX = (index: number) => 40 + (index / stageCount) * 500;
  const chartY = (value: number) => 119 - ((value + 1) / 2) * 88;

  function reset() { playing = false; shown = stageCount; }
  function step(delta: number) { playing = false; shown = clamp(visible + delta, 0, stageCount); }
  function play() { if (!playing && visible >= stageCount) shown = 0; playing = !playing; }
  $effect(() => {
    if (!playing) return;
    const id = setInterval(() => { if (shown < stageCount) shown += 1; else playing = false; }, 850);
    return () => clearInterval(id);
  });

  function signalPath(s: StageResult, i: number): string {
    const x0 = i === 0 ? 40 : pointX(i);
    const x1 = pointX(i + 1);
    const y0 = i === 0 ? chartY(vin) : chartY(result.stages[i - 1].residue);
    return `M${x0},${y0} L${x1},${chartY(s.residue)}`;
  }
</script>

<main class="page pipeline-page">
  <header class="topbar">
    <div class="brandline"><span class="kicker">PIPELINE ADC</span><span class="slash">/</span><span>1.5-bit stages</span></div>
    <h1>Residue in. Code out.</h1>
    <p class="intro">A pipeline ADC resolves the input a little at a time. Every stage removes a coarse decision, doubles the residue, and passes the unresolved signal forward.</p>
    <div class="tools">
      <Range id="pipeline-vin" min={-1} max={1} step={0.01} bind:value={vin} output={`${signed(vin, 2)} FS`} oncommit={reset}>
        {#snippet children()}Vin{/snippet}
      </Range>
      <div class="stage-control"><span class="label">Stages</span><Segmented size="sm" mono label="Pipeline stage count" options={[3, 4, 5].map((n) => ({ value: n, label: String(n) }))} bind:value={stageCount} /></div>
      <Notes>
        <p><b>One stage:</b> the sub-ADC chooses <var>−1</var>, <var>0</var> or <var>+1</var>. The DAC subtracts that coarse level, then the residue amplifier multiplies the remainder by two.</p>
        <p><b>Digital correction:</b> the redundant decisions are weighted as <var>d<sub>1</sub>/2 + d<sub>2</sub>/4 + …</var>. The final residue supplies the remaining fine correction.</p>
        <p>This is an ideal signal-path model. Settling error, comparator noise and capacitor mismatch are deliberately absent so the architecture is visible first.</p>
      </Notes>
    </div>
  </header>

  <section class="visual-card" aria-label="Pipeline ADC signal path">
    <div class="visual-head"><div><span class="label">Signal path</span><span class="subhead">Watch one sample move through the converter</span></div><div class="transport"><button type="button" onclick={() => step(-1)} aria-label="Previous stage">‹</button><button type="button" class="play" onclick={play}>{playing ? 'Pause' : visible >= stageCount ? 'Replay' : 'Play'}</button><button type="button" onclick={() => step(1)} aria-label="Next stage">›</button><span class="count">{visible}/{stageCount}</span></div></div>
    <svg class="flow" viewBox="0 0 1200 300" role="img" aria-label="Pipeline stages with sub ADC, DAC feedback and residue amplifier">
      <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--ink-3)" /></marker><marker id="arrow-active" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--brand)" /></marker></defs>
      <line class="rail" x1="40" y1="151" x2="1145" y2="151" />
      <g class="input-node"><circle cx="40" cy="151" r="29" /><text x="40" y="145" text-anchor="middle">VIN</text><text class="node-value" x="40" y="164" text-anchor="middle">{signed(vin, 2)}</text></g>
      {#each result.stages as s, i (s.index)}
        {@const x = stageX(s.index)}
        {@const active = i < visible}
        <line class:active class="signal" x1={i === 0 ? 69 : stageX(i) + blockWidth} y1="151" x2={x} y2="151" marker-end={active ? 'url(#arrow-active)' : 'url(#arrow)'} />
        <g class:active class:current={i === visible - 1} class="stage-box">
          <rect x={x} y="92" width={blockWidth} height="118" rx="12" />
          <text class="stage-number" x={x + 14} y="114">STAGE {s.index}</text><text class="stage-r" x={x + blockWidth - 14} y="114" text-anchor="end">r{s.index - 1} → r{s.index}</text>
          <rect class="unit" x={x + 8} y="130" width="46" height="47" rx="7" /><text x={x + 31} y="147" text-anchor="middle">sub-ADC</text><text class="decision" x={x + 31} y="168" text-anchor="middle">{s.decisionLabel}</text>
          <rect class="unit" x={x + 61} y="130" width="46" height="47" rx="7" /><text x={x + 84} y="147" text-anchor="middle">DAC</text><text class="dac" x={x + 84} y="168" text-anchor="middle">{signed(s.dac, 0)}</text>
          <rect class="unit amp" x={x + 114} y="130" width="46" height="47" rx="7" /><text x={x + 137} y="147" text-anchor="middle">residue</text><text class="amp-value" x={x + 137} y="168" text-anchor="middle">×2</text>
          <line class="feedback" x1={x + 84} y1="178" x2={x + 84} y2="197" /><line class="feedback" x1={x + 84} y1="197" x2={x + 31} y2="197" /><line class="feedback" x1={x + 31} y1="197" x2={x + 31} y2="178" />
          <text class="residue" x={x + blockWidth / 2} y="229" text-anchor="middle">{active ? `residue ${signed(s.residue, 3)}` : 'waiting'}</text>
        </g>
        {#if i < result.stages.length - 1}<line class:active class="forward" x1={x + blockWidth} y1="151" x2={stageX(s.index + 1)} y2="151" marker-end={active ? 'url(#arrow-active)' : 'url(#arrow)'} />{/if}
      {/each}
      <line class:active={visible >= stageCount} class="forward" x1={stageX(stageCount) + blockWidth} y1="151" x2="1110" y2="151" marker-end={visible >= stageCount ? 'url(#arrow-active)' : 'url(#arrow)'} />
      <g class="output-node"><rect x="1110" y="117" width="68" height="68" rx="12" /><text x="1144" y="140" text-anchor="middle">CODE</text><text class="code" x="1144" y="164" text-anchor="middle">{visible >= stageCount ? code : '···'}</text></g>
      <text class="flow-caption" x="40" y="270">sample</text><text class="flow-caption" x="600" y="270" text-anchor="middle">subtract · amplify · repeat</text><text class="flow-caption" x="1178" y="270" text-anchor="end">digital output</text>
    </svg>
    <div class="decision-strip">{#each result.stages as s, i (s.index)}<span class:active={i < visible} class="decision-chip"><small>d{s.index}</small><b>{i < visible ? s.decisionLabel : '·'}</b></span>{/each}<span class="chip-arrow">→</span><span class="code-chip"><small>{stageCount}-bit code</small><b>{visible >= stageCount ? code : '···'}</b></span></div>
  </section>

  <section class="bottom-grid">
    <div class="residue-card">
      <div class="card-title"><span><span class="label">Residue</span><b>What the next stage receives</b></span><span class="formula"><var>r<sub>i</sub> = 2r<sub>i−1</sub> − d<sub>i</sub></var></span></div>
      <svg class="residue-chart" viewBox="0 0 560 170" role="img" aria-label="Residue trajectory"><line class="chart-bound" x1="40" y1={chartY(1)} x2="540" y2={chartY(1)} /><line class="chart-zero" x1="40" y1={chartY(0)} x2="540" y2={chartY(0)} /><line class="chart-bound" x1="40" y1={chartY(-1)} x2="540" y2={chartY(-1)} /><text class="chart-label" x="31" y={chartY(1) + 4} text-anchor="end">+1</text><text class="chart-label" x="31" y={chartY(0) + 4} text-anchor="end">0</text><text class="chart-label" x="31" y={chartY(-1) + 4} text-anchor="end">−1</text>{#each result.stages as s, i (s.index)}<line class="chart-guide" x1={pointX(i + 1)} y1="20" x2={pointX(i + 1)} y2="137" />{#if i < visible}<path class="chart-path" d={signalPath(s, i)} />{/if}<circle class:muted={i >= visible} class="chart-point" cx={pointX(i + 1)} cy={chartY(s.residue)} r="5" />{/each}<circle class="chart-input" cx="40" cy={chartY(vin)} r="6" /><text class="input-text" x="40" y={chartY(vin) - 11} text-anchor="middle">vin</text>{#each result.stages as s, i (s.index)}<text class="stage-text" x={pointX(i + 1)} y="157" text-anchor="middle">r{s.index}</text>{/each}</svg>
    </div>
    <div class="decode-card">
      <div class="card-title"><span><span class="label">Digital correction</span><b>Redundant decisions, one result</b></span><span class="formula"><var>x = Σ d<sub>i</sub>/2<sup>i</sup> + r<sub>N</sub>/2<sup>N</sup></var></span></div>
      <div class="decode-list">{#each result.stages as s, i (s.index)}<div class:muted={i >= visible} class="decode-row"><span>d{s.index}</span><b>{i < visible ? s.decisionLabel : '·'}</b><span>/ 2<sup>{s.index}</sup></span><strong>{i < visible ? signed(s.contribution, 3) : '· · ·'}</strong></div>{/each}<div class:muted={visible < stageCount} class="decode-row final"><span>residue</span><b>{visible >= stageCount ? signed(result.finalResidue, 3) : '·'}</b><span>/ 2<sup>{stageCount}</sup></span><strong>{visible >= stageCount ? signed(result.residueCorrection, 4) : '· · ·'}</strong></div></div>
      <div class="result-row"><span><small>reconstructed input</small><b>{visible >= stageCount ? signed(result.reconstructed, 4) : 'waiting'}</b></span><span><small>{stageCount}-bit output</small><b class="blue">{visible >= stageCount ? code : '···'}</b></span><span><small>LSB</small><b>{nf(lsb, 3)} FS</b></span></div>
    </div>
  </section>
</main>

<style>
  .pipeline-page { max-width: 1480px; min-height: calc(100dvh - 49px); height: auto; padding-top: 24px; gap: 16px; }
  .topbar { display: grid; grid-template-columns: minmax(0, 1fr) max-content; column-gap: 36px; align-items: end; }.brandline { grid-column: 1 / -1; display: flex; gap: 9px; color: var(--ink-3); font: 11px var(--mono); letter-spacing: .07em; text-transform: uppercase; }.kicker { color: var(--brand); }.slash { color: var(--rule); } h1 { margin: 6px 0 0; font: 500 clamp(34px, 4.2vw, 58px)/.98 var(--math); letter-spacing: -.04em; }.intro { max-width: 650px; margin: 12px 0 0; color: var(--ink-2); font-size: 15px; line-height: 1.55; }.tools { grid-column: 2; grid-row: 2 / span 2; display: grid; justify-items: end; gap: 12px; }.tools :global(.range) { --range-width: 150px; }.stage-control { display: flex; align-items: center; gap: 9px; }
  .visual-card, .residue-card, .decode-card { border: 1px solid var(--rule); border-radius: 12px; background: var(--plot); }.visual-card { padding: 14px 16px 12px; }.visual-head, .card-title { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }.subhead { margin-left: 10px; color: var(--ink-3); font-size: 12px; }.transport { display: flex; align-items: center; gap: 5px; }.transport button { min-width: 29px; height: 27px; border: 1px solid var(--rule); background: var(--ground); color: var(--ink); border-radius: 6px; cursor: pointer; }.transport button:hover { border-color: var(--ink-3); }.transport .play { min-width: 62px; font-size: 12px; }.count { min-width: 4ch; color: var(--ink-3); font: 12px var(--mono); text-align: right; }.flow { display: block; width: 100%; height: auto; margin-top: 8px; }.rail { stroke: var(--rule); stroke-width: 2; }.signal, .forward { stroke: var(--ink-3); stroke-width: 1.5; }.signal.active, .forward.active { stroke: var(--brand); stroke-width: 2.5; }.input-node circle { fill: var(--s2-soft); stroke: var(--s2); stroke-width: 2; }.input-node text, .output-node text { fill: var(--ink-2); font: 10px var(--mono); letter-spacing: .04em; }.input-node .node-value, .output-node .code { fill: var(--ink); font-size: 14px; font-weight: 500; }.output-node rect { fill: var(--s1-soft); stroke: var(--s1); stroke-width: 2; }.stage-box { opacity: .38; transition: opacity .2s, transform .2s; }.stage-box.active { opacity: 1; }.stage-box.current { transform: translateY(-2px); }.stage-box > rect:first-child { fill: var(--ground); stroke: var(--rule); stroke-width: 1.5; }.stage-box.active > rect:first-child { stroke: var(--brand); }.stage-number, .stage-r { fill: var(--ink-3); font: 10px var(--mono); letter-spacing: .06em; }.unit { fill: var(--chip); stroke: var(--rule); }.stage-box text:not(.stage-number):not(.stage-r):not(.residue) { fill: var(--ink-3); font: 9px var(--sans); }.stage-box .decision, .stage-box .dac, .stage-box .amp-value { fill: var(--ink) !important; font: 500 17px var(--mono) !important; }.stage-box .amp { fill: var(--s2-soft); }.stage-box .residue { fill: var(--brand); font: 11px var(--mono); }.feedback { stroke: var(--s2); stroke-width: 1.2; fill: none; opacity: .8; }.flow-caption { fill: var(--ink-3); font: 10px var(--mono); letter-spacing: .06em; text-transform: uppercase; }.decision-strip { display: flex; justify-content: center; align-items: center; gap: 8px; border-top: 1px solid var(--rule-soft); padding-top: 11px; }.decision-chip, .code-chip { display: inline-flex; align-items: baseline; gap: 8px; padding: 6px 10px; border: 1px solid var(--rule); border-radius: 7px; background: var(--ground); opacity: .42; }.decision-chip.active { opacity: 1; border-color: var(--s1); }.decision-chip small, .code-chip small { color: var(--ink-3); font: 10px var(--mono); }.decision-chip b { color: var(--s1); font: 500 17px var(--mono); }.chip-arrow { color: var(--ink-3); }.code-chip { opacity: 1; border-color: var(--brand); }.code-chip b { color: var(--brand); font: 500 17px var(--mono); }
  .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }.residue-card, .decode-card { padding: 14px 16px; }.card-title b { display: block; margin-top: 3px; font-size: 15px; font-weight: 500; }.formula { color: var(--ink-2); font: 15px var(--math); white-space: nowrap; }.residue-chart { display: block; width: 100%; height: 195px; margin-top: 10px; border-top: 1px solid var(--rule-soft); }.chart-bound, .chart-zero { stroke: var(--rule); stroke-width: 1; stroke-dasharray: 4 4; }.chart-zero { stroke-dasharray: none; }.chart-guide { stroke: var(--rule-soft); }.chart-path { fill: none; stroke: var(--s1); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }.chart-point { fill: var(--brand); stroke: var(--plot); stroke-width: 2; }.chart-point.muted { fill: var(--ghost); }.chart-input { fill: var(--s2); stroke: var(--plot); stroke-width: 2; }.chart-label, .stage-text { fill: var(--ink-3); font: 10px var(--mono); }.input-text { fill: var(--s2); font: 11px var(--sans); }.decode-list { margin-top: 12px; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }.decode-row { display: grid; grid-template-columns: 62px 30px 64px 1fr; gap: 7px; align-items: baseline; padding: 8px 11px; border-bottom: 1px solid var(--rule-soft); color: var(--ink-3); font: 13px var(--mono); }.decode-row.final { grid-template-columns: 62px 72px 64px 1fr; }.decode-row:last-child { border-bottom: 0; }.decode-row b { color: var(--s1); font-size: 16px; }.decode-row strong { color: var(--ink); text-align: right; font-weight: 500; }.decode-row.muted { opacity: .4; }.decode-row.final b { color: var(--brand); }.result-row { display: grid; grid-template-columns: 1fr max-content max-content; gap: 18px; align-items: end; background: var(--chip); border-radius: 8px; padding: 11px 12px; margin-top: 10px; }.result-row span + span { border-left: 1px solid var(--rule); padding-left: 18px; }.result-row small { display: block; color: var(--ink-3); font-size: 10px; }.result-row b { display: block; margin-top: 2px; color: var(--brand); font: 500 20px var(--mono); }.result-row b.blue { color: var(--s1); }
  @media (max-width: 900px) { .pipeline-page { padding: 18px 16px 28px; }.topbar { grid-template-columns: 1fr; gap: 12px; }.tools { grid-column: 1; grid-row: auto; justify-items: start; width: 100%; }.tools :global(.range) { width: 100%; --range-width: 1fr; }.stage-control { width: 100%; justify-content: space-between; }.intro { font-size: 14px; }.visual-card { padding-inline: 10px; overflow: hidden; }.visual-head { align-items: start; }.subhead { display: block; margin: 4px 0 0; }.flow { min-width: 720px; transform-origin: left top; }.decision-strip { justify-content: flex-start; overflow-x: auto; padding-bottom: 2px; }.bottom-grid { grid-template-columns: 1fr; }.card-title { align-items: start; flex-direction: column; gap: 5px; }.formula { font-size: 14px; }.residue-chart { height: 180px; }.result-row { grid-template-columns: 1fr 1fr; }.result-row span:first-child { grid-column: 1 / -1; }.result-row span + span { border-left: 0; padding-left: 0; }.result-row span:last-child { border-left: 1px solid var(--rule); padding-left: 14px; } }
</style>
