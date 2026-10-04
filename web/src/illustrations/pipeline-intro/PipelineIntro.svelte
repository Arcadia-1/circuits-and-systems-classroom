<script lang="ts">
  import { onMount } from 'svelte';
  import Range from '../../components/ui/Range.svelte';
  import PipelinePlots from './PipelinePlots.svelte';
  import { TOPOLOGIES } from './configurable';
  import { convertWithErrors, analyzeLinearity } from './errors';

  let topologyId=$state('three-bit'), input=$state(.68), playing=$state(false);
  const errorLimit=.25, errorStep=.005;
  let errorStage=$state(0), gainError=$state(.1), nonlinearity=$state(0), mobileView=$state<'stages'|'overall'>('stages');
  let notes:HTMLDialogElement|undefined=$state();
  const topology=$derived(TOPOLOGIES.find(t=>t.id===topologyId)!);
  const settings=$derived({stage:errorStage,gainError,nonlinearity});
  const analysis=$derived(analyzeLinearity(topology.bits,settings));
  const conversion=$derived(convertWithErrors(input,topology.bits,settings));
  const domain:[number,number]=[0,1];
  const binary=(v:number,n:number)=>v.toString(2).padStart(n,'0');
  const percent=(v:number)=>`${v>0?'+':''}${v.toFixed(3)}%`;
  function changeTopology(){errorStage=0;playing=false;}
  function ideal(){playing=false;gainError=0;nonlinearity=0;}
  function randomize(target:'input'|'errors'|'all'){
    playing=false;
    if(target!=='errors')input=Math.floor(Math.random()*65537)/65536;
    if(target!=='input'){
      const steps=Math.round(errorLimit/errorStep);
      const draw=()=>Number(((Math.floor(Math.random()*(2*steps+1))-steps)*errorStep).toFixed(3));
      gainError=draw();nonlinearity=draw();
    }
  }
  onMount(()=>{
    let frame=0,last=performance.now(),direction=1;
    const run=(now:number)=>{
      const dt=Math.min(.05,(now-last)/1000);last=now;
      if(playing){input=Math.min(1,Math.max(0,input+direction*dt/18));if(input===1)direction=-1;if(input===0)direction=1;}
      frame=requestAnimationFrame(run);
    };
    frame=requestAnimationFrame(run);return()=>cancelAnimationFrame(frame);
  });
</script>

