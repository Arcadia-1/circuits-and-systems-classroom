<script lang="ts">
  import Plot from '../../components/chart/Plot.svelte';
  import { nf } from '../../lib/format';
  import { LEVELS, type Analysis224g, type BudgetPart, type DetectorMode, type DetectorMcStats, type EqualizerResult } from './model';
  import { EQUALIZER_ROLES } from './presets';

  let {
    a,
    detector = $bindable<DetectorMode>('mlse'),
  }: {
    a: Analysis224g;
    detector: DetectorMode;
  } = $props();

  const PARTS: { key: BudgetPart; name: string; color: string }[] = [
    { key: 'isi', name: 'ISI', color: '#64748b' },
    { key: 'th', name: 'Thermal', color: 'var(--s1)' },
    { key: 'xt', name: 'Crosstalk', color: '#c2579a' },
    { key: 'adc', name: 'ADC', color: 'var(--s2)' },
    { key: 'jit', name: 'Jitter', color: '#7c4dff' },
    { key: 'tx', name: 'TX dist.', color: '#0d9488' },
  ];

  interface ModeRow {
    id: DetectorMode | 'ffe12';
    selectable: DetectorMode | null;
    name: string;
    detail: string;
    eq: EqualizerResult;
    mc: DetectorMcStats;
    compute: string;
  }

  const rows = $derived<ModeRow[]>([
    { id: 'bypass', selectable: 'bypass', name: 'Bypass RX DSP', detail: 'CTLE + gain only', eq: a.eqBypass, mc: a.mc.bypass, compute: '1× (analog only)' },
    ...(a.cfg.ffePostTaps > 8
      ? [{ id: 'ffe12' as const, selectable: null, name: '12-tap FFE (ref)', detail: 'Stops at +8 UI', eq: a.eqFfe12, mc: a.mc.ffe12, compute: '12 MAC/UI' }]
      : []),
    { id: 'ffe', selectable: 'ffe', name: `${a.cfg.ffePostTaps + 4}-tap FFE`, detail: `Reaches +${a.cfg.ffePostTaps} UI`, eq: a.eqFfe, mc: a.mc.ffe, compute: `${a.cfg.ffePostTaps + 4} MAC/UI` },
    { id: 'dfe', selectable: 'dfe', name: 'FFE + 1-tap DFE', detail: `b₁ = ${a.eqPr1.b1.toFixed(2)} (real fb)`, eq: a.eqPr1, mc: a.mc.dfe, compute: `${a.cfg.ffePostTaps + 5} MAC/UI` },
    { id: 'mlse', selectable: 'mlse', name: 'FFE + 4-state MLSE', detail: `PR 1 + ${a.eqPr1.b1.toFixed(2)}D Viterbi`, eq: a.eqPr1, mc: a.mc.mlse, compute: 'FFE + 16 BM + 4 ACS/UI' },
  ]);

  const activeEq = $derived(detector === 'bypass' ? a.eqBypass : detector === 'ffe' ? a.eqFfe : a.eqPr1);
  const activeMc = $derived(
    detector === 'bypass' ? a.mc.bypass : detector === 'ffe' ? a.mc.ffe : detector === 'dfe' ? a.mc.dfe : a.mc.mlse,
  );

  function berParts(ber: number, errs: number): { mant: string; exp: number } | null {
    if (errs === 0) return null;
    const exp = Math.floor(Math.log10(ber));
    return { mant: (ber / 10 ** exp).toFixed(1), exp };
  }

  // Histogram bars helper
  const histMax = $derived(Math.max(1, ...activeMc.histCounts));
  const LEVEL_LABELS = ['−3', '−1', '+1', '+3'];
  const STATE_Y_IDX = [3, 2, 1, 0]; // state 3 (+3) at top, state 0 (-3) at bottom
  const hPadL = 28, hPadR = 10, hPadT = 10, hPadB = 22;
  const tPadL = 26, tPadR = 14, tPadT = 14, tPadB = 22;
