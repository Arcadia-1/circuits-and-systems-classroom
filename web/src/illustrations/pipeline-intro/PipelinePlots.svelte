<script lang="ts">
  import CurvePanel from './CurvePanel.svelte';
  import { transferSteps } from './configurable';
  import { convertWithErrors, type ErrorConversion, type ErrorSettings, type LinearityAnalysis } from './errors';
  import { localStageCurves } from './stage-curves';
  let { bits, settings, analysis, conversion, domain, magnify, mobileView }: {
    bits:readonly number[]; settings:ErrorSettings; analysis:LinearityAnalysis; conversion:ErrorConversion;
    domain:[number,number]; magnify:boolean; mobileView:'stages'|'overall';
  } = $props();
  type Point = {x:number;y:number};
  type Series = {points:Point[];ghost?:boolean};
  const extent = (values:number[], floor:number):[number,number] => {
    let low=0,high=0;
    for(const value of values) {low=Math.min(low,value);high=Math.max(high,value);}
    const span=Math.max(floor,high-low), pad=span*.1;
    return [Math.min(low,-floor/2)-pad,Math.max(high,floor/2)+pad];
  };
  const rangeText = (values:number[]) => {
    let low=Infinity,high=-Infinity;
    for(const v of values){low=Math.min(low,v);high=Math.max(high,v);}
    return `${Math.abs(low)<.00005?'0':low.toFixed(3)} … ${Math.abs(high)<.00005?'0':high.toFixed(3)} LSB`;
  };
  const codeDomain = $derived<[number,number]>(magnify ? [
    convertWithErrors(domain[0],bits,settings).code,
    convertWithErrors(domain[1]-(domain[1]-domain[0])*1e-10,bits,settings).code+1
  ] : [0,analysis.levels]);
  const inlCode = $derived(Math.max(1,conversion.code));
  const inlMarker = $derived(analysis.endpointInl[inlCode] === null ? undefined : {x:inlCode,y:analysis.endpointInl[inlCode]!});
  const errorDomain = $derived<[number,number]>(magnify?domain:[0,1]);
  const stageCurves = $derived(localStageCurves(bits,settings));
  const stageColumns = $derived(bits.length>5?5:bits.length);
  const stageRows = $derived(Math.ceil(bits.length/stageColumns));
  const stageColors = ['#008b91','#8250d1','#147a9c','#ad6b09','#b64e69','#44795d','#5367b6','#977040','#357b83','#576375'];
  const padded = (d:[number,number]):[number,number] => [d[0]-(d[1]-d[0])*.04,d[1]+(d[1]-d[0])*.04];
  const geometry = $derived.by(()=>{
    const transfer:Series[]=transferSteps(bits,domain).map(s=>({points:[{x:s.x0,y:s.y},{x:s.x1,y:s.y}],ghost:true}));
    let low=domain[0],high=domain[1];
    for(let k=0;k<analysis.levels;k++){
      const x0=Math.max(domain[0],analysis.thresholds[k]),x1=Math.min(domain[1],analysis.thresholds[k+1]);
      if(x1<=x0)continue;
      const y=(k+.5)/analysis.levels;
      transfer.push({points:[{x:x0,y},{x:x1,y}]});low=Math.min(low,y);high=Math.max(high,y);
    }
    const pad=(high-low)*.04;
    return {transfer,transferDomain:[low-pad,high+pad] as [number,number]};
  });
  // Full-range linearity and endpoint fitting are independent of the input cursor and zoom.
  const linearity = $derived.by(()=>{
    const n=analysis.levels;
    const dnl:Series[]=[{points:analysis.nominalDnl.flatMap((y,k)=>[{x:k,y},{x:k+1,y}])}];
    const inl:Series[]=[]; let branch:Point[]=[];
    analysis.endpointInl.forEach((y,k)=>{if(y===null){if(branch.length)inl.push({points:branch});branch=[];}else branch.push({x:k,y});});
    if(branch.length)inl.push({points:branch});
    const inlValues=analysis.endpointInl.filter((v):v is number=>v!==null);
    const error:Series[]=[],errorValues:number[]=[];
    for(let k=0;k<n;k++){
      const x0=analysis.thresholds[k],x1=analysis.thresholds[k+1];
      if(x1<=x0)continue;
      const y0=k+.5-x0*n,y1=k+.5-x1*n;
      error.push({points:[{x:x0,y:y0},{x:x1,y:y1}]});errorValues.push(y0,y1);
    }
    return {dnl,inl,error,dnlDomain:extent(analysis.nominalDnl,.2),inlDomain:extent(inlValues,.2),errorDomain:extent(errorValues,1),
      dnlDetail:rangeText(analysis.nominalDnl),inlDetail:rangeText(inlValues),errorDetail:rangeText(errorValues)};
  });
</script>

