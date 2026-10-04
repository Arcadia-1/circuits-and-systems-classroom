<script lang="ts">
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import CoursePlot from '../../components/chart/CoursePlot.svelte';
  import { DEFAULTS, TRAINING, N, TONE, adc, correct, fitInverse, minimumSlope, validate, type Device, type Training, type Fit } from './model';
  let device = $state<Device>({ ...DEFAULTS }), training = $state<Training>({ ...TRAINING }), amplitude = $state(.85);
  let fit = $state<Fit | null>(fitInverse(DEFAULTS, TRAINING)), enabled = $state(true);
  const currentFit = $derived(fit && JSON.stringify(fit.device) === JSON.stringify(device) ? fit : null);
  const pending = $derived(!currentFit || JSON.stringify(training) !== JSON.stringify(currentFit.training));
  const usedFit = $derived(enabled ? currentFit : null);
  const result = $derived(validate(device, usedFit, amplitude));
  const grid = Array.from({length:241},(_,i)=>-1+2*i/240);
  const rawTransfer = $derived(grid.map(x=>({x,y:adc(x,device)})));
  const correctedTransfer = $derived(grid.map(x=>({x,y:usedFit ? correct(adc(x,device),usedFit) : adc(x,device)})));
  const transferExtent = $derived(Math.max(1.25, Math.ceil(Math.max(...correctedTransfer.map(p=>Math.abs(p.y))) * 4) / 4));
  const errors = $derived(Array.from({length:256},(_,i)=>{const k=i*8;return {x:result.input[k],raw:1000*(result.raw[k]-result.input[k]),after:1000*(result.calibrated[k]-result.input[k])};}).sort((a,b)=>a.x-b.x));
  const errorScale = $derived(Math.max(1,...errors.map(p=>Math.max(Math.abs(p.raw),Math.abs(p.after)))));
  const harmonics = $derived([1,2,3,4,5,6,7].map(h=>({h,before:result.before.dbfs[h*TONE],after:result.after.dbfs[h*TONE]})));
  const outside = $derived(usedFit && amplitude > usedFit.training.amplitude);
  function train() { fit = fitInverse(device, training); enabled = true; }
  function preset(which: string) {
    device = which==='clip' ? {quadratic:.08,cubic:.35,noiseMv:.3} : {...DEFAULTS};
    training = {...TRAINING, amplitude:which==='narrow' ? .35 : .95}; amplitude = .85;
    train();
  }
</script>

