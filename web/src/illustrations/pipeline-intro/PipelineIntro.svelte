<script lang="ts">
  import { onMount } from 'svelte';
  import Range from '../../components/ui/Range.svelte';
  import PipelineCurve from './PipelineCurve.svelte';
  import { convert, pipelineAt, samples } from './model';
  import { prefix } from './curves';

  let input = $state(.68), sweeping = $state(false), zoom = $state(false), clock = $state(3);
  let stage = $state<1 | 2>(1), resolution = $state<1 | 2 | 3>(3);
  const conversion = $derived(convert(input));
  const resolved = $derived(prefix(input, stage));
  const output = $derived(prefix(input, resolution));
  const coarse = $derived(Math.min(3, Math.floor(input * 4)) / 4);
  const domain = $derived<[number, number]>(zoom ? [coarse, coarse + .25] : [0, 1]);
  const stream = $derived(samples(input));
  const timing = $derived(pipelineAt(clock, stream));
  const name = (i: number) => String.fromCharCode(65 + i);
  const bits = (n: number, width: number) => n.toString(2).padStart(width, '0');

  onMount(() => {
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (sweeping) {
        input = Math.min(1, input + Math.min(now - last, 100) / 12000);
        if (input >= 1) sweeping = false;
      }
      last = now;
    }, 32);
    return () => clearInterval(timer);
  });
</script>

