<script lang="ts">
  import CurvePanel from './CurvePanel.svelte';
  import { residueRamps, transferSteps } from './configurable';
  import { actualResidueCurves, convertWithErrors, type ErrorConversion, type ErrorSettings, type LinearityAnalysis } from './errors';
  let { bits, settings, analysis, conversion, first, domain, magnify, mobileView }: {
    bits:readonly number[]; settings:ErrorSettings; analysis:LinearityAnalysis; conversion:ErrorConversion;
    first:number; domain:[number,number]; magnify:boolean; mobileView:'curves'|'linearity';
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
  const errorDomain = $derived<[number,number]>(magnify?domain:[0,1]);
  const geometry = $derived.by(()=>{
    const residues = [first,first+1].map(stage=>{
      const actual=actualResidueCurves(bits,settings,analysis,stage,domain);
      const ideal=residueRamps(bits,stage,domain).map(r=>({points:[{x:r.x0,y:r.y0},{x:r.x1,y:r.y1}],ghost:true}));
      const values=actual.flatMap(branch=>branch.map(p=>p.y));
      return {series:[...ideal,...actual.map(points=>({points}))] as Series[], domain:[Math.min(-.06,...values),Math.max(1.06,...values)] as [number,number]};
    });
    const transfer:Series[]=transferSteps(bits,domain).map(s=>({points:[{x:s.x0,y:s.y},{x:s.x1,y:s.y}],ghost:true}));
    let low=domain[0],high=domain[1];
    for(let k=0;k<analysis.levels;k++){
      const x0=Math.max(domain[0],analysis.thresholds[k]),x1=Math.min(domain[1],analysis.thresholds[k+1]);
      if(x1<=x0)continue;
      const y=(k+.5)/analysis.levels;
      transfer.push({points:[{x:x0,y},{x:x1,y}]});low=Math.min(low,y);high=Math.max(high,y);
    }
    const pad=(high-low)*.04;
    return {residues,transfer,transferDomain:[low-pad,high+pad] as [number,number]};
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

<div class="six-plots" class:show-linearity={mobileView==='linearity'}>
  <section class="column curves" aria-label="Residues and transfer function">
    {#each [0,1] as row}
      {@const stage=conversion.stages[first+row]}
      <CurvePanel title={`Stage ${stage.index+1} residue`} detail={`${stage.bits}-bit · ×${stage.gain}${stage.injected?' · error applied':''}`} color={row===0?'#008b91':'#8250d1'} xDomain={domain} yDomain={geometry.residues[row].domain} xLabel="Original input · V" yLabel="Residue · V" series={geometry.residues[row].series} marker={{x:conversion.input,y:stage.residue}} vertical={conversion.input}/>
    {/each}
    <CurvePanel title={`${conversion.totalBits}-bit transfer`} detail="Nominal code centres" color="#ad6b09" xDomain={domain} yDomain={geometry.transferDomain} xLabel="Original input · V" yLabel="Output · V" series={geometry.transfer} marker={{x:conversion.input,y:conversion.estimate}} vertical={conversion.input}/>
  </section>
  <section class="column linearity" aria-label="Full-range linearity and conversion error">
    <CurvePanel title="DNL" detail={linearity.dnlDetail} color="#147a9c" xDomain={codeDomain} yDomain={linearity.dnlDomain} xLabel="Output code" yLabel="DNL · nominal LSB" series={linearity.dnl} marker={{x:conversion.code+.5,y:analysis.nominalDnl[conversion.code]}} vertical={conversion.code+.5}/>
    <CurvePanel title="INL · endpoint fit" detail={linearity.inlDetail} color="#b64e69" xDomain={codeDomain} yDomain={linearity.inlDomain} xLabel="Transition code · observed range" yLabel="INL · fitted LSB" series={linearity.inl} vertical={conversion.code}/>
    <CurvePanel title="Conversion error" detail={linearity.errorDetail} color="#5367b6" xDomain={errorDomain} yDomain={linearity.errorDomain} xLabel="Original input · V" yLabel="Error · LSB" series={linearity.error} marker={{x:conversion.input,y:conversion.error*analysis.levels}} vertical={conversion.input}/>
  </section>
</div>
<style>
  .six-plots { height:100%; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
  .column { display:grid; grid-template-rows:repeat(3,minmax(0,1fr)); gap:10px; min-height:0; min-width:0; }
  @media(max-width:700px) { .six-plots { grid-template-columns:minmax(0,1fr); }.linearity { display:none; }.show-linearity .linearity { display:grid; }.show-linearity .curves { display:none; }.column { gap:7px; } }
  @media(max-height:550px) and (min-width:701px) {
    .six-plots { grid-template-columns:minmax(0,1fr); }
    .column { grid-template-columns:repeat(3,minmax(0,1fr)); grid-template-rows:minmax(0,1fr); gap:12px; }
    .linearity { display:none; }.show-linearity .linearity { display:grid; }.show-linearity .curves { display:none; }
  }
</style>