<main class="course">
  <div class="toolbar"><p class="course-intro">Learn an inverse from a known ramp. Keep the coefficients fixed and test on a new sine wave.</p><div class="actions" aria-label="Calibration examples"><button onclick={()=>preset('normal')}>Smooth distortion</button><button onclick={()=>preset('narrow')}>Narrow training</button><button onclick={()=>preset('clip')}>Clipping</button></div></div>
  <section class="panel">
    <div class="flow"><div><b>1 · Known reference →</b><small>Training ramp covers ±{(currentFit?.training.amplitude ?? training.amplitude).toFixed(2)} V</small><span class="value">x, known</span></div><div><b>2 · Distorted ADC →</b><small>12 bits + output noise</small><span class="value">y = Q[f(x)]</span></div><div><b>3 · Fit an inverse →</b><small>Minimize Σ[g(y) − x]²</small><span class="value">g(y) = Σ cₖỹᵏ</span></div><div><b>4 · Validate</b><small>New signal, independent noise</small><span class="value">x̂ = g(yₙₑw)</span></div></div>
  </section>
  <section class="panel controls" aria-label="Calibration controls">
    <Range id="cal-a2" bind:value={device.quadratic} min={-.15} max={.15} step={.01} output={device.quadratic.toFixed(2)}>Quadratic a₂</Range>
    <Range id="cal-a3" bind:value={device.cubic} min={-.35} max={.4} step={.01} output={device.cubic.toFixed(2)}>Cubic a₃</Range>
    <Range id="cal-noise" bind:value={device.noiseMv} min={0} max={3} step={.1} output={`${device.noiseMv.toFixed(1)} mV rms`}>ADC output noise</Range>
    <Range id="cal-train" bind:value={training.amplitude} min={.2} max={.98} step={.01} output={`±${training.amplitude.toFixed(2)} V`}>Training coverage</Range>
    <div class="control"><span>Inverse polynomial degree</span><Segmented label="Inverse polynomial degree" options={[1,3,5,7].map(value=>({value,label:`${value}`}))} bind:value={training.degree}/></div>
    <Range id="cal-validation" bind:value={amplitude} min={.2} max={.98} step={.01} output={`±${amplitude.toFixed(2)} V`}>Validation sine amplitude</Range>
  </section>
  <div class="toolbar"><div class="actions"><button class="primary" onclick={train}>{pending ? 'Train inverse' : 'Retrain inverse'}</button><button disabled={!currentFit} aria-pressed={enabled&&!!currentFit} onclick={()=>enabled=!enabled}>Calibration {enabled&&currentFit ? 'on' : 'off'}</button></div><p class="note">{!currentFit ? 'ADC changed: train the inverse for this device.' : pending ? 'Training settings changed. Existing coefficients are held until you train again.' : `${currentFit.training.count} training samples · degree ${currentFit.training.degree} · ${N} independent validation samples`}</p></div>
  <div class="two">
    <section class="panel"><h2>Transfer curve · straighten the bend</h2><div class="plot-box"><CoursePlot label="ADC transfer before and after calibration" xDomain={[-1,1]} yDomain={[-transferExtent,transferExtent]} xLabel="known input · V" yLabel="output · V" series={[{name:'Ideal',color:'var(--ink-3)',dashed:true,points:[{x:-1,y:-1},{x:1,y:1}]},{name:'Raw',color:'var(--s2)',points:rawTransfer},{name:'Corrected',color:'var(--brand)',points:correctedTransfer}]}/></div><div class="coverage" aria-label="Training coverage"><span style:left={`${(1-(currentFit?.training.amplitude??training.amplitude))/2*100}%`} style:width={`${(currentFit?.training.amplitude??training.amplitude)*100}%`}>{currentFit ? 'trained region' : 'requested training region'}</span></div></section>
    <section class="panel"><h2>Validation error · same unseen samples</h2><div class="plot-box"><CoursePlot label="Independent validation error versus input" xDomain={[-1,1]} yDomain={[-errorScale,errorScale]} xLabel="validation input · V" yLabel="output − input · mV" series={[{name:'Raw',color:'var(--s2)',points:errors.map(p=>({x:p.x,y:p.raw}))},{name:'Corrected',color:'var(--brand)',points:errors.map(p=>({x:p.x,y:p.after}))}]}/></div><p class="note">Both curves share the same axis. Quantization and noise remain after deterministic distortion is corrected.</p></section>
  </div>
  <section class="panel">
    <div class="toolbar"><h2>Harmonics shrink on the independent validation record</h2><div class="readouts"><div><span>SNDR before → after</span><b class="result">{result.before.sndr.toFixed(1)} → {result.after.sndr.toFixed(1)} dB</b></div><div><span>RMS error before → after</span><b class="result">{(1000*result.rmsBefore).toFixed(2)} → {(1000*result.rmsAfter).toFixed(2)} mV</b></div></div></div>
    <div class="harmonics" role="img" aria-label="Fundamental and harmonic amplitudes before and after calibration, from minus 100 to zero dBFS">
      <div class="db-axis"><span>0 dBFS</span><span>−50</span><span>−100</span></div>
      {#each harmonics as h}<div class="harmonic"><div class="stems"><i class="before" style:height={`${Math.max(0,Math.min(100,100+h.before))}%`} title={`Raw H${h.h}: ${h.before.toFixed(1)} dBFS`}></i><i class="after" style:height={`${Math.max(0,Math.min(100,100+h.after))}%`} title={`Corrected H${h.h}: ${h.after.toFixed(1)} dBFS`}></i></div><b>{h.h===1 ? 'Tone' : `H${h.h}`}</b><small>{h.before.toFixed(0)} / {h.after.toFixed(0)}</small></div>{/each}
    </div>
    <p class="note"><span class="raw-key">■ Raw</span> / <span class="cal-key">■ Corrected</span> · dBFS per FFT bin. Coherent sine: {TONE}/{N} cycles/sample. SNDR includes every non-DC, non-fundamental bin, not just these harmonics.</p>
    {#if result.clipped>0}<p class="warning">{result.clipped} validation samples reach an ADC rail. Clipping loses information; an inverse cannot restore it.</p>{/if}
    {#if outside}<p class="warning">Validation exceeds the trained range. This is extrapolation: compare the error and SNDR before trusting it.</p>{/if}
    {#if minimumSlope(device,Math.max(amplitude,training.amplitude))<=0}<p class="warning">The analog transfer folds within this range. Different inputs can produce the same output, so a unique inverse does not exist.</p>{/if}
  </section>
  <details><summary>What is being calibrated?</summary><p>f(x) = x + a₂x² + a₃x³, followed by additive output noise, 12-bit quantization and saturation. A known reference ramp supplies training pairs (x, y); a polynomial maps measured y back toward x. ỹ is y divided by the largest training magnitude. This foreground method assumes an accurate external reference. It corrects static distortion; it does not recover clipped information or remove random noise. Changing the validation amplitude never refits the coefficients.</p></details>
</main>
<style>
  .coverage { position:relative; height:22px; margin:8px 14px 0 48px; background:var(--ground); border-radius:4px; overflow:hidden; } .coverage span { position:absolute; text-align:center; color:var(--brand); font:11px/22px var(--mono); background:var(--brand-soft); }
  .harmonics { display:grid; grid-template-columns:58px repeat(7,minmax(0,1fr)); gap:12px; margin:24px 0 18px; }
  .db-axis { display:flex; flex-direction:column; justify-content:space-between; height:150px; font:10px var(--mono); color:var(--ink-3); } .harmonic { text-align:center; } .stems { display:flex; justify-content:center; align-items:end; gap:5px; height:150px; border-bottom:1px solid var(--rule); background:repeating-linear-gradient(to top,transparent 0,transparent 74px,var(--rule) 74px,var(--rule) 75px); }
  .stems i { width:14px; min-height:1px; border-radius:3px 3px 0 0; } .before { background:var(--s2); } .after { background:var(--brand); } .harmonic b { display:block; margin:8px 0 4px; font:12px var(--mono); } .harmonic small { font:10px var(--mono); color:var(--ink-3); }
  .raw-key { color:var(--s2); } .cal-key { color:var(--brand); } .warning { color:var(--s2); font-size:13px; padding:10px 14px; background:var(--ground); border-radius:6px; }
  @media(max-width:600px) { .harmonics { gap:5px; grid-template-columns:42px repeat(7,minmax(0,1fr)); } .stems { gap:3px; } .stems i { width:9px; } .harmonic small { font-size:8px; } }
</style>
