<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import { nf } from '../../lib/format';
  import { FN, Z0, type Analysis224g } from './model';

  let { a }: { a: Analysis224g } = $props();

  const left = 46, right = 14, top = 14, bot = 24;
  const fMaxGhz = 84;
  const freqTicks = [0, 14, 28, 42, 56, 70, 84];

  const dbBounds = $derived.by(() => {
    let lo = -55;
    for (let i = 0; i < a.freq.s21Db.length; i++) {
      if (a.freq.freqsGhz[i] <= 64) lo = Math.min(lo, a.freq.s21Db[i]);
    }
    return { lo: Math.max(-75, Math.floor(lo / 10) * 10 - 5), hi: 5 };
  });

  const dbTicks = $derived.by(() => {
    const out: number[] = [];
    for (let d = 0; d >= dbBounds.lo; d -= 10) out.push(d);
    return out;
  });

  const xF = (fGhz: number, w: number) => left + (fGhz / fMaxGhz) * Math.max(1, w - left - right);
  const yDb = (db: number, h: number) => {
    const clamped = Math.max(dbBounds.lo, Math.min(dbBounds.hi, db));
    return top + ((dbBounds.hi - clamped) / (dbBounds.hi - dbBounds.lo)) * Math.max(1, h - top - bot);
  };

  function pathF(vals: Float32Array, w: number, h: number): string {
    let d = '';
    for (let i = 0; i < vals.length; i++) {
      d += `${i ? 'L' : 'M'}${xF(a.freq.freqsGhz[i], w).toFixed(1)},${yDb(vals[i], h).toFixed(1)}`;
    }
    return d;
  }

  // TDR plot scaling
  const totalMm = $derived(a.tdr.distMm[a.tdr.distMm.length - 1] || 32);
  const zBounds = $derived.by(() => {
    let lo = 25, hi = 80;
    for (let i = 0; i < a.tdr.zOhm.length; i++) {
      lo = Math.min(lo, a.tdr.zOhm[i]);
      hi = Math.max(hi, a.tdr.zOhm[i]);
    }
    return { lo: Math.max(10, Math.floor(lo / 10) * 10), hi: Math.min(115, Math.ceil(hi / 10) * 10) };
  });
  const xD = (mm: number, w: number) => left + (mm / totalMm) * Math.max(1, w - left - right);
  const yZ = (z: number, h: number) => {
    const clamped = Math.max(zBounds.lo, Math.min(zBounds.hi, z));
    return top + ((zBounds.hi - clamped) / (zBounds.hi - zBounds.lo)) * Math.max(1, h - top - bot);
  };
  function tdrPath(w: number, h: number): string {
    let d = '';
    for (let i = 0; i < a.tdr.distMm.length; i++) {
      d += `${i ? 'L' : 'M'}${xD(a.tdr.distMm[i], w).toFixed(1)},${yZ(a.tdr.zOhm[i], h).toFixed(1)}`;
    }
    return d;
  }

  let hoverIdx = $state<number | null>(null);
</script>

