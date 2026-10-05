<script lang="ts">
  import { onMount } from 'svelte';
  import Range from '../../components/ui/Range.svelte';
  import PipelinePlots from './PipelinePlots.svelte';
  import { TOPOLOGIES, type PipelineTopology } from './configurable';
  import { convertWithErrors, analyzeLinearity } from './errors';
  import { ERROR_LIMIT, ERROR_STEP, initialErrorProfiles, nextRandom, parseReplayHash, replayHash, validateSnapshot, type PipelineSnapshot } from './session';
  import { VOLTAGE_DOMAIN } from './display';
  import { captureBrowserIssues } from './diagnostics';

  let topologyId=$state<PipelineTopology['id']>('three-bit'), input=$state(.68), playing=$state(false);
  const errorLimit=ERROR_LIMIT, errorStep=ERROR_STEP;
  let errorStage=$state(0), mobileView=$state<'stages'|'overall'>('stages');
  let errorProfiles=$state(initialErrorProfiles());
  let randomState=0, diagnostics:ReturnType<typeof captureBrowserIssues>|undefined;
  let replayStatus=$state(''), replayFallback=$state(''), replayWarning=$state('');
  let notes:HTMLDialogElement|undefined=$state();
  const topology=$derived(TOPOLOGIES.find(t=>t.id===topologyId)!);
  const stageErrors=$derived(errorProfiles[topology.id]);
  const selectedStage=$derived(Math.min(errorStage,stageErrors.length-1));
  const currentErrors=$derived(stageErrors[selectedStage]);
  const settings=$derived(stageErrors.map((values,stage)=>({stage,...values})));
  const activeStages=$derived(stageErrors.flatMap((values,stage)=>values.gainError!==0||values.nonlinearity!==0?[stage+1]:[]));
  const analysis=$derived(analyzeLinearity(topology.bits,settings));
  const conversion=$derived(convertWithErrors(input,topology.bits,settings));
  const domain:[number,number]=[0,1];
  const binary=(v:number,n:number)=>v.toString(2).padStart(n,'0');
  const percent=(v:number)=>`${v>0?'+':''}${v.toFixed(3)}%`;
  function changeTopology(value:string){
    const next=TOPOLOGIES.find(candidate=>candidate.id===value);
    if(next){playing=false;errorStage=0;topologyId=next.id;}
  }
  function ideal(){playing=false;errorProfiles[topologyId]=stageErrors.map(()=>({gainError:0,nonlinearity:0}));}
  function random(){const next=nextRandom(randomState);randomState=next.state;return next.value;}
  function randomize(target:'input'|'errors'|'all'){
    playing=false;
    if(target!=='errors')input=Math.floor(random()*65537)/65536;
    if(target!=='input'){
      const steps=Math.round(errorLimit/errorStep);
      const draw=()=>Number(((Math.floor(random()*(2*steps+1))-steps)*errorStep).toFixed(3));
      if(target==='all')errorProfiles[topologyId]=stageErrors.map(()=>({gainError:draw(),nonlinearity:draw()}));
      else {currentErrors.gainError=draw();currentErrors.nonlinearity=draw();}
    }
  }
  function snapshot():PipelineSnapshot {
    // Validation also detaches the Svelte proxies before serializing a report.
    return validateSnapshot({version:1,topologyId,input,errorStage:selectedStage,errorProfiles,randomState,mobileView})!;
  }
  function replayUrl(state:PipelineSnapshot):string {
    const url=new URL(window.location.href);url.hash=replayHash(state);return url.href;
  }
  async function copyReplay(){
    playing=false;const url=replayUrl(snapshot());replayFallback='';
    try {await navigator.clipboard.writeText(url);replayStatus='Replay link copied. It restores this view and the next random sequence.';}
    catch {replayFallback=url;replayStatus='Copy this link to restore the view.';}
  }
  function saveDiagnostic(){
    playing=false;const state=snapshot();
    const report={version:1,lesson:'pipeline-adc',capturedAt:new Date().toISOString(),build:__CLASSROOM_BUILD__,
      replayUrl:replayUrl(state),state,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
      userAgent:navigator.userAgent,errors:diagnostics?.issues.slice()??[]};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='pipeline-diagnostic.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    replayStatus='Report saved with a replay link, build version, viewport and browser errors.';
  }
  function restoreReplay(){
    if(!window.location.hash.startsWith('#pipeline='))return;
    const state=parseReplayHash(window.location.hash);
    if(!state){replayWarning='Invalid replay link. Current settings were kept.';return;}
    playing=false;topologyId=state.topologyId;input=state.input;errorStage=state.errorStage;
    errorProfiles=state.errorProfiles;randomState=state.randomState;mobileView=state.mobileView;
    replayWarning='';replayStatus='Replay restored. Sweep is paused at the saved input.';
  }
  onMount(()=>{
    diagnostics=captureBrowserIssues();
    randomState=crypto.getRandomValues(new Uint32Array(1))[0];
    restoreReplay();window.addEventListener('hashchange',restoreReplay);
    let frame=0,last=performance.now(),direction=1;
    const run=(now:number)=>{
      const dt=Math.min(.05,(now-last)/1000);last=now;
      if(playing){input=Math.min(1,Math.max(0,input+direction*dt/18));if(input===1)direction=-1;if(input===0)direction=1;}
      frame=requestAnimationFrame(run);
    };
    frame=requestAnimationFrame(run);return()=>{
      cancelAnimationFrame(frame);window.removeEventListener('hashchange',restoreReplay);diagnostics?.dispose();
    };
  });
