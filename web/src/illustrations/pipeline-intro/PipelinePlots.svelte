<script lang="ts">
  import CurvePanel from './CurvePanel.svelte';
  import { transferSteps } from './configurable';
  import { type ErrorConversion, type ErrorSettings, type LinearityAnalysis } from './errors';
  import SharedResidues from './SharedResidues.svelte';
  let { bits, settings, analysis, conversion, domain, mobileView }: {
    bits:readonly number[]; settings:ErrorSettings; analysis:LinearityAnalysis; conversion:ErrorConversion;
    domain:[number,number]; mobileView:'stages'|'overall';
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
  const codeDomain = $derived<[number,number]>([0,analysis.levels]);
  const inlCode = $derived(Math.max(1,conversion.code));
  const inlMarker = $derived(analysis.endpointInl[inlCode] === null ? undefined : {x:inlCode,y:analysis.endpointInl[inlCode]!});
  const errorDomain:[number,number] = [0,1];
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
    return {dnl,inl,error,dnlDomain:extent(analysis.nominalDnl,.02),inlDomain:extent(inlValues,.2),errorDomain:extent(errorValues,1),
      dnlDetail:rangeText(analysis.nominalDnl),inlDetail:rangeText(inlValues),errorDetail:rangeText(errorValues)};
  });
</script>

<div class="plot-layout" class:show-overall={mobileView==='overall'}>
  <section class="residue-section" aria-label="Progressive residue curves for every stage">
    <header class="section-heading"><h2>Each row expands the selected interval above</h2><span>Original input · V</span></header>
    <SharedResidues {bits} {settings} {analysis} {conversion}/>
  </section>
  <section class="linearity-section" aria-label="Overall converter performance">
    <CurvePanel title="DNL" detail={linearity.dnlDetail} color="#147a9c" xDomain={codeDomain} yDomain={linearity.dnlDomain} xLabel="Output code" yLabel="DNL · nominal LSB" series={linearity.dnl} marker={{x:conversion.code+.5,y:analysis.nominalDnl[conversion.code]}} vertical={conversion.code+.5}/>
    <CurvePanel title="INL · endpoint fit" detail={linearity.inlDetail} color="#b64e69" xDomain={codeDomain} yDomain={linearity.inlDomain} xLabel="Transition code" yLabel="INL · fitted LSB" series={linearity.inl} marker={inlMarker} vertical={inlCode}/>
    <div class="secondary-plots">
      <CurvePanel title="ADC transfer" color="#ad6b09" xDomain={domain} yDomain={geometry.transferDomain} xLabel="Original input · V" yLabel="Output · V" series={geometry.transfer} marker={{x:conversion.input,y:conversion.estimate}} vertical={conversion.input}/>
      <CurvePanel title="Conversion error" color="#5367b6" xDomain={errorDomain} yDomain={linearity.errorDomain} xLabel="Original input · V" yLabel="Error · LSB" series={linearity.error} marker={{x:conversion.input,y:conversion.error*analysis.levels}} vertical={conversion.input}/>
    </div>
  </section>
</div>
<style>
  .plot-layout { height:100%; min-height:0; display:grid; grid-template-columns:minmax(0,1.9fr) minmax(0,1fr); gap:26px; }
  .residue-section { display:grid; grid-template-rows:auto minmax(0,1fr); min-width:0; min-height:0; gap:8px; }
  .section-heading { display:flex; align-items:baseline; justify-content:space-between; gap:10px; min-width:0; }
  h2 { margin:0; font:600 13px var(--sans); color:var(--ink); }.section-heading span { color:var(--ink-3); font:10px var(--sans); }
  .linearity-section { display:grid; grid-template-rows:minmax(0,1fr) minmax(0,1fr) minmax(0,.9fr); gap:18px; min-height:0; min-width:0; border-left:1px solid var(--rule); padding-left:20px; }
  .secondary-plots { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; min-height:0; min-width:0; }
  @media(max-width:850px) {
    .plot-layout { grid-template-columns:minmax(0,1fr); }
    .linearity-section { display:none; border-left:0; padding-left:0; }.show-overall .linearity-section { display:grid; }.show-overall .residue-section { display:none; }
    .section-heading span { font-size:9px; }.section-heading h2 { font-size:12px; }
  }
  @media(max-height:550px) {
    .plot-layout { gap:16px; }.linearity-section { gap:8px; padding-left:12px; }.residue-section { gap:4px; }
  }
</style>
