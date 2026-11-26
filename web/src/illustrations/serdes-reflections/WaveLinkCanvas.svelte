<script lang="ts">
  import { onMount } from 'svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import { mulberry32 } from '../../lib/rng';
  import {
    DEFAULT_CONFIG,
    LATTICE_DT_PS,
    LEVELS,
    PS_PER_MM,
    UI,
    Z0,
    WaveLattice,
    echoGeometry,
    type LinkConfig,
    type WaveExcitation,
  } from './model';

  let {
    cfg,
    excitation = $bindable<WaveExcitation>('single'),
  }: {
    cfg: LinkConfig;
    excitation: WaveExcitation;
  } = $props();

  let playing = $state(true);
  let speed = $state(1);
  let showForward = $state(true);
  let showReflected = $state(true);
  let showEcho = $state(true);
  let showTotal = $state(false);
  let canvas: HTMLCanvasElement | undefined = $state();

  const geom = $derived(echoGeometry(cfg));
  const totalMm = $derived(18 + cfg.pcbMm);
  const flightPs = $derived(totalMm * PS_PER_MM);
  const inFlightUi = $derived(flightPs / (UI * 1e12));

  // Source waveform generator for the 1-D wave-splitting lattice (step index k, dt = 0.6 ps)
  const prbsSeq = (() => {
    const rnd = mulberry32(0x524546);
    return Array.from({ length: 512 }, () => LEVELS[Math.min(3, Math.floor(rnd() * 4))]);
  })();

  function sourceAt(stepIdx: number, mode: WaveExcitation): number {
    const tPs = stepIdx * LATTICE_DT_PS;
    if (mode === 'lowfreq') {
      // Smooth low-frequency square-like wave (period = 1100 ps -> wavelength >> 32 mm trace)
      const cyc = (tPs % 1100) / 1100;
      const edge = (u: number) => 0.5 * (1 + Math.tanh((u) / 0.08));
      return 0.85 * (edge(cyc - 0.12) - edge(cyc - 0.62)) * 2 - 0.85;
    }
    if (mode === 'single') {
      // Repeating 1-UI (~8.93 ps) smooth 224G pulse every 340 ps so reflections & echoes play out cleanly
      const periodPs = Math.max(300, Math.round(flightPs * 2.1));
      const local = tPs % periodPs;
      const center = 22;
      const sigma = 3.6; // FWHM ≈ 8.5 ps ≈ 1 UI
      return Math.exp(-0.5 * ((local - center) / sigma) ** 2);
    }
    // Continuous 224G PAM4 symbol stream (1 UI = 8.9286 ps, raised-cosine smoothed transitions)
    const uiPs = UI * 1e12;
    const u = tPs / uiPs;
    const i0 = Math.floor(u);
    const fr = u - i0;
    const aPrev = prbsSeq[((i0 - 1) & 511)];
    const aCurr = prbsSeq[(i0 & 511)];
    const blend = fr < 0.28 ? 0.5 - 0.5 * Math.cos((Math.PI * fr) / 0.28) : 1;
    return 0.85 * (aPrev + (aCurr - aPrev) * blend);
  }

  let lattice = new WaveLattice(DEFAULT_CONFIG, false);
  let simTimePs = $state(0);

  function rebuildAndPrime() {
    lattice = new WaveLattice(cfg, false);
    // Prime to an immediately informative physical snapshot (also used when paused / reduced motion)
    const primeSteps =
      excitation === 'single'
        ? Math.round((flightPs * 0.72 + 24) / LATTICE_DT_PS)
        : excitation === 'lowfreq'
          ? Math.round(300 / LATTICE_DT_PS)
          : Math.round((flightPs * 2.2) / LATTICE_DT_PS);
    for (let i = 0; i < primeSteps; i++) lattice.step(sourceAt(lattice.stepCount, excitation));
    simTimePs = lattice.stepCount * LATTICE_DT_PS;
    paint();
  }

  const physKey = $derived(`${cfg.lossDb}|${cfg.zVia}|${cfg.zConn}|${cfg.pcbMm}|${cfg.padCapFf}|${cfg.tcoil}|${excitation}`);
  let lastKey = '';

  $effect(() => {
    const k = physKey;
    if (k !== lastKey) {
      lastKey = k;
      rebuildAndPrime();
    }
  });

  $effect(() => {
    // Repaint immediately when visibility toggles change while paused
    showForward; showReflected; showEcho; showTotal;
    paint();
  });

  function replayPulse() {
    lattice = new WaveLattice(cfg, false);
    if (excitation === 'single') {
      // Start just as the pulse emerges from TX
      for (let i = 0; i < 20; i++) lattice.step(sourceAt(lattice.stepCount, excitation));
    } else {
      for (let i = 0; i < 80; i++) lattice.step(sourceAt(lattice.stepCount, excitation));
    }
    simTimePs = lattice.stepCount * LATTICE_DT_PS;
    paint();
  }

  function paint() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth || 760;
    const H = canvas.clientHeight || 310;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const padL = 56, padR = 56, topStripY = 14, topStripH = 74;
    const plotW = Math.max(120, W - padL - padR);
    const waveTop = topStripY + topStripH + 22;
    const waveBot = H - 30;
    const waveMid = (waveTop + waveBot) / 2;
    const waveAmp = (waveBot - waveTop) * 0.42;

    const xOfMm = (mm: number) => padL + (mm / lattice.totalMm) * plotW;

    // 1. Background subtle grid & discontinuity vertical guides
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Impedance profile strip ("rope thickness")
    const ropeMidY = topStripY + topStripH * 0.56;
    ctx.fillStyle = '#f6f8fa';
    ctx.fillRect(padL, topStripY, plotW, topStripH);
    ctx.strokeStyle = '#d9e0e9';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, topStripY, plotW, topStripH);

    // Reference 50 Ω dashed centerline in rope strip
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(padL, ropeMidY);
    ctx.lineTo(padL + plotW, ropeMidY);
    ctx.stroke();
    ctx.restore();

    const segFill: Record<string, string> = {
      pkg: '#e2e8f0',
      via: '#fde68a',
      pcb: '#dbeafe',
      conn: '#fed7aa',
      cable: '#d1fae5',
      rx: '#e2e8f0',
    };
    const segStroke: Record<string, string> = {
      pkg: '#64748b',
      via: '#b45309',
      pcb: '#2563eb',
      conn: '#c2410c',
      cable: '#047857',
      rx: '#64748b',
    };

    // Draw each physical segment with thickness proportional to Z(x)
    for (const seg of lattice.segments) {
      const x0 = xOfMm(seg.startMm);
      const x1 = xOfMm(seg.startMm + seg.lengthMm);
      const halfH = Math.max(7, Math.min(28, (seg.zOhm / Z0) * 15));
      const isMismatch = Math.abs(seg.zOhm - Z0) > 0.5;
      ctx.fillStyle = isMismatch ? segFill[seg.id] : '#e8eef5';
      ctx.strokeStyle = isMismatch ? segStroke[seg.id] : '#64748b';
      ctx.lineWidth = isMismatch ? 1.8 : 1.1;
      ctx.beginPath();
      ctx.rect(x0, ropeMidY - halfH, Math.max(2, x1 - x0), halfH * 2);
      ctx.fill();
      ctx.stroke();

      // Segment label above/inside
      const cx = (x0 + x1) / 2;
      ctx.fillStyle = isMismatch ? '#9a3412' : '#475569';
      ctx.font = isMismatch ? '600 10.5px ui-sans-serif, system-ui, sans-serif' : '500 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      if (x1 - x0 > 30) {
        ctx.fillText(seg.label, cx, topStripY + 13);
        ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`${seg.zOhm} Ω`, cx, ropeMidY + 3.5);
      } else {
        ctx.fillText(seg.id === 'via' ? `Via ${seg.zOhm}Ω` : `Conn ${seg.zOhm}Ω`, cx, topStripY + 12);
      }

      // Vertical dashed discontinuity guide down into wave region
      if (isMismatch) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(194, 65, 12, 0.32)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, topStripY + topStripH);
        ctx.lineTo(x0, waveBot);
        ctx.moveTo(x1, topStripY + topStripH);
        ctx.lineTo(x1, waveBot);
        ctx.stroke();
        ctx.restore();
      }
    }

    // TX and RX port badges (showing T-coil matched vs bare capacitive wall)
    const drawPort = (x: number, side: 'TX' | 'RX') => {
      const boxW = 46, boxH = 54;
      const bx = side === 'TX' ? x - boxW - 5 : x + 5;
      const by = ropeMidY - boxH / 2;
      const bareMismatch = !cfg.tcoil && cfg.padCapFf > 5;
      ctx.fillStyle = bareMismatch ? '#fef2f2' : '#ecfdf5';
      ctx.strokeStyle = bareMismatch ? '#dc2626' : '#087f58';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#17212e';
      ctx.font = '600 10.5px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(side, bx + boxW / 2, by + 15);
      ctx.font = '500 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = bareMismatch ? '#b91c1c' : '#047857';
      ctx.fillText(cfg.tcoil ? 'T-coil' : `${cfg.padCapFf}fF`, bx + boxW / 2, by + 30);
      ctx.fillText(cfg.tcoil ? '50 Ω' : 'reflects', bx + boxW / 2, by + 44);

      if (bareMismatch) {
        ctx.save();
        ctx.strokeStyle = 'rgba(220, 38, 38, 0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, topStripY);
        ctx.lineTo(x, waveBot);
        ctx.stroke();
        ctx.restore();
      }
    };
    drawPort(padL, 'TX');
    drawPort(padL + plotW, 'RX');

    // 2. Wave plot frame and axes
    ctx.strokeStyle = '#e5eaf1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, waveTop);
    ctx.lineTo(padL + plotW, waveTop);
    ctx.moveTo(padL, waveBot);
    ctx.lineTo(padL + plotW, waveBot);
    ctx.stroke();

    // Zero voltage axis
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, waveMid);
    ctx.lineTo(padL + plotW, waveMid);
    ctx.stroke();

    // Distance ticks along bottom
    ctx.fillStyle = '#65748a';
    ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    const stepMm = lattice.totalMm > 34 ? 6 : 5;
    for (let mm = 0; mm <= lattice.totalMm + 0.01; mm += stepMm) {
      const tx = xOfMm(Math.min(mm, lattice.totalMm));
      ctx.fillText(`${mm.toFixed(0)} mm`, tx, H - 10);
      ctx.strokeStyle = '#e5eaf1';
      ctx.beginPath();
      ctx.moveTo(tx, waveBot);
      ctx.lineTo(tx, waveBot + 4);
      ctx.stroke();
    }
    ctx.textAlign = 'right';
    ctx.fillText('+1', padL - 8, waveMid - waveAmp + 4);
    ctx.fillText('0', padL - 8, waveMid + 4);
    ctx.fillText('−1', padL - 8, waveMid + waveAmp + 4);

    // 3. Plot bounce-decomposed wave components from the exact 1-D lattice
    const N = lattice.nCells;
    const drawSeries = (vals: (i: number) => number, color: string, width: number, fillAlpha = 0, dashed = false) => {
      ctx.save();
      if (dashed) ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const x = padL + ((i + 0.5) / N) * plotW;
        const y = waveMid - Math.max(-1.25, Math.min(1.25, vals(i))) * waveAmp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (fillAlpha > 0) {
        ctx.lineTo(padL + plotW, waveMid);
        ctx.lineTo(padL, waveMid);
        ctx.closePath();
        ctx.globalAlpha = fillAlpha;
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.restore();
    };

    if (showTotal) {
      drawSeries(
        (i) => lattice.v0p[i] + lattice.v1m[i] + lattice.v2p[i] + lattice.v2m[i],
        '#475569',
        1.5,
        0,
        true,
      );
    }
    if (showForward) {
      drawSeries((i) => lattice.v0p[i], '#246dc1', 2.2, 0.10);
    }
    if (showReflected) {
      drawSeries((i) => lattice.v1m[i] + lattice.v2m[i], '#d9483b', 2.0, 0.12);
    }
    if (showEcho) {
      drawSeries((i) => lattice.v2p[i], '#7c4dff', 2.4, 0.16);
    }

    // Subtle peak callout arrows for reflected & echo waves in single-pulse mode so direction is unmistakable
    if (excitation === 'single') {
      let refIdx = -1, refMax = 0.04;
      let echoIdx = -1, echoMax = 0.015;
      for (let i = 4; i < N - 4; i++) {
        const rv = Math.abs(lattice.v1m[i] + lattice.v2m[i]);
        if (rv > refMax) { refMax = rv; refIdx = i; }
        const ev = Math.abs(lattice.v2p[i]);
        if (ev > echoMax) { echoMax = ev; echoIdx = i; }
      }
      ctx.font = '600 10.5px ui-sans-serif, system-ui, sans-serif';
      if (showReflected && refIdx >= 0) {
        const rx = padL + ((refIdx + 0.5) / N) * plotW;
        const rv = lattice.v1m[refIdx] + lattice.v2m[refIdx];
        const ry = waveMid - rv * waveAmp + (rv >= 0 ? -12 : 16);
        ctx.fillStyle = '#c23428';
        ctx.textAlign = 'center';
        ctx.fillText('← reflection', Math.max(padL + 36, Math.min(padL + plotW - 36, rx)), Math.max(waveTop + 12, Math.min(waveBot - 6, ry)));
      }
      if (showEcho && echoIdx >= 0) {
        const ex = padL + ((echoIdx + 0.5) / N) * plotW;
        const ev = lattice.v2p[echoIdx];
        const ey = waveMid - ev * waveAmp + (ev >= 0 ? -12 : 16);
        ctx.fillStyle = '#6d28d9';
        ctx.textAlign = 'center';
        ctx.fillText('echo →', Math.max(padL + 28, Math.min(padL + plotW - 28, ex)), Math.max(waveTop + 12, Math.min(waveBot - 6, ey)));
      }
    }

    // Top-left label of the wave pane
    ctx.fillStyle = '#55637a';
    ctx.font = '500 10.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Z(x) impedance profile ("rope thickness")', padL + 6, topStripY + topStripH - 5);
    ctx.fillText(
      excitation === 'lowfreq'
        ? 'Low-frequency pulse (wavelength ≫ trace length — wire moves together)'
        : excitation === 'single'
          ? 'Single 224G pulse (1 UI = 8.93 ps) — watch reflections & delayed echoes split'
          : `224G PAM4 stream — ~${inFlightUi.toFixed(1)} symbols packed inside ${totalMm.toFixed(1)} mm`,
      padL + 6,
      waveTop + 12,
    );
  }

  onMount(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) playing = false;
    rebuildAndPrime();
    const ro = new ResizeObserver(() => paint());
    if (canvas) ro.observe(canvas);
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (playing) {
        // Slow-motion: ~70 ps of physical wave flight per real second at 1x (about 1.4e10x slowed down)
        const stepsPerSec = (72 / LATTICE_DT_PS) * speed;
        carry += dt * stepsPerSec;
        const nSteps = Math.min(24, Math.floor(carry));
        carry -= nSteps;
        for (let i = 0; i < nSteps; i++) {
          lattice.step(sourceAt(lattice.stepCount, excitation));
        }
        if (nSteps > 0) {
          simTimePs = lattice.stepCount * LATTICE_DT_PS;
          paint();
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });
</script>

