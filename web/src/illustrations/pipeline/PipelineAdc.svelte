<script lang="ts">
  import Notes from '../../components/ui/Notes.svelte';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { clamp } from '../../lib/scale';
  import { nf } from '../../lib/format';
  import { idealCode, simulate, THRESHOLD, type StageResult } from './model';

  let vin = $state(0.37);
  let stageCount = $state(4);
  let shown = $state(4);
  let playing = $state(false);

  const result = $derived(simulate(vin, stageCount));
  const visible = $derived(Math.min(shown, stageCount));
  const code = $derived(idealCode(vin, stageCount));
  const lsb = $derived(2 / 2 ** stageCount);
  const signed = (value: number, digits = 3) => `${value >= 0 ? '+' : '−'}${nf(Math.abs(value), digits)}`;

  function reset() {
    playing = false;
    shown = stageCount;
  }

  function step(delta: number) {
    playing = false;
    shown = clamp(visible + delta, 0, stageCount);
  }

  function play() {
    if (!playing && visible >= stageCount) shown = 0;
    playing = !playing;
  }

  $effect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      if (shown < stageCount) shown += 1;
      else playing = false;
    }, 900);
    return () => clearInterval(id);
  });

  function sx(value: number): number {
    return 42 + ((value + 1) / 2) * 456;
  }

  function sy(value: number): number {
    return 116 - ((value + 1) / 2) * 82;
  }

  function residuePath(stage: StageResult): string {
    const x0 = 42 + ((stage.index - 1) / stageCount) * 456;
    const x1 = 42 + (stage.index / stageCount) * 456;
    return `M${x0},${sy(stage.input)} L${x0 + (x1 - x0) * 0.48},${sy(stage.dac)} L${x1},${sy(stage.residue)}`;
  }
</script>