<main class="pipeline-lab">
  <div class="lab-toolbar">
    <div class="architecture"><label for="pipeline-architecture">Architecture</label><select id="pipeline-architecture" bind:value={topologyId} onchange={changeTopology}>{#each TOPOLOGIES as t}<option value={t.id}>{t.label}</option>{/each}</select></div>
    <div class="injection"><label for="error-stage">Error in</label><select id="error-stage" bind:value={errorStage}>{#each topology.bits.slice(0,-1) as _,i}<option value={i}>Stage {i+1}</option>{/each}</select></div>
    <div class="error-range"><Range id="gain-error" bind:value={gainError} min={-errorLimit} max={errorLimit} step={errorStep} output={percent(gainError)}>Gain error</Range></div>
    <div class="error-range"><Range id="nonlinearity" bind:value={nonlinearity} min={-errorLimit} max={errorLimit} step={errorStep} output={percent(nonlinearity)}>Nonlinearity</Range></div>
  </div>
  <div class="control-deck">
    <button class="play" aria-label={playing?'Pause input sweep':'Sweep input'} aria-pressed={playing} onclick={()=>playing=!playing}><span aria-hidden="true">{playing?'Ⅱ':'▷'}</span><span>{playing?'Pause':'Sweep'}</span></button>
    <div class="input-control"><Range id="pipeline-input" bind:value={input} min={0} max={1} step={1/65536} output={`${input.toFixed(6)} V`} onstart={()=>playing=false}>Input voltage</Range></div>
    <div class="output"><span>{conversion.totalBits}-BIT OUTPUT</span><b>{binary(conversion.code,conversion.totalBits)}</b><small>code {conversion.code}</small></div>
  </div>
  <div class="context">
    <div class="legend"><span class="actual"></span> Actual <span class="reference"></span> Ideal <span class="architecture-note">· {conversion.totalBits}-bit, nonredundant</span></div>
    <div class="mobile-tabs" role="group" aria-label="Plot group"><button class:active={mobileView==='stages'} onclick={()=>mobileView='stages'} aria-pressed={mobileView==='stages'}>Stage curves</button><button class:active={mobileView==='overall'} onclick={()=>mobileView='overall'} aria-pressed={mobileView==='overall'}>DNL / INL</button></div>
    <span class="missing-codes">{analysis.missingCodes.length} missing codes</span>
    <div class="utilities">
      <button class="ideal" title="Set both errors to zero; keep the input voltage" onclick={ideal}>Reset errors</button>
      <div class="random-actions" role="group" aria-label="Randomize parameters">
        <button title="Randomize only the input voltage" onclick={()=>randomize('input')}>Random input</button>
        <button title="Randomize gain error and nonlinearity in the selected stage" onclick={()=>randomize('errors')}>Random errors</button>
        <button title="Randomize the input voltage and both errors" onclick={()=>randomize('all')}>Random all</button>
      </div>
      <button class="notes" aria-label="Model notes" title="Model notes" onclick={()=>notes?.showModal()}>ⓘ</button>
    </div>
  </div>
  <section class="plots" aria-label="Every pipeline stage and overall linearity"><PipelinePlots bits={topology.bits} {settings} {analysis} {conversion} {domain} {mobileView}/></section>
</main>

<dialog bind:this={notes} aria-labelledby="pipeline-notes-title">
  <div class="dialog-head"><h2 id="pipeline-notes-title">Every stage, one conversion</h2><button aria-label="Close model notes" onclick={()=>notes?.close()}>×</button></div>
  <p>Each stage resolves b bits: q = clamp(floor(2ᵇu), 0, 2ᵇ − 1), DAC = q / 2ᵇ, and ideal residue r = 2ᵇ(u − DAC). The final flash adds bits without another residue amplifier. The 10-stage preset is 9 × 1 bit + 3 bits = 12 bits.</p>
  <p>The selected amplifier produces F(r) = (1 + g)r + 4nr(1 − r)(2r − 1), where g and n are the two percentage settings divided by 100. The cubic term preserves both endpoints. Analog residue is never clipped; subsequent digital decisions saturate. One amplifier has errors at a time.</p>
  <p>DNL[k] = (T[k + 1] − T[k]) / LSB − 1, with nominal LSB = 1 / {analysis.levels} V. It includes the measured widths of the first and last bins. A zero-width code has DNL = −1. INL uses a line through the first and last observed transitions, in fitted LSBs; unreachable transitions are omitted. {analysis.endpointCodes?`Current fit: transitions ${analysis.endpointCodes[0]}–${analysis.endpointCodes[1]}.`:''}</p>
  <p>Conversion error = (nominal code-centre voltage − input) / nominal LSB; it includes quantization. Every stage is visible together. Each row enlarges the original-input interval selected by the preceding digital decisions. The horizontal axis is original Vin in every row, with explicitly different bounds. The highlighted interval expands into the next row; its displayed zoom ratio is a viewing scale, not the residue amplifier gain. Curves show actual residue after each amplifier, and the last row shows only the final flash digit. DNL and INL retain the full code range. Numerical extrema and the INL endpoint fit always use the full input range.</p>
  <p>This is a static, nonredundant pipeline model. Redundant decision stages, digital correction, settling and noise are not modeled.</p>
</dialog>

<style>
  .pipeline-lab { height:100%; min-height:0; display:grid; grid-template-rows:auto auto auto minmax(0,1fr); gap:12px; padding:14px 24px 12px; background:#fff; }
  .lab-toolbar { display:grid; grid-template-columns:auto auto minmax(0,1fr) minmax(0,1fr); align-items:center; gap:20px; }
  .architecture,.injection { display:flex; align-items:center; gap:8px; }.architecture>label { display:none; }
  label { font-size:11px; color:var(--ink-3); } select { background:#fff; color:var(--ink); font:500 12px var(--sans); border:1px solid var(--rule); border-radius:5px; padding:7px 24px 7px 9px; cursor:pointer; }
  button { border:1px solid var(--rule); color:var(--ink-2); background:#fff; border-radius:5px; font:500 11px var(--sans); cursor:pointer; padding:7px 10px; }.notes { border:0; padding:0; font-size:20px; }
  .error-range { min-width:0; }.error-range :global(.range) { display:grid; grid-template-columns:auto minmax(35px,1fr) 7.5ch; gap:9px; }.error-range :global(label) { font-size:10px; color:var(--ink-2); }.error-range :global(input) { width:100%; accent-color:#008b91; }.error-range :global(output) { font-size:11px; width:auto; text-align:right; }
  .context { display:flex; align-items:center; gap:22px; color:var(--ink-3); font:10px/1.4 var(--sans); }.legend { display:flex; align-items:center; gap:6px; }.actual,.reference { display:inline-block; width:18px; border-top:2px solid #008b91; }.reference { border-top:2px dashed #9ba7b5; margin-left:8px; }.mobile-tabs { display:none; }.utilities { display:flex; align-items:center; gap:12px; }.utilities .ideal { padding:3px 7px; font-size:10px; }.missing-codes { margin-left:auto; font:10px var(--mono); }
  .plots { min-height:0; min-width:0; }
  .utilities button:not(.notes) { padding:4px 8px; font-size:10px; white-space:nowrap; }
  .random-actions { display:flex; gap:4px; }
  .control-deck { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:22px; border-bottom:1px solid var(--rule); padding:0 0 12px; background:#fff; }
  .play { display:flex; align-items:center; gap:8px; background:#eef7f7; color:#00696f; border-color:#cae3e4; padding:9px 12px; }.play > span:first-child { font:16px/1 var(--sans); }
  .input-control { min-width:0; }.input-control :global(.range) { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:14px; }.input-control :global(input) { width:100%; accent-color:#008b91; }.input-control :global(output) { width:10ch; text-align:right; font-size:13px; }
  .output { display:grid; grid-template-columns:auto auto; gap:1px 9px; padding-left:20px; border-left:1px solid var(--rule); }.output > span { grid-column:1/-1; font:8px var(--mono); color:var(--ink-3); letter-spacing:.08em; }.output b { font:15px var(--mono); color:#ad6b09; }.output small { align-self:center; font:10px var(--mono); color:var(--ink-3); }
  dialog { width:calc(100% - 32px); max-width:580px; max-height:85dvh; overflow:auto; border:1px solid var(--rule); border-radius:10px; padding:22px; background:#fff; color:var(--ink); } dialog::backdrop { background:#17243455; backdrop-filter:blur(3px); }.dialog-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }.dialog-head h2 { margin:0; font-size:17px; font-weight:550; }.dialog-head button { border:0; padding:0 4px; font-size:22px; } dialog p { font-size:12px; line-height:1.7; color:var(--ink-2); margin:14px 0 0; }
  @media(max-width:1250px) { .lab-toolbar { gap:12px; }.error-range :global(.range) { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:'label value' 'slider slider'; gap:2px; }.error-range :global(label) { grid-area:label; }.error-range :global(input) { grid-area:slider; }.error-range :global(output) { grid-area:value; }.output small { display:none; } }
  @media(max-width:850px) { .mobile-tabs { display:flex; gap:2px; }.mobile-tabs button { font-size:10px; padding:4px 7px; border-color:transparent; }.mobile-tabs .active { background:#e4f2f2; color:#00696f; }.architecture-note,.missing-codes { display:none; }.context { flex-wrap:wrap; gap:8px 10px; }.lab-toolbar { grid-template-columns:auto auto 1fr auto; gap:8px; }.architecture { grid-column:1/3; }.injection { grid-column:3/5; justify-self:end; }.error-range { grid-row:2; grid-column:span 2; }.utilities { width:100%; justify-content:flex-end; gap:9px; } }
  @media(max-width:550px) { .pipeline-lab { padding:9px 10px; gap:8px; }.lab-toolbar { gap:8px 10px; }.architecture { grid-column:1/3; }.architecture select { max-width:210px; padding:6px; font-size:10px; }.injection { grid-column:3/5; justify-self:end; }.injection label { font-size:9px; }.injection select { font-size:10px; padding:6px; }.utilities button:not(.notes) { font-size:9px; padding:5px 6px; }.utilities { justify-content:space-between; gap:5px; }.notes { font-size:17px; }.error-range :global(label),.error-range :global(output) { font-size:9px; }.context { flex-wrap:wrap; gap:6px 12px; }.legend { font-size:9px; }.mobile-tabs { margin-left:auto; }.mobile-tabs button { font-size:9px; }.control-deck { gap:9px; padding-bottom:8px; }.play { padding:7px; }.play>span:last-child { display:none; }.input-control :global(.range) { grid-template-columns:1fr auto; grid-template-areas:'label value' 'slider slider'; gap:4px; }.input-control :global(label) { grid-area:label; font-size:8px; }.input-control :global(input) { grid-area:slider; }.input-control :global(output) { grid-area:value; font-size:10px; width:auto; }.output { padding-left:9px; }.output b { font-size:10px; }.output>span { font-size:7px; } }
  @media(max-height:550px) { .pipeline-lab { padding:5px 10px; gap:5px; }.control-deck { padding-bottom:5px; }.play { padding:4px 8px; }.context { font-size:9px; } }
</style>
