<script lang="ts">
  import { onMount } from 'svelte';
  import Range from '../../components/ui/Range.svelte';
  import CoursePlot from '../../components/chart/CoursePlot.svelte';
  import { LEVELS, STAGES, convert, pipelineAt, samples } from './model';
  let input = $state(.68), selected = $state(0), clock = $state(0), playing = $state(false);
  const conversion = $derived(convert(input));
  const stage = $derived(conversion.stages[selected]);
  const stream = $derived(samples(input));
  const pipeline = $derived(pipelineAt(clock, stream));
  const lastClock = $derived(stream.length + STAGES - 1);
  const name = (i:number) => String.fromCharCode(65+i);
  const bits = (v:number, n=2) => v.toString(2).padStart(n,'0');
  onMount(() => {
    let timer = 0;
    timer = window.setInterval(() => { if(playing) { clock++; if(clock >= lastClock) playing = false; } }, 850);
    return () => clearInterval(timer);
  });
</script>

<main class="course">
  <p class="course-intro">Resolve two bits, subtract their analog value, amplify the residue. Repeat while the next sample enters.</p>
  <section class="panel">
    <div class="toolbar"><h2>Follow sample A</h2><div class="input"><Range id="pipe-input" bind:value={input} onstart={() => { clock=0; playing=false; }} min={0} max={1} step={.001} output={`${input.toFixed(3)} V`}>Input · 0 to 1 V</Range></div></div>
    <div class="stage-row" aria-label="Conversion stages">
      {#each conversion.stages as st,i}<button class="stage-card" aria-pressed={selected===i} onclick={()=>selected=i}><span>Stage {i+1}{i===2 ? ' · final flash' : ' →'}</span><b>{bits(st.digit)}</b><span>in {st.input.toFixed(3)} V</span><small>{i<2 ? `residue ${st.residue.toFixed(3)} V →` : 'last two bits → output'}</small></button>{/each}
      <div class="digital"><span>6-bit output</span><b>{bits(conversion.code,6)}</b><small>code {conversion.code} / 63</small></div>
    </div>
    <p class="note">Three 2-bit stages → 6 bits. All digital digits belong to the same input sample.</p>
  </section>
  <div class="two">
    <section class="panel"><h2>Stage {selected+1} · {selected===2 ? 'quantize the final residue' : 'zoom in on what remains'}</h2>
      <div class="math-chain"><div><span>Sub-ADC</span><b>q = {stage.digit}</b></div><i>→</i><div><span>{selected===2 ? 'Bin lower edge' : 'DAC'}</span><b>{stage.dac.toFixed(3)} V</b></div><i>→</i><div><span>{selected===2 ? 'Final bits' : 'Subtract & ×4'}</span><b>{selected===2 ? bits(stage.digit) : `${stage.residue.toFixed(3)} V`}</b></div></div>
      <p class="equation">{selected===2 ? `q₃ = min(3, floor(4 × ${stage.input.toFixed(3)})) = ${stage.digit}${stage.input===1 ? ' (saturated)' : ''}` : `r = 4 × (${stage.input.toFixed(3)} − ${stage.dac.toFixed(3)}) = ${stage.residue.toFixed(3)} V`}</p>
      <div class="readouts"><div><span>Reconstructed code centre</span><b class="result">{conversion.estimate.toFixed(5)} V</b></div><div><span>Quantization error</span><b class="result">{(conversion.error * LEVELS).toFixed(3)} LSB</b></div></div>
      <p class="note">1 LSB = 1/64 V. The output is the centre of its code bin; the remaining analog error is not added back.</p>
    </section>
    <section class="panel"><h2>{selected===2 ? 'Final 2-bit quantizer' : 'Residue transfer · four repeating ramps'}</h2><div class="plot-box"><CoursePlot label={selected===2 ? 'Final flash ADC transfer' : 'Stage residue transfer and selected sample'} xDomain={[0,1]} yDomain={[0,selected===2 ? 3.2 : 1]} xLabel="stage input · V" yLabel={selected===2 ? 'digit q' : 'residue · V'} series={[...Array.from({length:4},(_,i)=>({name:i===0 ? (selected===2 ? 'Digit' : 'Residue') : '',color:'var(--s1)',points:[{x:i/4,y:selected===2 ? i : 0},{x:(i+1)/4,y:selected===2 ? i : 1}]})),{name:'This sample',color:'var(--s2)',dots:true,points:[{x:stage.input,y:selected===2 ? stage.digit : stage.residue}]}]}/></div></section>
  </div>
  <section class="panel timing">
    <div class="toolbar"><h2>Pipeline timing · three clocks of latency, one output per clock</h2><div class="actions"><button class="primary" onclick={()=>{if(clock===lastClock) clock=0; playing=!playing;}}>{playing ? 'Pause' : 'Play'}</button><button disabled={clock>=lastClock} onclick={()=>{playing=false;clock++;}}>Next clock</button><button onclick={()=>{clock=0;playing=false;}}>Reset pipeline</button></div></div>
    <div class="clock-readout">After clock <b>{clock}</b> · {pipeline.output ? `sample ${name(pipeline.output.sample)} ready: ${bits(pipeline.output.code,6)}` : clock===0 ? 'sample A launched at the input' : clock<3 ? 'filling the pipeline' : 'pipeline empty'}</div>
    <div class="occupancy">{#each pipeline.slots as slot,i}<div><span>Stage {i+1}</span><b class:empty={!slot}>{slot ? name(slot.sample) : '—'}</b><small>{slot ? `digit ${bits(slot.stage.digit)} · input ${slot.stage.input.toFixed(3)} V` : 'waiting for a sample'}</small></div>{/each}</div>
    <div class="schedule-wrap"><table aria-label="Sample progress at each clock"><thead><tr><th>After clock</th>{#each Array.from({length:lastClock},(_,i)=>i+1) as c}<th class:now={c===clock}><button aria-label={`Inspect clock ${c}`} aria-pressed={c===clock} onclick={()=>{clock=c;playing=false;}}>{c}</button></th>{/each}</tr></thead><tbody>{#each ['Stage 1 result','Stage 2 result','Stage 3 / output'] as label,j}<tr><th>{label}</th>{#each Array.from({length:lastClock},(_,i)=>i+1) as c}{@const sample=c-1-j}<td class:now={c===clock} class:ready={j===2&&sample>=0&&sample<stream.length}>{sample>=0&&sample<stream.length ? name(sample) : '·'}</td>{/each}</tr>{/each}</tbody></table></div>
    <p class="note">A is launched at clock 0; stage 1 finishes at clock 1 and its full code arrives at clock 3. B follows one clock later. Earlier digits are delayed digitally to meet the final digit. This teaching schedule assigns one clock per stage.</p>
  </section>
  <details><summary>Model and next lesson</summary><p>Ideal 0–1 V ADC with two residue stages (gain 4) and a final 2-bit flash. Thresholds are ¼, ½ and ¾ V; full scale saturates at code 63. Real pipelines often use redundant decisions, clock phases, and more elaborate residue settling. Next: <a href="/adc/pipeline-adc/">1.5-bit stages and digital redundancy</a>.</p></details>
</main>
<style>
  .input { width: min(400px,100%); } .stage-row { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 14px; margin: 18px 0; }
  .stage-card, .digital { display: grid; gap: 8px; text-align: left; padding: 18px !important; border-radius: 8px; }
  .stage-card b,.digital b { font: 500 29px var(--mono); color: var(--brand); } .digital { background: var(--brand-soft); } small { font-size: 12px; color: var(--ink-2); }
  .math-chain { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 0; } .math-chain div { display: grid; gap: 12px; } .math-chain span { font-size: 12px; color: var(--ink-3); } .math-chain b { font: 15px var(--mono); } .math-chain i { color: var(--ink-3); }
  .equation { font: 15px/1.6 var(--mono); background: var(--ground); padding: 14px; border-radius: 8px; overflow-wrap: anywhere; }
  .readouts { margin: 20px 0 14px; } .clock-readout { margin: 16px 0; font: 14px var(--mono); color: var(--ink-2); }
  .occupancy { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin: 16px 0; } .occupancy > div { border: 1px solid var(--rule); border-radius: 8px; padding: 14px; display: grid; gap: 8px; }
  .occupancy b { font: 600 28px var(--mono); color: var(--brand); } .occupancy span { font-size: 13px; } .occupancy b.empty { color: var(--ink-3); }
  .schedule-wrap { overflow-x:auto; margin: 18px 0; } table { border-collapse:collapse; width:100%; min-width:640px; text-align:center; font:14px var(--mono); } th,td { padding:10px 4px; border-bottom:1px solid var(--rule); } th:first-child { text-align:left; width:170px; font-size:12px; } th button { padding:4px 8px; } .now { background:var(--brand-soft); } .ready { color:var(--brand); font-weight:600; }
  @media(max-width:650px) { .stage-row { grid-template-columns:1fr 1fr; } .occupancy { gap:6px; } .occupancy > div { padding:10px; } }
</style>