</script>

<section class="panel compare-panel" aria-label="Five-equalizer comparison, error bursts and Viterbi MLSE">
  <div class="compare-head">
    <div>
      <h2>4 · Five-equalizer tradeoffs on the exact same ADC samples</h2>
      <p class="note">
        Shared front end: CTLE <b class="mono">{a.cfg.ctleOn ? `${nf(a.gdc, 0)} / ${nf(a.gdc2, 0)} dB` : 'off'}</b>
        (boost <b class="mono">{nf(a.ctleBoostDb, 1)} dB</b>) ·
        TX FFE launch swing <b class="mono">{Math.round(a.txSwingRatio * 100)}%</b> (<b class="mono">{nf(a.txSwingLossDb, 1)} dB</b>) ·
        Observed over <b class="mono">{a.mc.ffe.totalSymbols.toLocaleString('en-US')}</b> PAM4 symbols ({a.mc.ffe.totalBits.toLocaleString('en-US')} bits).
      </p>
    </div>
  </div>

  <!-- Scorecard table comparing all 5 architectures honestly -->
  <div class="table-wrap">
    <table class="score-table">
      <thead>
        <tr>
          <th>Receiver DSP mode</th>
          <th class="num">Model SNR</th>
          <th class="num">FFE noise boost</th>
          <th class="num">Observed BER</th>
          <th class="num">Sym errors</th>
          <th class="num">Bursts ≥ 2 (max)</th>
          <th>DSP complexity</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          {@const active = row.selectable === detector}
          {@const bp = berParts(row.mc.ber, row.mc.bitErrors)}
          <tr
            class:active
            class:clickable={row.selectable !== null}
            onclick={() => { if (row.selectable) detector = row.selectable; }}
          >
            <td>
              <strong>{row.name}</strong>
              <small>{row.detail}</small>
            </td>
            <td class="num mono">
              {nf(row.eq.snrDb, 1)} dB
              {#if row.id === 'dfe'}<small class="sub-note">genie</small>{/if}
              {#if row.id === 'mlse'}<small class="sub-note">PR front</small>{/if}
            </td>
            <td class="num mono">{row.id === 'bypass' ? '0.0 dB' : `+${nf(Math.max(0, row.eq.noiseEnhDb), 1)} dB`}</td>
            <td class="num mono" class:good={row.mc.bitErrors === 0} class:bad={row.mc.ber > 0.01}>
              {#if !bp}0 observed{:else}{bp.mant}×10<sup>{nf(bp.exp, 0)}</sup>{/if}
            </td>
            <td class="num mono">{row.mc.symbolErrors.toLocaleString('en-US')}</td>
            <td class="num mono" class:warn-cell={row.mc.burstsGe2 >= 10}>
              {row.mc.burstsGe2} <small>({row.mc.maxBurst})</small>
            </td>
            <td class="mono dim">{row.compute}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <!-- Diagnostic row: Left = Error budget + PAM4 histogram, Right = Error burst strip + 4-state Viterbi trellis -->
  <div class="two diag-grid">
    <div class="subcard">
      <div class="subhead">
        <span class="label">Error budget · {detector.toUpperCase()}</span>
        <span class="note">Genie DFE errors: <b class="mono">{a.mc.dfeGenie.symbolErrors}</b> vs real DFE: <b class="mono">{a.mc.dfe.symbolErrors}</b></span>
      </div>
      <div class="budget-bar" role="img" aria-label="Noise and ISI error budget breakdown">
        {#each PARTS as p (p.key)}
          <span style:width="{(100 * activeEq.parts[p.key]) / activeEq.totalErr}%" style:background={p.color}></span>
        {/each}
      </div>
      <ul class="bkey">
        {#each PARTS as p (p.key)}
          <li><i style:background={p.color}></i>{p.name} <b class="mono">{Math.round((100 * activeEq.parts[p.key]) / activeEq.totalErr)}%</b></li>
        {/each}
      </ul>

      <div class="swing-row">
        <span class="label">TX FFE launch swing</span>
        <div class="swing-track"><span style:width="{a.txSwingRatio * 100}%"></span></div>
        <span class="mono">{Math.round(a.txSwingRatio * 100)}% ({nf(a.txSwingLossDb, 1)} dB)</span>
      </div>

      <div class="subhead" style="margin-top: 4px;">
        <span class="label">PAM4 slicer distribution · {detector.toUpperCase()}</span>
        <span class="note">Effective SNR <b class="mono">{nf(activeMc.effSnrDb, 1)} dB</b></span>
      </div>
      <div class="hist-box">
        <Plot label="Measured PAM4 amplitude distribution across the four symbol levels">
          {#snippet children({ width: w, height: h })}
            {#if w > 0 && h > 50}
              {@const xS = (v: number) => hPadL + ((v / activeMc.histRange + 1) * 0.5) * (w - hPadL - hPadR)}
              {#each [-2 / 3, 0, 2 / 3] as thr (thr)}
                <line x1={xS(thr)} x2={xS(thr)} y1={hPadT} y2={h - hPadB} stroke="var(--bad)" stroke-width="1" stroke-dasharray="3 3" opacity="0.55" />
              {/each}
              {#each LEVELS as lv, idx (idx)}
                <line x1={xS(lv)} x2={xS(lv)} y1={hPadT} y2={h - hPadB} stroke="var(--rule)" stroke-width="1" />
                <text class="tx" x={xS(lv)} y={h - 6} text-anchor="middle">{LEVEL_LABELS[idx]}</text>
              {/each}
              {#each activeMc.histCounts as cnt, bi (bi)}
                {#if cnt > 0}
                  {@const v0 = ((bi / activeMc.histCounts.length) * 2 - 1) * activeMc.histRange}
                  {@const v1 = (((bi + 1) / activeMc.histCounts.length) * 2 - 1) * activeMc.histRange}
                  {@const bh = (cnt / histMax) * (h - hPadT - hPadB)}
                  <rect
                    x={xS(v0)}
                    y={h - hPadB - bh}
                    width={Math.max(1.5, xS(v1) - xS(v0) - 0.5)}
                    height={bh}
                    fill={detector === 'mlse' ? '#7c4dff' : detector === 'dfe' ? 'var(--s2)' : 'var(--s1)'}
                    opacity="0.82"
                  />
                {/if}
              {/each}
            {/if}
          {/snippet}
        </Plot>
      </div>
    </div>

    <div class="subcard">
      <div class="subhead">
        <span class="label">Real decision stream (48 symbols · errors in red)</span>
        <span class="note">MLSE rescued <b class="mono">{a.mc.rescuedCount}</b> FFE/DFE errors</span>
      </div>
      <div class="strip-grid" role="img" aria-label="48-symbol comparison strip showing single and burst symbol errors in FFE, DFE and MLSE">
        {#each [
          { name: 'FFE', errs: a.mc.stripFfeErr },
          { name: 'DFE', errs: a.mc.stripDfeErr },
          { name: 'MLSE', errs: a.mc.stripMlseErr },
        ] as row (row.name)}
          <div class="strip-row">
            <span class="strip-lbl mono">{row.name}</span>
            <div class="strip-cells">
              {#each row.errs as e, idx (idx)}
                <span class="cell" class:err={e === 1} title={`Sym #${a.mc.stripStart + idx}: ${e ? 'Error' : 'OK'}`}></span>
              {/each}
            </div>
          </div>
        {/each}
      </div>

      <div class="subhead" style="margin-top: 6px;">
        <span class="label">4-state Viterbi MLSE trellis (12 live symbols)</span>
        <span class="note">
          <i class="dot-mlse"></i>MLSE path · <i class="dot-dfe"></i>DFE err · <i class="dot-tx"></i>True
        </span>
      </div>
      <div class="trellis-box">
        <Plot label="Live 4-state PAM4 Viterbi trellis showing survivor paths, true symbols, and DFE errors rescued by MLSE">
          {#snippet children({ width: w, height: h })}
            {#if w > 0 && h > 60 && a.mc.trellisWindow.length > 1}
              {@const win = a.mc.trellisWindow}
              {@const xN = (i: number) => tPadL + (i / (win.length - 1)) * Math.max(1, w - tPadL - tPadR)}
              {@const ySt = (st: number) => tPadT + (STATE_Y_IDX[st] / 3) * Math.max(1, h - tPadT - tPadB)}

              {#each [0, 1, 2, 3] as st (st)}
                <line class="gr" x1={tPadL} x2={w - tPadR} y1={ySt(st)} y2={ySt(st)} />
                <text class="tx" x={tPadL - 6} y={ySt(st) + 4} text-anchor="end">{LEVEL_LABELS[st]}</text>
              {/each}

              <!-- Faint survivor edges for all 4 states -->
              {#each win as step, i (step.symIndex)}
                {#if i > 0}
                  {#each [0, 1, 2, 3] as sc (sc)}
                    {@const sp = step.prevState[sc]}
                    <line
                      x1={xN(i - 1)}
                      y1={ySt(sp)}
                      x2={xN(i)}
                      y2={ySt(sc)}
                      stroke="#cbd5e1"
                      stroke-width="1"
                    />
                  {/each}
                {/if}
              {/each}

              <!-- True transmitted path (subtle dashed) -->
              <path
                d={win.map((s, i) => `${i ? 'L' : 'M'}${xN(i).toFixed(1)},${ySt(s.txSym).toFixed(1)}`).join('')}
                fill="none"
                stroke="#0f172a"
                stroke-width="1.3"
                stroke-dasharray="3 3"
                opacity="0.55"
              />

              <!-- Winning MLSE path -->
              <path
                d={win.map((s, i) => `${i ? 'L' : 'M'}${xN(i).toFixed(1)},${ySt(s.mlseDec).toFixed(1)}`).join('')}
                fill="none"
                stroke="#7c4dff"
                stroke-width="2.4"
              />

              <!-- Nodes: highlight DFE mistakes vs MLSE decisions -->
              {#each win as step, i (step.symIndex)}
                {@const dfeWrong = step.dfeDec !== step.txSym}
                {@const mlseWrong = step.mlseDec !== step.txSym}
                {#if dfeWrong}
                  <circle cx={xN(i)} cy={ySt(step.dfeDec)} r="5.2" fill="none" stroke="var(--bad)" stroke-width="1.8" />
                {/if}
                <circle
                  cx={xN(i)}
                  cy={ySt(step.mlseDec)}
                  r="3.2"
                  fill={mlseWrong ? 'var(--bad)' : '#7c4dff'}
                  stroke="#ffffff"
                  stroke-width="1"
                />
                {#if i % 2 === 0}
                  <text class="tx" x={xN(i)} y={h - 5} text-anchor="middle">{step.symIndex}</text>
                {/if}
              {/each}
            {/if}
          {/snippet}
        </Plot>
      </div>
    </div>
  </div>

  <!-- Concise 5-equalizer architectural summary matrix -->
  <div class="roles-grid" aria-label="Summary of the five 224G equalizers">
    {#each EQUALIZER_ROLES as eq (eq.name)}
      <div class="role-card">
        <div class="role-top">
          <strong>{eq.name}</strong>
          <span class="role-target mono">{eq.target}</span>
        </div>
        <p class="role-good">{eq.strength}</p>
        <p class="role-cost">Cost: {eq.tradeoff}</p>
      </div>
    {/each}
  </div>
</section>

<style>
  .compare-panel { display: grid; gap: 14px; }
  .compare-head h2 { margin: 0 0 4px; }
  .compare-head b { color: var(--ink); font-weight: 550; }
  .table-wrap { overflow-x: auto; }
  .score-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .score-table th, .score-table td { padding: 8px 10px; border-bottom: 1px solid var(--rule-soft); text-align: left; white-space: nowrap; }
  .score-table th { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); font-weight: 550; }
  .score-table td strong { display: block; color: var(--ink); font-weight: 600; }
  .score-table td small { color: var(--ink-3); font-size: 11px; }
  .score-table td .sub-note { margin-left: 4px; }
  .score-table .num { text-align: right; }
  .score-table .dim { color: var(--ink-2); font-size: 11.5px; }
  .score-table tbody tr.clickable { cursor: pointer; }
  .score-table tbody tr.clickable:hover { background: var(--ground); }
  .score-table tbody tr.active { background: var(--brand-soft); }
  .score-table td.good { color: var(--brand); font-weight: 550; }
  .score-table td.bad { color: var(--bad); font-weight: 550; }
  .score-table td.warn-cell { color: var(--bad); font-weight: 600; }

  .diag-grid { gap: 16px; }
  .subcard { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--rule-soft); border-radius: 10px; background: var(--ground); align-content: start; }
  .subhead { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 10px; }
  .subhead b { color: var(--ink); font-weight: 550; }
  .budget-bar { display: flex; height: 9px; border-radius: 5px; overflow: hidden; background: var(--chip); }
  .budget-bar span { display: block; height: 100%; }
  .bkey { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 0; list-style: none; font-size: 11.5px; color: var(--ink-2); }
  .bkey i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
  .bkey b { color: var(--ink); font-weight: 500; }
  .swing-row { display: grid; grid-template-columns: auto minmax(60px, 1fr) auto; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ink-2); padding-top: 4px; }
  .swing-track { height: 7px; border-radius: 4px; background: var(--chip); overflow: hidden; }
  .swing-track span { display: block; height: 100%; background: var(--s1); border-radius: 4px; }
  .hist-box { height: 132px; display: flex; background: var(--plot); border: 1px solid var(--rule-soft); border-radius: 8px; }

  .strip-grid { display: grid; gap: 5px; padding: 8px 10px; background: var(--plot); border: 1px solid var(--rule-soft); border-radius: 8px; }
  .strip-row { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: center; gap: 8px; }
  .strip-lbl { font-size: 11px; color: var(--ink-2); }
  .strip-cells { display: grid; grid-template-columns: repeat(48, minmax(0, 1fr)); gap: 1.5px; }
  .cell { height: 12px; border-radius: 1.5px; background: #cbd5e1; }
  .cell.err { background: var(--bad); }
  .trellis-box { height: 150px; display: flex; background: var(--plot); border: 1px solid var(--rule-soft); border-radius: 8px; }
  .dot-mlse, .dot-dfe, .dot-tx { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; vertical-align: -1px; }
  .dot-mlse { background: #7c4dff; }
  .dot-dfe { border: 1.8px solid var(--bad); background: transparent; }
  .dot-tx { background: #475569; }

  .roles-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  .role-card { padding: 11px 12px; border: 1px solid var(--rule-soft); border-radius: 9px; background: var(--ground); display: grid; gap: 5px; align-content: start; }
  .role-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px; }
  .role-top strong { font-size: 12.5px; color: var(--ink); }
  .role-target { font-size: 10.5px; color: var(--brand); }
  .role-good { margin: 0; font-size: 11.5px; line-height: 1.45; color: var(--ink-2); }
  .role-cost { margin: 0; font-size: 11px; line-height: 1.4; color: var(--s2); font-weight: 500; }
  @media (max-width: 1080px) { .roles-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 680px) { .roles-grid { grid-template-columns: 1fr; } }
</style>
