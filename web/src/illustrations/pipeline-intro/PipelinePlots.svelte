<script lang="ts">
  import CurvePanel from './CurvePanel.svelte';
  import { transferSteps } from './configurable';
  import { linearityDomain, VOLTAGE_DOMAIN } from './display';
  import { type ErrorConversion, type PipelineErrorSettings, type LinearityAnalysis } from './errors';
  import SharedResidues from './SharedResidues.svelte';
  let { bits, settings, analysis, conversion, domain, mobileView }: {
    bits:readonly number[]; settings:PipelineErrorSettings; analysis:LinearityAnalysis; conversion:ErrorConversion;
    domain:[number,number]; mobileView:'stages'|'overall';
  } = $props();
  type Point = {x:number;y:number};
  type Series = {points:Point[];ghost?:boolean};
  const rangeText = (values:number[]) => {
    let low=Infinity,high=-Infinity;
    for(const v of values){low=Math.min(low,v);high=Math.max(high,v);}
    return `${Math.abs(low)<.00005?'0':low.toFixed(3)} … ${Math.abs(high)<.00005?'0':high.toFixed(3)} LSB`;
  };
  const codeDomain = $derived<[number,number]>([0,analysis.levels]);
  const inlCode = $derived(Math.max(1,conversion.code));
  const inlMarker = $derived(analysis.endpointInl[inlCode] === null ? undefined : {x:inlCode,y:analysis.endpointInl[inlCode]!});
  const geometry = $derived.by(()=>{
    const transfer:Series[]=transferSteps(bits,domain).map(s=>({points:[{x:s.x0,y:s.y},{x:s.x1,y:s.y}],ghost:true}));
    for(let k=0;k<analysis.levels;k++){
      const x0=Math.max(domain[0],analysis.thresholds[k]),x1=Math.min(domain[1],analysis.thresholds[k+1]);
      if(x1<=x0)continue;
      const y=(k+.5)/analysis.levels;
      transfer.push({points:[{x:x0,y},{x:x1,y}]});
    }
    return {transfer};
  });
  // Full-range linearity and endpoint fitting are independent of the input cursor and zoom.
  const linearity = $derived.by(()=>{
    const dnl:Series[]=[{points:analysis.nominalDnl.flatMap((y,k)=>[{x:k,y},{x:k+1,y}])}];
    const inl:Series[]=[]; let branch:Point[]=[];
    analysis.endpointInl.forEach((y,k)=>{if(y===null){if(branch.length)inl.push({points:branch});branch=[];}else branch.push({x:k,y});});
    if(branch.length)inl.push({points:branch});
    const inlValues=analysis.endpointInl.filter((v):v is number=>v!==null);
    return {dnl,inl,dnlDomain:linearityDomain(analysis.nominalDnl),inlDomain:linearityDomain(inlValues),
      dnlDetail:rangeText(analysis.nominalDnl),inlDetail:rangeText(inlValues)};
  });
</script>

<div class="plot-layout" class:show-overall={mobileView==='overall'}>
  <section class="residue-section" aria-label="Progressive residue curves for every stage">
    <header class="section-heading"><h2>Each row expands the selected interval above</h2><span>Original input · V</span></header>
    {#key bits.join(',')}
      <SharedResidues {bits} {settings} {analysis} {conversion}/>
    {/key}
  </section>
  <section class="linearity-section" aria-label="Overall converter performance">
    <CurvePanel title="DNL" detail={linearity.dnlDetail} color="#147a9c" xDomain={codeDomain} yDomain={linearity.dnlDomain} xLabel="Output code" yLabel="DNL · nominal LSB" series={linearity.dnl} marker={{x:conversion.code+.5,y:analysis.nominalDnl[conversion.code]}} vertical={conversion.code+.5}/>
    <CurvePanel title="INL · endpoint fit" detail={linearity.inlDetail} color="#b64e69" xDomain={codeDomain} yDomain={linearity.inlDomain} xLabel="Transition code" yLabel="INL · fitted LSB" series={linearity.inl} marker={inlMarker} vertical={inlCode}/>
    <CurvePanel title="ADC transfer" color="#ad6b09" xDomain={domain} yDomain={VOLTAGE_DOMAIN} xLabel="Original input · V" yLabel="Output · V" series={geometry.transfer} marker={{x:conversion.input,y:conversion.estimate}} vertical={conversion.input}/>
  </section>
</div>
<style>
  .plot-layout { height:100%; min-height:0; display:grid; grid-template-columns:minmax(0,1.9fr) minmax(0,1fr); gap:26px; }
  .residue-section { display:grid; grid-template-rows:auto minmax(0,1fr); min-width:0; min-height:0; gap:8px; }
  .section-heading { display:flex; align-items:baseline; justify-content:space-between; gap:10px; min-width:0; }
  h2 { margin:0; font:600 13px var(--sans); color:var(--ink); }.section-heading span { color:var(--ink-3); font:10px var(--sans); }
  .linearity-section { display:grid; grid-template-rows:minmax(0,1fr) minmax(0,1fr) minmax(0,.9fr); gap:18px; min-height:0; min-width:0; border-left:1px solid var(--rule); padding-left:20px; }
  @media(max-width:850px) {
    .plot-layout { grid-template-columns:minmax(0,1fr); }
    .linearity-section { display:none; border-left:0; padding-left:0; }.show-overall .linearity-section { display:grid; }.show-overall .residue-section { display:none; }
    .section-heading span { font-size:9px; }.section-heading h2 { font-size:12px; }
  }
  @media(max-height:550px) {
    .plot-layout { gap:16px; }.linearity-section { gap:8px; padding-left:12px; }.residue-section { gap:4px; }
  }
</style>
