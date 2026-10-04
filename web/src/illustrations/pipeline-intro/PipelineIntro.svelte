<script lang="ts">
  import { onMount } from 'svelte';
  import Range from '../../components/ui/Range.svelte';
  import PipelinePlots from './PipelinePlots.svelte';
  import { TOPOLOGIES } from './configurable';
  import { convertWithErrors, analyzeLinearity } from './errors';

  let topologyId=$state('ten'), input=$state(.68), playing=$state(false), magnify=$state(false);
  let errorStage=$state(0), gainError=$state(.5), nonlinearity=$state(0), mobileView=$state<'stages'|'overall'>('stages');
  let notes:HTMLDialogElement|undefined=$state();
  const topology=$derived(TOPOLOGIES.find(t=>t.id===topologyId)!);
  const settings=$derived({stage:errorStage,gainError,nonlinearity});
  const analysis=$derived(analyzeLinearity(topology.bits,settings));
  const conversion=$derived(convertWithErrors(input,topology.bits,settings));
  const codeBlock=$derived(Math.min(Math.floor(input*conversion.levels/16)*16,conversion.levels-16)/conversion.levels);
  const domain=$derived<[number,number]>(magnify?[codeBlock,codeBlock+16/conversion.levels]:[0,1]);
  const binary=(v:number,n:number)=>v.toString(2).padStart(n,'0');
  const percent=(v:number)=>`${v>0?'+':''}${v.toFixed(2)}%`;
  function changeTopology(){errorStage=0;magnify=false;playing=false;}
  function ideal(){gainError=0;nonlinearity=0;}
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
    <label class="magnify"><input type="checkbox" bind:checked={magnify}/> Zoom overall · 16 LSB</label>
    <button class="notes" aria-label="Model notes" title="Model notes" onclick={()=>notes?.showModal()}>ⓘ</button>
  </div>
  <div class="error-controls" aria-label="Residue amplifier error injection">
    <div class="injection"><label for="error-stage">Error in</label><select id="error-stage" bind:value={errorStage}>{#each topology.bits.slice(0,-1) as _,i}<option value={i}>Stage {i+1}</option>{/each}</select></div>
    <div class="error-range"><Range id="gain-error" bind:value={gainError} min={-2} max={2} step={.02} output={percent(gainError)}>Gain error</Range></div>
    <div class="error-range"><Range id="nonlinearity" bind:value={nonlinearity} min={-2} max={2} step={.02} output={percent(nonlinearity)}>Nonlinearity</Range></div>
    <button class="ideal" onclick={ideal}>Reset ideal</button>
  </div>
  <div class="context">
    <div class="legend"><span class="actual"></span> Actual <span class="reference"></span> Ideal <span class="architecture-note">· {conversion.totalBits}-bit, nonredundant</span></div>
    <div class="mobile-tabs" role="group" aria-label="Plot group"><button class:active={mobileView==='stages'} onclick={()=>mobileView='stages'} aria-pressed={mobileView==='stages'}>All stages</button><button class:active={mobileView==='overall'} onclick={()=>mobileView='overall'} aria-pressed={mobileView==='overall'}>Overall ADC</button></div>
    <span class="stage-hint">Outlined: error in Stage {errorStage+1} · dots: one sample</span>
  </div>
  <section class="plots" aria-label="Every pipeline stage and overall linearity"><PipelinePlots bits={topology.bits} {settings} {analysis} {conversion} {domain} {magnify} {mobileView}/></section>
  <div class="control-deck">
    <button class="play" aria-label={playing?'Pause input sweep':'Sweep input'} aria-pressed={playing} onclick={()=>playing=!playing}><span aria-hidden="true">{playing?'Ⅱ':'▷'}</span><span>{playing?'Pause':'Sweep'}</span></button>
    <div class="input-control"><Range id="pipeline-input" bind:value={input} min={0} max={1} step={1/65536} output={`${input.toFixed(6)} V`} onstart={()=>playing=false}>Input voltage</Range></div>
    <div class="output"><span>{conversion.totalBits}-BIT OUTPUT</span><b>{binary(conversion.code,conversion.totalBits)}</b><small>code {conversion.code}</small></div>
  </div>
</main>

<dialog bind:this={notes} aria-labelledby="pipeline-notes-title">
  <div class="dialog-head"><h2 id="pipeline-notes-title">Every stage, one conversion</h2><button aria-label="Close model notes" onclick={()=>notes?.close()}>×</button></div>
  <p>Each stage resolves b bits: q = clamp(floor(2ᵇu), 0, 2ᵇ − 1), DAC = q / 2ᵇ, and ideal residue r = 2ᵇ(u − DAC). The final flash adds bits without another residue amplifier. The 10-stage preset is 9 × 1 bit + 3 bits = 12 bits.</p>
  <p>The selected amplifier produces F(r) = (1 + g)r + 4nr(1 − r)(2r − 1), where g and n are the two percentage settings divided by 100. The cubic term preserves both endpoints. Analog residue is never clipped; subsequent digital decisions saturate. One amplifier has errors at a time.</p>
  <p>DNL[k] = (T[k + 1] − T[k]) / LSB − 1, with nominal LSB = 1 / {analysis.levels} V. It includes the measured widths of the first and last bins. A zero-width code has DNL = −1. INL uses a line through the first and last observed transitions, in fitted LSBs; unreachable transitions are omitted. {analysis.endpointCodes?`Current fit: transitions ${analysis.endpointCodes[0]}–${analysis.endpointCodes[1]}.`:''}</p>
  <p>Conversion error = (nominal code-centre voltage − input) / nominal LSB; it includes quantization. Every stage is visible together. Each stage curve maps its own local input to its residue; the final flash maps local input to an integer code. Dots follow the same original sample through the actual stage decisions. These local axes are not the original ADC input. The overall plots use original input or output code; zoom shows 16 nominal input LSBs there. Numerical extrema and the INL endpoint fit always use the full input range.</p>
  <p>This is a static, nonredundant pipeline model. Redundant decision stages, digital correction, settling and noise are not modeled.</p>
</dialog>

<style>
  .pipeline-lab { height:100%; min-height:0; display:grid; grid-template-rows:auto auto auto minmax(0,1fr) auto; gap:9px; padding:12px 22px 10px; }
  .lab-toolbar { display:flex; gap:22px; align-items:center; }.architecture,.injection { display:flex; align-items:center; gap:9px; }
  label { font-size:11px; color:var(--ink-3); } select { background:var(--plot); color:var(--ink); font:500 12px var(--sans); border:1px solid var(--rule); border-radius:6px; padding:7px 28px 7px 10px; cursor:pointer; } select:disabled { opacity:.55; }
  .magnify { display:flex; gap:6px; align-items:center; margin-left:auto; cursor:pointer; }.magnify input { accent-color:var(--brand); }
  button { border:1px solid var(--rule); color:var(--ink-2); background:var(--plot); border-radius:6px; font:500 12px var(--sans); cursor:pointer; padding:7px 10px; }.notes { border:0; background:transparent; padding:3px; font-size:20px; }
  .error-controls { display:grid; grid-template-columns:auto minmax(0,1fr) minmax(0,1fr) auto; align-items:center; gap:24px; background:#edf3f7; border:1px solid #dce6ec; padding:9px 12px; border-radius:8px; }.error-range { min-width:0; }.error-range :global(.range) { display:grid; grid-template-columns:auto minmax(35px,1fr) 7ch; gap:10px; }.error-range :global(label) { font-size:11px; color:var(--ink-2); }.error-range :global(input) { width:100%; accent-color:#147a9c; }.error-range :global(output) { font-size:12px; width:auto; text-align:right; }.ideal { font-size:11px; }
  .context { display:flex; justify-content:space-between; align-items:center; gap:10px; color:var(--ink-3); font:10px/1.4 var(--sans); padding:0 2px; }.legend { display:flex; align-items:center; gap:6px; }.actual,.reference { display:inline-block; width:18px; border-top:2px solid #008b91; }.reference { border-top:2px dashed #9ba7b5; margin-left:7px; }.mobile-tabs { display:none; }
  .plots { min-height:0; min-width:0; }
  .control-deck { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:22px; border:1px solid var(--rule); border-radius:9px; padding:10px 16px; background:var(--plot); }
  .play { display:flex; align-items:center; gap:8px; background:#e7f3f4; color:#00696f; border-color:#b9dcdf; padding:9px 12px; }.play > span:first-child { font:16px/1 var(--sans); }
  .input-control { min-width:0; }.input-control :global(.range) { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:14px; }.input-control :global(input) { width:100%; accent-color:var(--brand); }.input-control :global(output) { width:10ch; text-align:right; font-size:13px; }
  .output { display:grid; grid-template-columns:auto auto; gap:1px 9px; padding-left:20px; border-left:1px solid var(--rule); }.output > span { grid-column:1/-1; font:8px var(--mono); color:var(--ink-3); letter-spacing:.08em; }.output b { font:15px var(--mono); color:#ad6b09; }.output small { align-self:center; font:10px var(--mono); color:var(--ink-3); }
  dialog { width:calc(100% - 32px); max-width:580px; max-height:85dvh; overflow:auto; border:1px solid var(--rule); border-radius:12px; padding:22px; background:var(--plot); color:var(--ink); } dialog::backdrop { background:#17243455; backdrop-filter:blur(3px); }.dialog-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }.dialog-head h2 { margin:0; font-size:17px; font-weight:550; }.dialog-head button { border:0; padding:0 4px; font-size:22px; } dialog p { font-size:12px; line-height:1.7; color:var(--ink-2); margin:14px 0 0; }
  @media(max-width:1100px) { .lab-toolbar { gap:12px; }.architecture > label { display:none; }.error-controls { gap:12px; }.error-range :global(.range) { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:'label value' 'slider slider'; gap:2px; }.error-range :global(label) { grid-area:label; }.error-range :global(input) { grid-area:slider; }.error-range :global(output) { grid-area:value; }.output small { display:none; } }
  @media(max-width:1050px) { .mobile-tabs { display:flex; gap:2px; }.mobile-tabs button { font-size:10px; padding:3px 8px; background:transparent; border-color:transparent; }.mobile-tabs .active { background:#e3edf4; color:#145a78; }.stage-hint { display:none; } }
  @media(max-width:700px) {
    .pipeline-lab { padding:8px 10px; gap:7px; }.lab-toolbar { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px 8px; }.architecture { grid-column:1; }.architecture select { width:100%; }.notes { grid-column:2; grid-row:1; }.magnify { grid-column:1/-1; grid-row:2; font-size:9px; margin:0; justify-self:end; line-height:1.25; }
    .error-controls { grid-template-columns:1fr 1fr; gap:7px 15px; padding:7px 9px; }.injection { grid-column:1; grid-row:1; gap:6px; }.injection label { font-size:10px; }.injection select { padding:4px 20px 4px 7px; font-size:10px; }.ideal { grid-column:2; grid-row:1; justify-self:end; padding:4px 7px; font-size:10px; }.error-range :global(label),.error-range :global(output) { font-size:10px; }
    .context { font-size:9px; gap:6px; }.architecture-note { display:none; }.legend { gap:4px; }.actual,.reference { width:12px; }.reference { margin-left:3px; }.mobile-tabs { display:flex; gap:2px; }.mobile-tabs button { font-size:9px; padding:4px 6px; background:transparent; border-color:transparent; }.mobile-tabs .active { background:#e3edf4; color:#145a78; }
    .control-deck { gap:9px; padding:8px; }.play { padding:8px; }.play > span:last-child { display:none; }.input-control :global(.range) { grid-template-columns:1fr auto; grid-template-areas:'label value' 'slider slider'; gap:4px; }.input-control :global(label) { grid-area:label; font-size:8px; }.input-control :global(input) { grid-area:slider; }.input-control :global(output) { grid-area:value; font-size:10px; width:auto; }.output { padding-left:9px; }.output b { font-size:10px; }.output > span { font-size:7px; }
  }
  @media(max-height:600px) { .mobile-tabs { display:flex; gap:2px; }.mobile-tabs button { font-size:9px; padding:2px 6px; background:transparent; border-color:transparent; }.mobile-tabs .active { background:#e3edf4; color:#145a78; }.stage-hint { display:none; }.pipeline-lab { padding:4px 10px; gap:4px; }.lab-toolbar { display:flex; gap:10px; }.architecture > label,.notes { display:none; }.architecture select { padding:3px 20px 3px 7px; font-size:10px; }.magnify { margin-left:auto; font-size:9px; }.error-controls { padding:4px 8px; gap:12px; }.injection label { display:none; }.injection select,.ideal { font-size:9px; padding:3px 7px; }.error-range :global(label),.error-range :global(output) { font-size:9px; }.context { font-size:8px; }.control-deck { padding:4px 10px; }.play { padding:4px 8px; }.output b { font-size:11px; } }
</style>