<main class="page pipeline-page">
  <header class="top">
    <div>
      <div class="eyebrow">Pipeline ADC · residue amplifier</div>
      <h1>One coarse decision, repeated with the residue</h1>
      <p class="dek">A pipeline ADC resolves the input a little at a time. Each 1.5-bit stage subtracts a coarse DAC level, doubles what remains, and hands that residue to the next stage.</p>
    </div>
    <div class="pick controls">
      <Range id="vin" min={-1} max={1} step={0.01} bind:value={vin} output={`${signed(vin, 2)} FS`} oncommit={reset}>
        {#snippet children()}Input voltage{/snippet}
      </Range>
      <div class="stage-picker">
        <span class="label">Stages</span>
        <Segmented size="sm" mono label="Pipeline stage count" options={[3, 4, 5].map((n) => ({ value: n, label: String(n) }))} bind:value={stageCount} />
      </div>
    </div>
    <Notes>
      <p><b>1.5-bit stage.</b> The sub-ADC has three decisions: <var>−1</var>, <var>0</var> and <var>+1</var>. The thresholds are <var>±0.25</var> of the stage's normalized full-scale range.</p>
      <p><b>Residue equation.</b> Each stage computes <var>r<sub>i</sub> = 2r<sub>i−1</sub> − d<sub>i</sub></var>. The factor of two is the residue amplifier; the DAC feedback removes the part already resolved.</p>
      <p><b>Digital correction.</b> The redundant decisions are weighted as <var>d<sub>1</sub>/2 + d<sub>2</sub>/4 + …</var>. The last residue is the remaining fine correction, so <var>x = Σd<sub>i</sub>/2<sup>i</sup> + r<sub>N</sub>/2<sup>N</sup></var>.</p>
      <p>This is an ideal behavioural model: no settling error, comparator noise, capacitor mismatch or interstage gain error. Those are the non-idealities to add after the signal path is clear.</p>
    </Notes>
  </header>

  <section class="stage-strip" aria-label="Pipeline stages">
    <div class="strip-head">
      <div>
        <span class="label">Signal path</span>
        <span class="hint">The highlighted stages have already processed the sample.</span>
      </div>
      <div class="transport">
        <button type="button" onclick={() => step(-1)} aria-label="Previous stage">‹</button>
        <button type="button" class="play" onclick={play}>{playing ? 'Pause' : visible >= stageCount ? 'Replay' : 'Play'}</button>
        <button type="button" onclick={() => step(1)} aria-label="Next stage">›</button>
        <span class="count">{visible}/{stageCount}</span>
      </div>
    </div>
    <div class="stages">
      <div class="source-node">
        <span class="node-tag">sample</span>
        <b>{signed(vin, 3)} FS</b>
        <small>input</small>
      </div>
      {#each result.stages as s, i (s.index)}
        <div class:active={i < visible} class:current={i === visible - 1} class="stage-card">
          <div class="stage-title"><span>Stage {s.index}</span><span class="stage-kind">1.5 bit</span></div>
          <div class="stage-flow">
            <div class="mini-block"><small>sub-ADC</small><b class:negative={s.decision < 0} class:positive={s.decision > 0}>{s.decisionLabel}</b></div>
            <span class="arrow">→</span>
            <div class="mini-block"><small>DAC</small><b>{signed(s.dac, 0)}</b></div>
            <span class="arrow">→</span>
            <div class="mini-block gain"><small>× 2</small><b>{visible > i ? signed(s.residue, 3) : '· · ·'}</b></div>
          </div>
          <div class="stage-foot"><span>r{s.index - 1} = {signed(s.input, 3)}</span><span>r{s.index} = {visible > i ? signed(s.residue, 3) : 'waiting'}</span></div>
        </div>
      {/each}
    </div>
  </section>

  <section class="analysis">
    <div class="residue-panel panel-box">
      <div class="panel-head"><div><span class="label">Residue trajectory</span><h2>Every stage recentres the unresolved part</h2></div><span class="formula"><var>r<sub>i</sub> = 2r<sub>i−1</sub> − d<sub>i</sub></var></span></div>
      <svg class="residue-chart" viewBox="0 0 540 150" role="img" aria-label="Residue trajectory through pipeline stages">
        <line class="axis" x1="42" y1={sy(0)} x2="498" y2={sy(0)} />
        <line class="bound" x1="42" y1={sy(1)} x2="498" y2={sy(1)} />
        <line class="bound" x1="42" y1={sy(-1)} x2="498" y2={sy(-1)} />
        <text class="axis-label" x="35" y={sy(1) + 4} text-anchor="end">+1</text>
        <text class="axis-label" x="35" y={sy(0) + 4} text-anchor="end">0</text>
        <text class="axis-label" x="35" y={sy(-1) + 4} text-anchor="end">−1</text>
        {#each result.stages as s, i (s.index)}
          <line class:muted={i >= visible} class="guide" x1={42 + ((i) / stageCount) * 456} y1="24" x2={42 + ((i) / stageCount) * 456} y2="132" />
          {#if i < visible}<path class="trajectory" d={residuePath(s)} />{/if}
          <circle class:muted={i >= visible} class="point" cx={42 + ((i + 1) / stageCount) * 456} cy={sy(s.residue)} r="4" />
          <text class="stage-label" x={42 + ((i + 1) / stageCount) * 456} y="147" text-anchor="middle">r{s.index}</text>
        {/each}
        <circle class="input-point" cx="42" cy={sy(vin)} r="5" />
        <text class="input-label" x="42" y={sy(vin) - 10} text-anchor="middle">input</text>
      </svg>
      <div class="residue-note"><span class="dot input-dot"></span> input <span class="dot residue-dot"></span> residue stays in the next stage's ±1 range <span class="bound-note">The thresholds at ±0.25 leave overlap for digital correction.</span></div>
    </div>

    <div class="ledger panel-box">
      <div class="panel-head"><div><span class="label">Digital correction</span><h2>Ternary decisions become one code</h2></div><span class="formula"><var>x = Σ d<sub>i</sub>/2<sup>i</sup> + r<sub>N</sub>/2<sup>N</sup></var></span></div>
      <div class="ledger-rows">
        {#each result.stages as s, i (s.index)}
          <div class:dim={i >= visible} class="ledger-row"><span class="ledger-stage">d{s.index}</span><b>{visible > i ? s.decisionLabel : '·'}</b><span class="operator">/ 2<sup>{s.index}</sup></span><span class="equals">=</span><span class="contribution">{visible > i ? signed(s.contribution, 3) : '· · ·'}</span></div>
        {/each}
        <div class="ledger-row fine"><span class="ledger-stage">residue</span><b>{visible >= stageCount ? signed(result.finalResidue, 3) : '·'}</b><span class="operator">/ 2<sup>{stageCount}</sup></span><span class="equals">=</span><span class="contribution">{visible >= stageCount ? signed(result.residueCorrection, 4) : '· · ·'}</span></div>
      </div>
      <div class="output-box">
        <div><span class="label">reconstructed input</span><strong>{visible >= stageCount ? signed(result.reconstructed, 4) : 'waiting for residue'}</strong><small>{visible >= stageCount ? 'the coarse estimate plus the final fine correction' : 'step through every stage to finish the code'}</small></div>
        <div class="code-readout"><span class="label">{stageCount}-bit code</span><strong>{visible >= stageCount ? result.code : '· · ·'}</strong><small>LSB = {nf(lsb, 4)} FS</small></div>
      </div>
    </div>
  </section>

  <footer class="lesson-foot"><span><b>Pipeline intuition:</b> the analog signal is never sent through one giant flash converter. It is progressively reduced to a bounded residue, while the digital logic keeps the redundant decisions consistent.</span><span class="mono">ideal · no settling error</span></footer>
</main>

<style>
  .pipeline-page { min-width: 0; max-width: 1500px; height: auto; min-height: calc(100dvh - 49px); grid-template-rows: auto auto minmax(0, 1fr) auto; }
  .top { align-items: start; min-width: 0; }
  .top > div:first-child { min-width: 0; }
  .eyebrow { color: var(--brand); font: 500 11px/1.2 var(--mono); letter-spacing: .08em; text-transform: uppercase; margin-bottom: 7px; }
  h1 { margin: 0; max-width: 720px; font: 500 clamp(25px, 3vw, 38px)/1.05 var(--math); letter-spacing: -.02em; }
  .dek { margin: 10px 0 0; max-width: 690px; color: var(--ink-2); font-size: 15px; }
  .controls { display: grid; gap: 11px; justify-items: end; padding-top: 2px; }
  .controls :global(.range) { --range-width: 150px; }
  .stage-picker { display: flex; align-items: center; gap: 8px; }
  .stage-strip { border-top: 1px solid var(--rule); padding-top: 11px; }
  .strip-head, .panel-head, .lesson-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
  .hint { color: var(--ink-3); font-size: 12px; margin-left: 9px; }
  .transport { display: flex; align-items: center; gap: 5px; }
  .transport button { border: 1px solid var(--rule); background: var(--plot); color: var(--ink); border-radius: 6px; min-width: 29px; height: 27px; cursor: pointer; font: 16px var(--sans); }
  .transport button:hover { border-color: var(--ink-3); }
  .transport .play { min-width: 64px; font-size: 12px; }
  .count { min-width: 4ch; color: var(--ink-3); font: 12px var(--mono); text-align: right; }
  .stages { display: grid; grid-template-columns: max-content repeat(5, minmax(0, 1fr)); gap: 8px; align-items: stretch; margin-top: 10px; }
  .source-node, .stage-card { min-width: 0; border: 1px solid var(--rule); border-radius: 8px; background: var(--plot); min-height: 104px; padding: 10px 11px; }
  .source-node { display: grid; align-content: center; min-width: 102px; border-color: var(--s1); background: var(--s1-soft); }
  .node-tag, .stage-kind { color: var(--ink-3); font: 10px var(--mono); text-transform: uppercase; letter-spacing: .07em; }
  .source-node b { font: 500 17px var(--mono); margin-top: 3px; }
  .source-node small { color: var(--ink-2); }
  .stage-card { opacity: .52; transition: opacity .18s, border-color .18s, transform .18s; }
  .stage-card.active { opacity: 1; }
  .stage-card.current { border-color: var(--brand); transform: translateY(-2px); box-shadow: 0 5px 0 color-mix(in srgb, var(--brand) 13%, transparent); }
  .stage-title { display: flex; justify-content: space-between; color: var(--ink-2); font-size: 12px; margin-bottom: 12px; }
  .stage-title span:first-child { color: var(--ink); font-weight: 500; }
  .stage-flow { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content minmax(0, 1fr) max-content minmax(0, 1fr); align-items: center; gap: 5px; }
  .mini-block { min-width: 0; display: grid; gap: 1px; text-align: center; }
  .mini-block small { color: var(--ink-3); font-size: 10px; }
  .mini-block b { font: 500 18px var(--mono); }
  .mini-block b.negative { color: var(--s2); }.mini-block b.positive { color: var(--s1); }.mini-block.gain b { color: var(--brand); }
  .arrow { color: var(--ink-3); }
  .stage-foot { overflow: hidden; display: flex; justify-content: space-between; gap: 8px; margin-top: 11px; color: var(--ink-3); font: 10px var(--mono); white-space: nowrap; }
  .analysis { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, .9fr); gap: 14px; margin-top: 14px; min-height: 310px; }
  .panel-box { border-top: 1px solid var(--rule); padding-top: 11px; min-width: 0; }
  .panel-head { margin-bottom: 9px; }
  h2 { margin: 3px 0 0; font-size: 15px; font-weight: 500; }
  .formula { color: var(--ink-2); font: 15px var(--math); white-space: nowrap; }
  .residue-chart { width: 100%; height: 208px; display: block; overflow: visible; background: var(--plot); border: 1px solid var(--rule-soft); border-radius: 8px; }
  .axis, .bound { stroke: var(--rule); stroke-width: 1; }.bound { stroke-dasharray: 4 4; }.guide { stroke: var(--rule-soft); stroke-width: 1; }.guide.muted { opacity: .3; }
  .trajectory { fill: none; stroke: var(--s1); stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }.point { fill: var(--brand); stroke: var(--plot); stroke-width: 2; }.point.muted { fill: var(--ghost); }.input-point { fill: var(--s2); stroke: var(--plot); stroke-width: 2; }
  .axis-label, .stage-label { fill: var(--ink-3); font: 10px var(--mono); }.input-label { fill: var(--s2); font: 11px var(--sans); }
  .residue-note { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--ink-2); font-size: 11.5px; margin-top: 8px; }.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-top: 5px; }.input-dot { background: var(--s2); }.residue-dot { background: var(--brand); }.bound-note { color: var(--ink-3); }
  .ledger-rows { border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
  .ledger-row { display: grid; grid-template-columns: 58px 28px 48px 20px 1fr; align-items: baseline; gap: 6px; padding: 8px 11px; border-bottom: 1px solid var(--rule-soft); font: 13px var(--mono); }.ledger-row:last-child { border-bottom: 0; }.ledger-row.dim { opacity: .42; }.ledger-row b { font-size: 16px; color: var(--s1); }.ledger-row.fine b { color: var(--brand); }.ledger-stage, .operator, .equals { color: var(--ink-3); }.contribution { color: var(--ink); text-align: right; }.ledger-row sup { font-size: .7em; }
  .output-box { display: grid; grid-template-columns: 1fr max-content; gap: 16px; align-items: center; background: var(--chip); border-radius: 8px; padding: 12px 13px; margin-top: 10px; }.output-box strong { display: block; font: 500 22px var(--mono); color: var(--brand); margin-top: 3px; }.output-box small { display: block; color: var(--ink-3); font-size: 11px; }.code-readout { text-align: right; border-left: 1px solid var(--rule); padding-left: 16px; }.code-readout strong { color: var(--s1); }
  .lesson-foot { border-top: 1px solid var(--rule); padding-top: 10px; margin-top: 13px; color: var(--ink-2); font-size: 12px; }.lesson-foot b { color: var(--ink); font-weight: 500; }.lesson-foot .mono { color: var(--ink-3); font-size: 11px; white-space: nowrap; }
  @media (max-width: 1100px) { .stages { grid-template-columns: max-content repeat(3, minmax(0, 1fr)); }.stage-card:nth-of-type(n+5) { display: none; }.analysis { grid-template-columns: 1fr; }.residue-chart { height: 190px; } }
  @media (max-width: 900px) { .pipeline-page { min-height: 0; }.top { gap: 14px; }.controls { justify-items: start; width: 100%; }.controls :global(.range) { --range-width: 1fr; width: 100%; }.stage-picker { width: 100%; justify-content: space-between; }.stages { grid-template-columns: 1fr; }.source-node { min-height: 74px; }.stage-card:nth-of-type(n+5) { display: block; }.stage-card { min-height: 102px; }.stage-foot { font-size: 10px; }.analysis { margin-top: 18px; }.panel-head { align-items: start; flex-direction: column; gap: 4px; }.formula { font-size: 14px; }.output-box { grid-template-columns: 1fr; }.code-readout { border-left: 0; border-top: 1px solid var(--rule); padding: 9px 0 0; text-align: left; }.lesson-foot { align-items: start; flex-direction: column; }.hint { display: block; margin: 3px 0 0; } }
</style>