<div class="all-plots" class:show-overall={mobileView==='overall'} class:many-stages={bits.length>5}>
  <section class="stage-section" aria-label="All pipeline stages">
    <header class="section-heading"><h2>All {bits.length} stages</h2><span>Local input (V) → residue (V) · last stage → code</span></header>
    <div class="stage-grid" style:--stage-columns={stageColumns} style:--stage-rows={stageRows}>
      {#each stageCurves as curves,i}
        {@const stage=conversion.stages[i]}
        <CurvePanel title={`Stage ${i+1}${curves.flash?' · Flash':''}`} detail={`${stage.bits}-bit${curves.flash?'':` · ×${stage.gain}`} · q=${stage.digit}`} color={stageColors[i%stageColors.length]}
          xDomain={curves.xDomain} yDomain={padded(curves.yDomain)} xLabel="Local input · V" yLabel={curves.flash?'Digital code':'Residue · V'}
          series={[...curves.ideal.map(points=>({points,ghost:true})),...curves.actual.map(points=>({points}))]}
          marker={{x:stage.input,y:curves.flash?stage.digit:stage.residue}} vertical={stage.input} compact highlight={i===settings.stage}/>
      {/each}
    </div>
  </section>
  <section class="overall-section" aria-label="Overall converter performance">
    <header class="section-heading"><h2>Overall {conversion.totalBits}-bit ADC</h2><span>{magnify?'16-LSB input window · full-range extrema':'Full input range'} · {analysis.missingCodes.length} missing codes</span></header>
    <div class="overall-grid">
      <CurvePanel title="Transfer function" detail="Nominal code centres" color="#ad6b09" xDomain={domain} yDomain={geometry.transferDomain} xLabel="Original input · V" yLabel="Output · V" series={geometry.transfer} marker={{x:conversion.input,y:conversion.estimate}} vertical={conversion.input}/>
      <CurvePanel title="DNL" detail={linearity.dnlDetail} color="#147a9c" xDomain={codeDomain} yDomain={linearity.dnlDomain} xLabel="Output code" yLabel="DNL · nominal LSB" series={linearity.dnl} marker={{x:conversion.code+.5,y:analysis.nominalDnl[conversion.code]}} vertical={conversion.code+.5}/>
      <CurvePanel title="INL · endpoint fit" detail={linearity.inlDetail} color="#b64e69" xDomain={codeDomain} yDomain={linearity.inlDomain} xLabel="Transition code" yLabel="INL · fitted LSB" series={linearity.inl} marker={inlMarker} vertical={inlCode}/>
      <CurvePanel title="Conversion error" detail={linearity.errorDetail} color="#5367b6" xDomain={errorDomain} yDomain={linearity.errorDomain} xLabel="Original input · V" yLabel="Error · LSB" series={linearity.error} marker={{x:conversion.input,y:conversion.error*analysis.levels}} vertical={conversion.input}/>
    </div>
  </section>
</div>
<style>
  .all-plots { height:100%; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) minmax(0,1fr); gap:16px; }
  .all-plots.many-stages { grid-template-rows:minmax(0,1.45fr) minmax(0,1fr); }
  .stage-section,.overall-section { display:grid; grid-template-rows:auto minmax(0,1fr); min-width:0; min-height:0; gap:9px; }
  .section-heading { display:flex; align-items:baseline; justify-content:space-between; gap:10px; min-width:0; }
  h2 { margin:0; font:600 12px var(--sans); color:var(--ink); }.section-heading span { color:var(--ink-3); font:10px var(--sans); }
  .stage-grid { display:grid; grid-template-columns:repeat(var(--stage-columns),minmax(0,1fr)); grid-template-rows:repeat(var(--stage-rows),minmax(0,1fr)); gap:10px 12px; min-height:0; }
  .overall-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); min-height:0; gap:16px; }
  @media(max-width:1050px), (max-height:600px) {
    .all-plots,.all-plots.many-stages { grid-template-rows:minmax(0,1fr); }
    .overall-section { display:none; }.show-overall .overall-section { display:grid; }.show-overall .stage-section { display:none; }
    .stage-grid { grid-template-columns:repeat(var(--stage-columns),minmax(0,1fr)); }
    .overall-grid { grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-rows:repeat(2,minmax(0,1fr)); gap:12px; }
  }
  @media(max-width:700px) {
    .stage-grid { grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-rows:repeat(2,minmax(0,1fr)); gap:7px; }
    .many-stages .stage-grid { grid-template-rows:repeat(5,minmax(0,1fr)); }
    .section-heading span { font-size:8px; max-width:57%; text-align:right; }.section-heading h2 { font-size:11px; }
    .stage-section,.overall-section { gap:7px; }
    .overall-grid { gap:10px; }
  }
  @media(max-height:600px) and (min-width:701px) {
    .stage-section,.overall-section { gap:4px; }.section-heading h2 { font-size:10px; }.section-heading span { font-size:8px; }
    .stage-grid { gap:5px 9px; }
    .overall-grid { grid-template-columns:repeat(4,minmax(0,1fr)); grid-template-rows:minmax(0,1fr); gap:10px; }
  }
</style>