<div class="two sparam-grid">
  <section class="panel chart-card">
    <div class="card-head">
      <div>
        <h2>2a · Frequency domain: S<sub>21</sub> notches &amp; S<sub>11</sub> return loss</h2>
        <p class="note">
          S<sub>21</sub>(56 GHz) = <b class="mono">{nf(a.freq.s21AtFnDb, 1)} dB</b> ·
          Worst S<sub>11</sub> = <b class="mono">{nf(a.freq.s11MaxDb, 1)} dB</b> ·
          Deepest notch = <b class="mono">{nf(a.freq.notchDepthDb, 1)} dB</b> ·
          Δf ≈ <b class="mono">{a.geometry.notchSpacingGhz.toFixed(1)} GHz</b>
        </p>
      </div>
      <div class="mini-legend">
        <span><i style:background="var(--s1)"></i><span>S<sub>21</sub></span></span>
        <span><i class="dash-leg"></i><span>50 Ω smooth</span></span>
        <span><i style:background="var(--s2)"></i><span>S<sub>11</sub></span></span>
      </div>
    </div>
    <div class="plot-box">
      <Plot
        label="Channel S21 insertion loss with reflection notches and S11 return loss from 0 to 84 GHz"
        onpointermove={(x, w) => {
          const fGhz = ((x - left) / Math.max(1, w - left - right)) * fMaxGhz;
          if (fGhz >= 0 && fGhz <= fMaxGhz) hoverIdx = Math.max(0, Math.min(a.freq.freqsGhz.length - 1, Math.round(fGhz * 2)));
          else hoverIdx = null;
        }}
        onpointerleave={() => (hoverIdx = null)}
      >
        {#snippet children({ width: w, height: h })}
          {#if w > 0 && h > 60}
            {#each dbTicks as db (db)}
              <line class={db === 0 ? 'zero' : 'gr'} x1={left} x2={w - right} y1={yDb(db, h)} y2={yDb(db, h)} />
              <text class="tx" text-anchor="end" x={left - 6} y={yDb(db, h) + 4}>{db === 0 ? '0 dB' : db}</text>
            {/each}
            {#each freqTicks as f (f)}
              <text class="tx" text-anchor={f === 84 ? 'end' : f === 0 ? 'start' : 'middle'} x={xF(f, w)} y={h - 6}>
                {f === 84 ? '84 GHz' : f}
              </text>
            {/each}
            <line class="guide" x1={xF(FN / 1e9, w)} x2={xF(FN / 1e9, w)} y1={top} y2={h - bot} stroke-dasharray="3 3" />
            <text class="tx2" x={xF(FN / 1e9, w) + 4} y={top + 11}>f<tspan font-size="0.72em" dy="2">N</tspan><tspan dy="-2"> 56G</tspan></text>

            <path d={pathF(a.freq.s21SmoothDb, w, h)} fill="none" stroke="var(--ink-3)" stroke-width="1.4" stroke-dasharray="4 3" opacity="0.7" />
            <path class="c2" d={pathF(a.freq.s11Db, w, h)} stroke-width="1.6" />
            <path class="c1" d={pathF(a.freq.s21Db, w, h)} stroke-width="2" />

            {#if hoverIdx !== null}
              {@const fG = a.freq.freqsGhz[hoverIdx]}
              {@const hx = xF(fG, w)}
              <line class="cross" x1={hx} x2={hx} y1={top} y2={h - bot} opacity="0.45" />
              <circle class="f1 ring" cx={hx} cy={yDb(a.freq.s21Db[hoverIdx], h)} r="3.5" />
              <circle class="f2 ring" cx={hx} cy={yDb(a.freq.s11Db[hoverIdx], h)} r="3.5" />
              <text class="tx halo" x={hx > w - 165 ? hx - 8 : hx + 8} y={top + 24} text-anchor={hx > w - 165 ? 'end' : 'start'}>
                {fG.toFixed(1)} GHz · S21 {nf(a.freq.s21Db[hoverIdx], 1)} · S11 {nf(a.freq.s11Db[hoverIdx], 1)} dB
              </text>
            {/if}
          {/if}
        {/snippet}
      </Plot>
    </div>
  </section>

  <section class="panel chart-card">
    <div class="card-head">
      <div>
        <h2>2b · TDR impedance profile Z(x) from S<sub>11</sub>(f)</h2>
        <p class="note">
          {a.cfg.tcoil
            ? `Bridged T-coil ON (L = ${a.tcoilInfo.lPh.toFixed(0)} pH, k = 0.33, Cb = ${a.tcoilInfo.cbFf.toFixed(1)} fF) hides the ${a.cfg.padCapFf} fF pad.`
            : `T-coil OFF: bare ${a.cfg.padCapFf} fF ESD/pad capacitance creates a deep dip right at x = 0 mm.`}
        </p>
      </div>
      <div class="mini-legend">
        <span><i style:background="var(--brand)"></i>TDR Z(x)</span>
        <span><i class="dash-leg"></i>50 Ω target</span>
      </div>
    </div>
    <div class="plot-box">
      <Plot label="Time-domain reflectometry apparent impedance profile along the link in ohms">
        {#snippet children({ width: w, height: h })}
          {#if w > 0 && h > 60}
            {#each a.segments as seg (seg.id)}
              {#if Math.abs(seg.zOhm - Z0) > 0.5}
                <rect
                  x={xD(seg.startMm, w)}
                  y={top}
                  width={Math.max(2, xD(seg.startMm + seg.lengthMm, w) - xD(seg.startMm, w))}
                  height={Math.max(1, h - top - bot)}
                  fill={seg.id === 'via' ? 'rgba(179, 105, 22, 0.12)' : 'rgba(194, 73, 92, 0.12)'}
                />
                <text class="tx2" x={xD(seg.startMm + seg.lengthMm / 2, w)} y={top + 11} text-anchor="middle">
                  {seg.label}
                </text>
              {/if}
            {/each}
            {#each [20, 35, 50, 65, 80, 95] as z (z)}
              {#if z >= zBounds.lo && z <= zBounds.hi}
                <line class={z === 50 ? 'zero' : 'gr'} x1={left} x2={w - right} y1={yZ(z, h)} y2={yZ(z, h)} stroke-dasharray={z === 50 ? '4 3' : undefined} />
                <text class="tx" text-anchor="end" x={left - 6} y={yZ(z, h) + 4}>{z} Ω</text>
              {/if}
            {/each}
            {#each [0, 8, 16, 24, 32, 40] as mm (mm)}
              {#if mm <= totalMm + 0.1}
                <text class="tx" text-anchor={mm === 0 ? 'start' : 'middle'} x={xD(mm, w)} y={h - 6}>{mm} mm</text>
              {/if}
            {/each}
            <path d={tdrPath(w, h)} fill="none" stroke="var(--brand)" stroke-width="2" />
          {/if}
        {/snippet}
      </Plot>
    </div>
  </section>
</div>

<style>
  .sparam-grid { align-items: stretch; }
  .chart-card { display: flex; flex-direction: column; gap: 10px; }
  .card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 8px 12px; }
  .card-head h2 { margin: 0 0 3px; }
  .card-head b { color: var(--ink); font-weight: 550; }
  .mini-legend { display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--ink-2); white-space: nowrap; }
  .mini-legend span { display: inline-flex; align-items: center; gap: 5px; }
  .mini-legend i { display: inline-block; width: 12px; height: 2.5px; border-radius: 2px; }
  .mini-legend i.dash-leg { background: repeating-linear-gradient(90deg, var(--ink-3) 0 4px, transparent 4px 7px); }
  .plot-box { height: 220px; display: flex; }
</style>