<main class="pipeline-lesson">
  <div class="lesson-lead"><p>Coarse steps. Amplified residue. Finer steps.</p><span>Ideal 2 bits per stage · 0–1 V</span></div>
  <div class="input-bar">
    <div class="input-control"><Range id="pipeline-input" bind:value={input} min={0} max={1} step={.001} onstart={() => sweeping = false} output={`${input.toFixed(3)} V`}>Input voltage</Range></div>
    <button class="sweep" aria-pressed={sweeping} onclick={() => { if (input >= 1) input = 0; sweeping = !sweeping; }}>{sweeping ? 'Pause sweep' : 'Sweep input'}<span aria-hidden="true">{sweeping ? 'Ⅱ' : '↗'}</span></button>
  </div>

  <section class="residue-section" aria-label="Linked transfer and residue curves">
    <div class="section-head">
      <div class="section-title"><span class="section-number">01</span><h2>Resolve a range. Expand what remains.</h2></div>
      <div class="segmented" role="group" aria-label="Residue stage">{#each [1, 2] as s}<button aria-pressed={stage === s} onclick={() => stage = s as 1 | 2}>Stage {s}</button>{/each}</div>
    </div>
    <div class="curve-pair">
      <figure>
        <figcaption><h3>Input resolved so far</h3><span>{4 ** stage} coarse intervals</span></figcaption>
        <div class="legend"><span class="blue">Resolved lower edge</span><span class="neutral dashed">Input</span><span class="orange">Unresolved gap</span></div>
        <div class="curve large"><PipelineCurve kind="resolved" {input} stages={stage} /></div>
        <p class="curve-note">{stage === 1 ? 'The first 2-bit decision selects one of four input ranges.' : 'Two decisions narrow the input to one of sixteen ranges.'}</p>
      </figure>
      <figure>
        <figcaption><h3>Residue after stage {stage}</h3><span class="orange-text">{4 ** stage} ramps · 0–1 V again</span></figcaption>
        <div class="legend"><span class="orange">Amplified residue</span><span class="neutral dashed">Before this stage’s ×4 gain</span></div>
        <div class="curve large"><PipelineCurve kind="residue" {input} stages={stage} /></div>
        <p class="curve-note">Each selected interval becomes a full-scale ramp for the next ADC.</p>
      </figure>
    </div>
    <div class="equation-strip">
      <span>r<sub>{stage}</sub> = 4 × ( {stage === 1 ? 'Vᵢₙ' : 'r₁'} − DAC<sub>{stage}</sub> )</span>
      <span class="calculation">4 × ({conversion.stages[stage - 1].input.toFixed(3)} − {conversion.stages[stage - 1].dac.toFixed(3)}) = <b>{conversion.stages[stage - 1].residue.toFixed(3)} V</b></span>
      <small>Both plots use original Vᵢₙ on the x-axis.{stage === 2 ? ' The left staircase includes both decisions.' : ''}</small>
    </div>
  </section>

  <section class="output-section" aria-label="ADC transfer curve">
    <div class="section-head">
      <div class="section-title"><span class="section-number">02</span><h2>More stages, smaller steps.</h2></div>
      <div class="segmented" role="group" aria-label="Resolved output bits">{#each [1, 2, 3] as s}<button aria-pressed={resolution === s} onclick={() => resolution = s as 1 | 2 | 3}>{2 * s} bits</button>{/each}</div>
    </div>
    <div class="output-head"><div class="legend"><span class="blue">{4 ** resolution} code centres</span><span class="neutral dashed">Ideal y = x</span></div><label class="zoom"><input type="checkbox" bind:checked={zoom} /> Zoom into the selected ¼ V interval</label></div>
    <div class="curve output"><PipelineCurve kind="output" {input} stages={resolution} {domain} /></div>
    <div class="output-readout" aria-live="off"><span><b>{bits(output.code, 2 * resolution)}</b><small>code {output.code}</small></span><span>{output.estimate.toFixed(5)} V<small>code centre</small></span><span>{(1000 / output.levels).toFixed(3)} mV<small>step width · 1 LSB</small></span><span>{(1000 * output.error).toFixed(3)} mV<small>quantization error</small></span></div>
    <p class="curve-note">The third stage is a final 2-bit flash. Its decision completes the 6-bit code; no analog residue is added to the output.</p>
  </section>

  <details class="timing">
    <summary>Why “pipeline”? Three clocks of latency, then one result per clock.</summary>
    <div class="timing-controls"><span>After clock <b>{clock}</b></span><button disabled={clock === 0} onclick={() => clock--}>Previous clock</button><button disabled={clock === 10} onclick={() => clock++}>Next clock</button><button onclick={() => clock = 0}>Reset</button><span>{timing.output ? `Sample ${name(timing.output.sample)} → ${bits(timing.output.code, 6)}` : 'Filling the pipeline'}</span></div>
    <div class="schedule-wrap"><table aria-label="Sample progress at each clock"><thead><tr><th>After clock</th>{#each Array.from({length:10},(_,i)=>i+1) as c}<th class:now={c===clock}><button aria-label={`Inspect clock ${c}`} aria-pressed={c===clock} onclick={()=>clock=c}>{c}</button></th>{/each}</tr></thead><tbody>{#each ['Stage 1 result','Stage 2 result','Stage 3 / output'] as label,j}<tr><th>{label}</th>{#each Array.from({length:10},(_,i)=>i+1) as c}{@const sample=c-1-j}<td class:now={c===clock}>{sample>=0&&sample<stream.length ? name(sample) : '·'}</td>{/each}</tr>{/each}</tbody></table></div>
    <p>A launches at clock 0 and completes at clock 3. Earlier digits are delayed to align with the final digit. This ideal schedule assigns one clock per stage.</p>
  </details>
  <details class="model-notes"><summary>Model & curve conventions</summary><p>Ideal, nonredundant 2-bit stages, each with thresholds at ¼, ½ and ¾ V. Stage 1 and stage 2 subtract their local DAC level q/4 and apply gain 4. On the original input axis, the resolved lower edge after stage {stage} is {resolved.code}/{resolved.levels}; its unresolved gap is magnified by {4 ** stage} across those stages. The final ADC transfer shows bin centres, not DAC lower edges. Open circles exclude the left-hand limit at a jump; filled endpoints show the value at the threshold. The full 6-bit converter saturates at code 63. Real converters add redundancy and must allow for settling, noise and mismatch.</p></details>
</main>

<style>
  .pipeline-lesson { max-width:1320px; margin:0 auto; padding:26px 32px 38px; }
  .lesson-lead { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:22px; }
  .lesson-lead p { margin:0; font-size:clamp(18px,2vw,24px); font-weight:500; letter-spacing:-.035em; }
  .lesson-lead > span { font-size:12px; color:var(--ink-3); }
  .input-bar { display:flex; align-items:center; gap:24px; margin-bottom:28px; }
  .input-control { width:460px; max-width:100%; }
  .input-control :global(.range) { display:grid; grid-template-columns:1fr auto; grid-template-areas:'label value' 'slider slider'; gap:7px; }
  .input-control :global(label) { grid-area:label; }
  .input-control :global(input) { grid-area:slider; width:100%; accent-color:var(--s2); }
  .input-control :global(output) { grid-area:value; width:auto; font-size:16px; }
  button { color:var(--ink-2); background:transparent; border:1px solid var(--rule); border-radius:6px; padding:7px 12px; font:500 12px var(--sans); cursor:pointer; }
  button:hover { border-color:var(--ink-3); color:var(--ink); } button:disabled { opacity:.4; cursor:default; }
  .sweep { display:flex; gap:16px; align-items:center; margin-top:10px; }
  .sweep[aria-pressed='true'] { background:var(--s2-soft); border-color:var(--s2); color:var(--s2); }
  .residue-section,.output-section { background:var(--plot); padding:23px 26px 0; border:1px solid var(--rule); border-radius:10px; }
  .output-section { margin-top:22px; padding-bottom:18px; }
  .section-head { display:flex; justify-content:space-between; align-items:center; gap:14px; margin-bottom:23px; }
  .section-title { display:flex; gap:12px; align-items:center; } .section-number { font:12px var(--mono); color:var(--ink-3); border-right:1px solid var(--rule); padding-right:12px; }
  h2 { margin:0; font-size:17px; font-weight:500; letter-spacing:-.025em; }
  .segmented { display:flex; padding:3px; border:1px solid var(--rule); border-radius:7px; background:var(--ground); flex-shrink:0; }
  .segmented button { border:0; padding:6px 15px; white-space:nowrap; }
  .segmented button[aria-pressed='true'] { background:var(--ink); color:var(--plot); box-shadow:0 1px 3px #0001; }
  .curve-pair { display:grid; grid-template-columns:1fr 1fr; gap:38px; } figure { margin:0; min-width:0; }
  figcaption { display:flex; gap:8px; align-items:baseline; justify-content:space-between; margin-bottom:10px; }
  h3 { font-size:14px; margin:0; font-weight:600; } figcaption > span { color:var(--ink-3); font-size:11px; }
  .legend { display:flex; flex-wrap:wrap; gap:8px 16px; color:var(--ink-3); font-size:11px; }
  .legend > span::before { content:''; display:inline-block; width:17px; border-top:2px solid currentColor; vertical-align:middle; margin-right:6px; }
  .legend .dashed::before { border-top-style:dashed; } .blue { color:var(--s1); } .orange,.orange-text { color:var(--s2); }
  .curve { display:flex; margin-top:10px; } .curve.large { height:300px; } .curve.output { height:270px; }
  .curve-note { margin:8px 0 18px; color:var(--ink-3); font-size:12px; line-height:1.6; }
  .equation-strip { display:flex; align-items:baseline; flex-wrap:wrap; gap:8px 24px; padding:14px 0; margin-top:6px; border-top:1px solid var(--rule-soft); font:13px var(--mono); }
  .equation-strip > span:first-child { color:var(--s2); } .calculation { color:var(--ink-2); } .calculation b { font-weight:500; color:var(--s2); }
  .equation-strip small { font:11px/1.5 var(--sans); color:var(--ink-3); flex:1 1 210px; }
  .output-head { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; }
  .zoom { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-2); cursor:pointer; } .zoom input { accent-color:var(--s1); }
  .output-readout { display:flex; flex-wrap:wrap; gap:14px 34px; border-top:1px solid var(--rule-soft); padding-top:12px; font:14px var(--mono); }
  .output-readout > span { display:flex; align-items:baseline; gap:8px; } .output-readout small { font:11px var(--sans); color:var(--ink-3); }
  .output-readout b { color:var(--s1); font-weight:500; letter-spacing:.08em; } .output-section > .curve-note { margin-bottom:0; }
  details { font-size:12px; color:var(--ink-2); line-height:1.7; margin-top:18px; } summary { cursor:pointer; } details p { max-width:95ch; }
  .timing-controls { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-top:14px; }
  .schedule-wrap { overflow-x:auto; margin-top:15px; } table { border-collapse:collapse; width:100%; min-width:620px; text-align:center; font:12px var(--mono); } th,td { padding:8px 4px; border-bottom:1px solid var(--rule); } th:first-child { text-align:left; width:150px; font-size:11px; } th button { padding:4px 8px; } .now { background:var(--brand-soft); }
  @media(max-width:1000px) { .pipeline-lesson { padding:24px; } .curve-pair { gap:22px; } figcaption { display:block; } figcaption > span { display:block; margin-top:4px; } }
  @media(max-width:700px) {
    .pipeline-lesson { padding:20px 14px 28px; } .lesson-lead { display:block; margin-bottom:18px; } .lesson-lead > span { display:block; margin-top:7px; }
    .input-bar { gap:12px; margin-bottom:20px; } .input-control { flex:1; min-width:0; } .sweep { padding:8px; gap:8px; font-size:11px; }
    .residue-section,.output-section { padding:17px 12px 0; } .section-head { flex-wrap:wrap; margin-bottom:20px; gap:12px; } h2 { font-size:16px; } .section-number { padding-right:8px; } .section-title { gap:8px; }
    .curve-pair { grid-template-columns:1fr; gap:18px; } .curve.large { height:250px; } .curve.output { height:250px; }
    figcaption { display:flex; } figcaption > span { margin:0; } .legend { gap:6px 12px; font-size:10px; }
    .equation-strip { font-size:11px; gap:8px; } .equation-strip small { flex-basis:100%; }
    .output-section { padding-bottom:16px; } .output-readout { display:grid; grid-template-columns:1fr 1fr; gap:12px; font-size:12px; } .output-readout > span { display:grid; gap:3px; }
  }
</style>