<section class="panel wave-panel" aria-label="Travelling wave and impedance discontinuity visualizer">
  <div class="wave-head">
    <div>
      <h2>1 · Physical link &amp; travelling wave decomposition</h2>
      <p class="note">
        1 mm = 6.0 ps · 1 UI (224G) = 8.93 ps ≈ 1.49 mm · Trace holds <b class="mono">{inFlightUi.toFixed(1)} UI</b> in flight ·
        Γ<sub>via</sub> = <b class="mono">{nf(geom.gammaVia, 2)}</b> · Γ<sub>conn</sub> = <b class="mono">{nf(geom.gammaConn, 2)}</b> ·
        Via↔Conn echo = <b class="mono">+{geom.viaConnUi.toFixed(1)} UI</b>
      </p>
    </div>
    <div class="wave-controls">
      <Segmented
        size="sm"
        label="Wave source mode"
        options={[
          { value: 'lowfreq' as WaveExcitation, label: 'Low-freq wire' },
          { value: 'single' as WaveExcitation, label: 'Single 224G pulse' },
          { value: 'stream224' as WaveExcitation, label: '224G stream' },
        ]}
        bind:value={excitation}
      />
    </div>
  </div>

  <div class="canvas-wrap">
    <canvas
      bind:this={canvas}
      aria-label="Real-time 1-D wave-splitting transmission line showing impedance profile, primary forward wave, backward reflections and delayed forward echoes"
    ></canvas>
  </div>

  <div class="wave-foot">
    <div class="play-row">
      <button type="button" class="primary" aria-pressed={playing} onclick={() => (playing = !playing)}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button type="button" onclick={replayPulse}>Launch pulse</button>
      <Segmented
        size="sm"
        mono
        label="Wave playback speed"
        options={[
          { value: 0.25, label: '¼×' },
          { value: 0.5, label: '½×' },
          { value: 1, label: '1×' },
          { value: 2, label: '2×' },
        ]}
        bind:value={speed}
      />
      <span class="time-tag mono">t = {simTimePs.toFixed(0)} ps</span>
    </div>

    <div class="wave-legend" role="group" aria-label="Toggle wave components">
      <label><input type="checkbox" bind:checked={showForward} /><i style:background="#246dc1"></i><span>Forward v<sub>0</sub><sup>+</sup></span></label>
      <label><input type="checkbox" bind:checked={showReflected} /><i style:background="#d9483b"></i><span>Reflection v<sup>−</sup></span></label>
      <label><input type="checkbox" bind:checked={showEcho} /><i style:background="#7c4dff"></i><span>Delayed echo v<sub>2</sub><sup>+</sup></span></label>
      <label><input type="checkbox" bind:checked={showTotal} /><i class="dash-swatch"></i><span>Total v</span></label>
    </div>
  </div>
</section>

<style>
  .wave-panel { display: grid; gap: 12px; }
  .wave-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 10px 16px; }
  .wave-head h2 { margin: 0 0 4px; }
  .wave-head b { color: var(--ink); font-weight: 550; }
  .canvas-wrap { position: relative; width: 100%; height: 295px; border: 1px solid var(--rule-soft); border-radius: 8px; overflow: hidden; background: #ffffff; }
  canvas { display: block; width: 100%; height: 100%; }
  .wave-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px 16px; }
  .play-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .time-tag { font-size: 12px; color: var(--ink-3); padding-left: 4px; }
  .wave-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 12.5px; color: var(--ink-2); }
  .wave-legend label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
  .wave-legend input { accent-color: var(--brand); margin: 0; }
  .wave-legend i { display: inline-block; width: 12px; height: 3px; border-radius: 2px; }
  .wave-legend i.dash-swatch { background: repeating-linear-gradient(90deg, #475569 0 4px, transparent 4px 7px); }
  @media (max-width: 680px) {
    .canvas-wrap { height: 260px; }
  }
</style>