</script>

<main class="pipeline-lab">
  <section class="control-panel" aria-label="Pipeline controls">
    <div class="lab-toolbar">
      <div class="architecture"><label for="pipeline-architecture">Architecture</label><select id="pipeline-architecture" value={topologyId} onchange={(event)=>changeTopology(event.currentTarget.value)}>{#each TOPOLOGIES as t}<option value={t.id}>{t.label}</option>{/each}</select></div>
      <div class="injection"><label for="error-stage">Edit stage</label><select id="error-stage" value={selectedStage} onchange={(event)=>{playing=false;errorStage=Number(event.currentTarget.value);}}>{#each stageErrors as values,i}<option value={i}>Stage {i+1}{values.gainError!==0||values.nonlinearity!==0?" •":""}</option>{/each}</select></div>
      <div class="error-range"><Range id="gain-error" bind:value={currentErrors.gainError} min={-errorLimit} max={errorLimit} step={errorStep} output={percent(currentErrors.gainError)}>Gain error</Range></div>
      <div class="error-range"><Range id="nonlinearity" bind:value={currentErrors.nonlinearity} min={-errorLimit} max={errorLimit} step={errorStep} output={percent(currentErrors.nonlinearity)}>Nonlinearity</Range></div>
      <div class="error-actions" role="group" aria-label="Error actions">
        <button title="Set gain error and nonlinearity to zero in every stage; keep the input voltage" onclick={ideal}>Reset errors</button>
        <button title="Randomize only this stage; keep errors in all other stages" onclick={()=>randomize('errors')}>Random errors</button>
      </div>
    </div>
    <div class="control-deck">
      <button class="play" aria-label={playing?'Pause input sweep':'Sweep input'} aria-pressed={playing} onclick={()=>playing=!playing}><span aria-hidden="true">{playing?'Ⅱ':'▷'}</span><span>{playing?'Pause':'Sweep'}</span></button>
      <div class="input-control"><Range id="pipeline-input" bind:value={input} min={0} max={1} step={1/65536} output={`${input.toFixed(6)} V`} onstart={()=>playing=false}>Input voltage</Range></div>
      <div class="input-actions" role="group" aria-label="Input and combined actions">
        <button title="Randomize only the input voltage" onclick={()=>randomize('input')}>Random input</button>
        <button class="random-all" title="Randomize the input voltage and gain/nonlinearity in every stage" onclick={()=>randomize('all')}>Random all</button>
      </div>
      <div class="output"><span>{conversion.totalBits}-BIT OUTPUT</span><b>{binary(conversion.code,conversion.totalBits)}</b><small>code {conversion.code}</small></div>
      <button class="notes" aria-label="Model notes" title="Model notes" onclick={()=>notes?.showModal()}>ⓘ</button>
    </div>
    <div class="error-summary" aria-live="polite">{activeStages.length?`Errors active: ${activeStages.map(stage=>`S${stage}`).join(" · ")}`:"All stages ideal"}<span>Each stage keeps its own settings</span></div>
    {#if replayWarning}<div class="replay-warning" role="status">{replayWarning}</div>{/if}
  </section>
  <div class="context">
    <div class="legend"><span class="actual"></span> Actual <span class="reference"></span> Ideal <span class="architecture-note">· {conversion.totalBits}-bit, nonredundant</span></div>
    <div class="mobile-tabs" role="group" aria-label="Plot group"><button class:active={mobileView==='stages'} onclick={()=>mobileView='stages'} aria-pressed={mobileView==='stages'}>Stage curves</button><button class:active={mobileView==='overall'} onclick={()=>mobileView='overall'} aria-pressed={mobileView==='overall'}>DNL / INL</button></div>
    <span class="missing-codes">{analysis.missingCodes.length} missing codes</span>
  </div>
  <section class="plots" aria-label="Every pipeline stage and overall linearity"><PipelinePlots bits={topology.bits} {settings} {analysis} {conversion} {domain} {mobileView}/></section>
</main>

<dialog bind:this={notes} aria-labelledby="pipeline-notes-title">
  <div class="dialog-head"><h2 id="pipeline-notes-title">Every stage, one conversion</h2><button aria-label="Close model notes" onclick={()=>notes?.close()}>×</button></div>
  <p>Each stage resolves b bits: q = clamp(floor(2ᵇu), 0, 2ᵇ − 1), DAC = q / 2ᵇ, and ideal residue r = 2ᵇ(u − DAC). The final flash adds bits without another residue amplifier. The 10-stage preset is 9 × 1 bit + 3 bits = 12 bits.</p>
  <p>Each residue amplifier independently produces F(r) = (1 + g)r + 4nr(1 − r)(2r − 1), where g and n are the two percentage settings divided by 100. The cubic term preserves both endpoints. Outside the nominal residue range 0–1 V, the amplifier follows the endpoint tangent to preserve a monotonic overrange response. Analog residue is never clipped; subsequent digital decisions saturate. Errors in every configured stage act together, and each architecture retains its own settings. Reset errors clears all stages; Random errors changes only the stage being edited; Random all changes the input and every stage.</p>
  <p>DNL[k] = (T[k + 1] − T[k]) / LSB − 1, with nominal LSB = 1 / {analysis.levels} V. It includes the measured widths of the first and last bins. A zero-width code has DNL = −1. INL uses a line through the first and last observed transitions, in fitted LSBs; unreachable transitions are omitted. {analysis.endpointCodes?`Current fit: transitions ${analysis.endpointCodes[0]}–${analysis.endpointCodes[1]}.`:''}</p>
  <p>Every stage is visible together. Each row enlarges the original-input interval selected by the preceding digital decisions. The horizontal axis is original Vin in every row, with explicitly different bounds. The highlighted interval expands into the next row; its displayed zoom ratio is a viewing scale, not the residue amplifier gain. The ideal voltage range is 0–1 V; residue and ADC transfer voltage axes stay fixed at {VOLTAGE_DOMAIN[0]} to {VOLTAGE_DOMAIN[1]} V. Gray dashed curves show the ideal response; colored solid curves show the actual response on the same axes. The last row shows the final flash digit on its integer code scale. DNL and INL retain the full code range. Numerical extrema and the INL endpoint fit always use the full input range.</p>
  <p>This is a static, nonredundant pipeline model. Redundant decision stages, digital correction, settling and noise are not modeled.</p>
  <div class="replay-tools" role="group" aria-label="Reproduce this view">
    <button onclick={copyReplay}>Copy replay link</button>
    <button onclick={saveDiagnostic}>Save diagnostic report</button>
  </div>
  <p class="replay-status" role="status">{replayStatus||'Save the current view to reproduce a problem or continue with the same settings.'}</p>
  {#if replayFallback}<input class="replay-link" aria-label="Replay link" readonly value={replayFallback} onfocus={event=>event.currentTarget.select()}/>{/if}
</dialog>

<style>
  .pipeline-lab { height:100%; min-height:0; display:grid; grid-template-rows:auto auto minmax(0,1fr); gap:12px; padding:12px 24px; background:#fff; }
  .control-panel { display:grid; gap:10px; min-width:0; padding:10px 14px; border:1px solid #dbe4e8; border-radius:8px; background:#f5f8fa; }
  .error-summary { display:flex; justify-content:space-between; gap:12px; color:#976023; font:10px var(--mono); }.error-summary span { color:var(--ink-3); font-family:var(--sans); }
  .replay-warning { font-size:11px; color:#976023; }
  .replay-tools { display:flex; flex-wrap:wrap; gap:8px; margin-top:18px; }
  .replay-link { width:100%; box-sizing:border-box; margin-top:8px; }
  .lab-toolbar { display:grid; grid-template-columns:auto auto minmax(0,1fr) minmax(0,1fr) auto; align-items:center; gap:16px; }
  .architecture,.injection { display:flex; align-items:center; gap:8px; min-width:0; }.architecture>label { display:none; }
  label { font-size:11px; color:var(--ink-3); }
  select { max-width:100%; background:#fff; color:var(--ink); font:500 12px var(--sans); border:1px solid #c9d5dc; border-radius:5px; padding:7px 24px 7px 9px; cursor:pointer; }
  button { border:1px solid #bdcdd5; color:#294b5a; background:#fff; border-radius:5px; font:500 12px var(--sans); white-space:nowrap; cursor:pointer; padding:8px 11px; }
  button:hover { background:#e8f1f4; border-color:#819fac; }
  .notes { border:0; padding:0 2px; font-size:21px; background:transparent; }
  .error-actions,.input-actions { display:flex; gap:7px; }
  .random-all,.play { background:#e8f4f4; color:#00696f; border-color:#b4d5d7; }
  .error-range { min-width:0; }
  .error-range :global(.range) { display:grid; grid-template-columns:minmax(0,1fr) auto; grid-template-areas:'label value' 'slider slider'; gap:4px; }
  .error-range :global(label) { grid-area:label; font-size:10px; color:var(--ink-2); }
  .error-range :global(input) { grid-area:slider; width:100%; accent-color:#008b91; }
  .error-range :global(output) { grid-area:value; font-size:11px; width:7.5ch; text-align:right; }
  .control-deck { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto; align-items:center; gap:16px; }
  .play { display:flex; align-items:center; gap:7px; }.play>span:first-child { font:16px/1 var(--sans); }
  .input-control { min-width:0; }
  .input-control :global(.range) { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:12px; }
  .input-control :global(input) { width:100%; accent-color:#008b91; }
  .input-control :global(output) { width:10ch; text-align:right; font-size:12px; }
  .output { display:grid; grid-template-columns:auto auto; gap:2px 8px; padding-left:16px; border-left:1px solid #dbe4e8; }
  .output>span { grid-column:1/-1; font:8px var(--mono); color:var(--ink-3); letter-spacing:.08em; }
  .output b { font:14px var(--mono); color:#ad6b09; }.output small { align-self:center; font:10px var(--mono); color:var(--ink-3); }
  .context { display:flex; align-items:center; gap:16px; color:var(--ink-3); font:10px/1.4 var(--sans); }
  .legend { display:flex; align-items:center; gap:6px; }.actual,.reference { display:inline-block; width:18px; border-top:2px solid #008b91; }
  .reference { border-top:3px dashed #9aa5ae; margin-left:8px; }.mobile-tabs { display:none; }.missing-codes { margin-left:auto; font:10px var(--mono); }
  .plots { min-height:0; min-width:0; }
  dialog { width:calc(100% - 32px); max-width:580px; max-height:85dvh; overflow:auto; border:1px solid var(--rule); border-radius:10px; padding:22px; background:#fff; color:var(--ink); } dialog::backdrop { background:#17243455; backdrop-filter:blur(3px); }.dialog-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }.dialog-head h2 { margin:0; font-size:17px; font-weight:550; }.dialog-head button { border:0; padding:0 4px; font-size:22px; } dialog p { font-size:12px; line-height:1.7; color:var(--ink-2); margin:14px 0 0; }
  @media(max-width:1250px) {
    .lab-toolbar,.control-deck { gap:12px; }.output small { display:none; }
    .input-control :global(.range) { grid-template-columns:minmax(0,1fr) auto; grid-template-areas:'label value' 'slider slider'; gap:3px; }
    .input-control :global(label) { grid-area:label; font-size:10px; }.input-control :global(input) { grid-area:slider; }.input-control :global(output) { grid-area:value; }
  }
  @media(max-width:850px) {
    .control-panel { padding:10px; gap:10px; }
    .lab-toolbar { grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px 12px; }
    .injection { justify-self:end; }.error-actions { grid-column:1/-1; justify-content:flex-end; }
    .control-deck { grid-template-columns:auto minmax(0,1fr) auto auto; gap:8px; border-top:1px solid #dbe4e8; padding-top:8px; }
    .play { grid-column:1; grid-row:1; }.input-control { grid-column:2/-1; grid-row:1; }
    .input-actions { grid-column:1/3; grid-row:2; }.output { grid-column:3; grid-row:2; }.notes { grid-column:4; grid-row:2; }
    .mobile-tabs { display:flex; gap:2px; margin-left:auto; }.mobile-tabs button { font-size:10px; padding:4px 7px; border-color:transparent; }
    .mobile-tabs .active { background:#e4f2f2; color:#00696f; }.architecture-note,.missing-codes { display:none; }.context { gap:10px; }
  }
  @media(max-width:550px) {
    .pipeline-lab { padding:8px 10px; gap:8px; }.control-panel { padding:8px; gap:8px; }
    select { font-size:10px; padding:6px; }.injection label { font-size:9px; }
    button { font-size:11px; padding:7px 9px; }.notes { font-size:20px; padding:0; }
    .error-actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .error-range :global(label),.error-range :global(output) { font-size:9px; }
    .input-control :global(output) { font-size:11px; }.play { padding:7px; }.play>span:last-child { display:none; }
    .input-actions { gap:6px; }.output { padding-left:8px; }.output b { font-size:10px; }.output>span { font-size:7px; }
    .error-summary { font-size:9px; }.error-summary span { display:none; }
    .legend { font-size:9px; }.mobile-tabs button { font-size:9px; }
  }
  @media(max-height:550px) {
    .pipeline-lab { padding:5px 10px; gap:5px; }.control-panel { padding:6px 10px; gap:6px; }
    button { padding:5px 9px; }.context { font-size:9px; }
  }
  @media(max-width:380px) {
    .control-deck { grid-template-columns:auto minmax(0,1fr) auto; }
    .notes { grid-column:3; }.output { grid-column:1/-1; grid-row:3; display:flex; justify-content:flex-end; align-items:center; padding:0; border:0; }
  }
</style>
