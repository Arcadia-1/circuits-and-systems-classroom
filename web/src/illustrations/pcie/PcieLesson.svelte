<script lang="ts">
  import { onMount } from 'svelte';
  import { isLightTheme } from '../../lib/theme';
  import Range from '../../components/ui/Range.svelte';
  import Segmented from '../../components/ui/Segmented.svelte';
  import { nf } from '../../lib/format';
  import { FLIT, FLIT_TLP, GENERATIONS, isolatedTlpNs, creditLimit, generation, linkGBps, payloadGBps, payloadShare, simulateLink, tlpNs, type LinkParams, type LinkRun } from './model';
  import CreditPlot from './CreditPlot.svelte';
  import SharePlot from './SharePlot.svelte';
  import type { PcieScene } from './scene';
  import { DLLP_COLORS, FIELD_COLORS, type PcieView } from './view';

  interface Link { gen: number; lanes: number; payload: number; header: number; latency: number; drain: number; credits: number }
  interface Step {
    title: string;
    body: string;
    look: string;
    link: Link;
    view: PcieView;
    /** ns of link time shown per second. */
    speed: number;
    action?: 'lanes' | 'gen' | 'payload' | 'zap' | 'credits';
    /** Damage a packet this long (ns of link time) after the step starts. */
    zapAfter?: number;
  }
  const BASE: Link = { gen: 3, lanes: 4, payload: 256, header: 16, latency: 100, drain: 40, credits: 8 };
  const TOUR: Step[] = [
    {
      title: 'One road for each device',
      body: 'PCI Express connects the CPU to the chips and cards around it: graphics cards, SSDs, network cards. The old PCI bus made every card share one set of wires; PCIe gives each device a link of its own, point to point. Data travels on it in <b>packets</b>, the coloured trains here, slowed down about 25 million times.',
      look: 'Packets leave the CPU on the left and reach the device on the right, while short messages come back the other way.',
      link: BASE, view: 'board', speed: 40,
    },
    {
      title: 'A lane is two one-way pairs',
      body: 'The link is made of <b>lanes</b>. A lane is four wires: one pair carries bits to the device, the other brings bits back, so both directions run at once. Each pair is a fast serial link like the one in the <a href="/serdes/112g-pam4-link/">SerDes lesson</a>, and the receiver finds the timing in the data itself (<a href="/serdes/clock-and-data-recovery/">clock and data recovery</a>).',
      look: 'Packets ride the far pair towards the device; small green, red and gold messages ride the near pair back.',
      link: { ...BASE, lanes: 1, payload: 64 }, view: 'lane', speed: 40,
    },
    {
      title: 'More lanes: bytes dealt like cards',
      body: 'Links come with 1, 2, 4, 8 or 16 lanes, written x1 to x16. The sender deals each packet’s bytes across them like cards: byte 0 to lane 0, byte 1 to lane 1, and round again. Every lane carries a slice of every packet, so with x4 a packet is on the wire for a quarter of the time it takes on x1.',
      look: 'Switch between x1 and x16: the trains get shorter, and more of them fit on the road.',
      link: BASE, view: 'board', speed: 40, action: 'lanes',
    },
    {
      title: 'Generations, coding and PAM4',
      body: 'Generation 1 (2003) sent 2.5 billion bits per second on each lane; nearly every generation since has doubled it, up to 128 in Gen 7 (2025). The line code got leaner too: 8b/10b spent 20% of the bits on keeping the signal balanced, 128b/130b only 1.5%. Gen 6 moved to four voltage levels (PAM4) and to fixed 256-byte <em>flits</em> with error correction.',
      look: 'Switch generations: Gen 1–5 show packet traffic; Gen 6–7 show the fixed FLIT format and its bandwidth.',
      link: BASE, view: 'board', speed: 40, action: 'gen',
    },
    {
      title: 'Envelopes around every packet',
      body: 'Data never travels bare. The <b>transaction layer</b> adds a header: what to do and at which address. The <b>data link layer</b> adds a sequence number and a 32-bit check, the LCRC. The <b>physical layer</b> marks the start, scrambles the bits and deals them over the lanes. Each envelope costs bytes, so a small packet carries more envelope than data.',
      look: 'Shrink the payload to 16 bytes: less than half of what is sent is data. The chart on the right shows why large packets are preferred.',
      link: BASE, view: 'packet', speed: 40, action: 'payload',
    },
    {
      title: 'Checked, then acknowledged or resent',
      body: 'The device recomputes the LCRC of every packet. A good one is answered with an <b class="g">ACK</b>. A damaged one gets a <b class="r">NAK</b>, and the CPU, which keeps a copy of everything not yet acknowledged in its <b>replay buffer</b>, sends that packet and all after it again. Nothing is lost, only a little late.',
      look: 'A packet turns red where noise hits it, the device throws it away with the ones behind it, a red NAK flies back and purple-headed copies follow in order.',
      link: BASE, view: 'cpu', speed: 40, action: 'zap', zapAfter: 110,
    },
    {
      title: 'Credits: never overflow the receiver',
      body: 'The device has room for only so many packets. It gives the CPU one <b class="y">packet slot</b> per free buffer position in this simplified model; the CPU spends one on every packet and waits when it has none left. A credit returns once the device has finished with a packet and the news has travelled back, so the link needs enough slots to cover that round trip. Real PCIe tracks separate header and data credits; each data credit covers 16 bytes.',
      look: 'Lower the credits to 2: gaps open between the packets and the data rate on the right drops to about half.',
      link: BASE, view: 'board', speed: 40, action: 'credits',
    },
    {
      title: 'The real link',
      body: 'A graphics card on Gen 5 x16 moves about 63 GB/s each way, an SSD on Gen 4 x4 about 7.9 GB/s. Everything you have seen happens at that pace: bytes dealt over lanes, envelopes checked, ACKs and credits flowing back, billions of times a second.',
      look: 'Build your own link with the controls on the left, or zap a packet at any time.',
      link: { gen: 5, lanes: 16, payload: 256, header: 16, latency: 100, drain: 4, credits: 32 }, view: 'board', speed: 20,
    },
  ];
  const VIEWS: { value: PcieView; label: string }[] = [
    { value: 'board', label: 'Board' },
    { value: 'lane', label: 'One lane' },
    { value: 'cpu', label: 'CPU side' },
    { value: 'device', label: 'Device side' },
    { value: 'packet', label: 'Packet' },
  ];
  const LANE_OPTIONS = [1, 2, 4, 8, 16].map((n) => ({ value: n, label: `x${n}` }));
  const GEN_OPTIONS = GENERATIONS.map((g) => ({ value: g.gen, label: `${g.gen}` }));

  let gen = $state(BASE.gen), lanes = $state(BASE.lanes), payloadLog = $state(Math.log2(BASE.payload)), header = $state(BASE.header);
  let latency = $state(BASE.latency), drain = $state(BASE.drain), credits = $state(BASE.credits);
  let playing = $state(true), speed = $state(40), labels = $state(true), spin = $state(false);
  let view = $state<PcieView | null>('board'), shown = $state<PcieView>('board');
  let tour = $state(0), tourOpen = $state(true);
  let light = $state(true), noGl = $state(false);
  let host: HTMLDivElement | undefined = $state();
  let readout = $state({ delivered: 0, sent: 0, resent: 0, naks: 0, measured: 0 });

  const step = $derived(TOUR[tour]);
  const payload = $derived(2 ** payloadLog);
  const g = $derived(generation(gen));
  const flit = $derived(g.code === 'flit');
  const params = $derived<LinkParams>({ tlpNs: tlpNs(g, lanes, payload, header), latencyNs: latency, drainNs: drain, credits });
  const linkRate = $derived(linkGBps(g, lanes));
  const share = $derived(payloadShare(g, payload, header));
  const dataRate = $derived(payloadGBps(g, lanes, payload, header));
  const creditShare = $derived(creditLimit(params));
  const rates = $derived(GENERATIONS.map((x) => ({ gen: x.gen, gts: x.gts, code: x.code, year: x.year, rate: linkGBps(x, lanes) })));
  const gbps = (v: number) => (v >= 100 ? nf(v, 0) : v >= 10 ? nf(v, 1) : nf(v, 2));
  const slowText = $derived.by(() => {
    const k = 1e9 / speed;
    return k >= 1e9 ? `${nf(k / 1e9, 1)} billion` : k >= 1e6 ? `${nf(k / 1e6, k >= 1e7 ? 0 : 1)} million` : `${nf(k / 1e3, 0)} thousand`;
  });

  /** The simulated link, the time shown (ns), and the transmissions damaged so far; plain fields so the frame loop stays out of reactivity. */
  const sim: { run: LinkRun | null; p: LinkParams; key: string; t: number; horizon: number; corrupt: number[]; zapAt: number } = { run: null, p: { tlpNs: 1, latencyNs: 100, drainNs: 0, credits: 8 }, key: '', t: 0, horizon: 0, corrupt: [], zapAt: -1 };
  const linkKey = () => JSON.stringify([params, payload, header, flit]);
  let scene: PcieScene | null = null;

  function simulate(): void {
    if (flit) { sim.run = null; return; }
    sim.run = simulateLink(sim.p, sim.horizon, sim.corrupt);
    scene?.setLink(sim.run, sim.p, payload, header, flit);
  }
  /** Start the traffic again for the link as set now, optionally damaging a packet `zapAfter` ns in. */
  function restart(zapAfter = -1): void {
    sim.key = linkKey();
    sim.p = { ...params };
    sim.t = 0;
    sim.corrupt = [];
    sim.zapAt = zapAfter;
    sim.horizon = Math.max(4000, 400 * sim.p.tlpNs, 30 * sim.p.latencyNs);
    simulate();
  }
  /** Noise hits the newest packet on the wire (or the next one to leave). */
  function zap(): void {
    const run = sim.run;
    if (!run) return;
    let i = run.sends.length - 1;
    while (i >= 0 && run.sends[i].start > sim.t) i--;
    if (i < 0 || run.sends[i].arrive <= sim.t || sim.corrupt.includes(i)) i = run.sends.findIndex((s) => s.start > sim.t);
    if (i < 0) return;
    sim.corrupt = [...sim.corrupt, i];
    simulate();
  }
  function applyStep(i: number): void {
    const st = TOUR[i];
    tour = i;
    gen = st.link.gen;
    lanes = st.link.lanes;
    header = st.link.header;
    latency = st.link.latency;
    drain = st.link.drain;
    credits = st.link.credits;
    payloadLog = Math.log2(st.link.payload);
    speed = st.speed;
    playing = true;
    restart(st.zapAfter ?? -1);
    go(st.view);
  }
  function go(v: PcieView): void {
    view = shown = v;
    scene?.flyTo(v);
  }

  // any change to the link restarts its traffic (a tour step has already restarted it); the lane count also re-lays the wires
  $effect(() => {
    if (linkKey() !== sim.key) restart();
  });
  $effect(() => {
    // read the lane count before the optional call, or the effect would not depend on it while the scene is loading
    const n = lanes;
    scene?.setLanes(n);
  });

  onMount(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) playing = false;
    light = isLightTheme();
    const themeWatch = new MutationObserver(() => {
      light = isLightTheme();
      scene?.setTheme(light);
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    let raf = 0, frame = 0, last = performance.now(), gone = false;
    import('./scene').then(({ PcieScene }) => {
      if (gone || !host) return;
      try {
        scene = new PcieScene(host, { reducedMotion: reduced, onUserMove: () => { view = null; spin = false; scene?.setSpin(false); } });
      } catch {
        noGl = true;
        return;
      }
      scene.setTheme(light);
      scene.setLabels(labels);
      scene.setSpin(spin);
      scene.setLanes(lanes);
      if (sim.run) scene.setLink(sim.run, sim.p, payload, header, flit);
      if (shown !== 'board') scene.flyTo(shown, 0.001);
    });
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frame++;
      if (playing && sim.run) {
        sim.t += dt * speed;
        if (sim.zapAt >= 0 && sim.t >= sim.zapAt) {
          sim.zapAt = -1;
          zap();
        }
        if (sim.t > 0.8 * sim.horizon) {
          sim.horizon *= 2;
          simulate();
        }
      }
      if (!flit) scene?.update(dt, sim.t);
      if (frame % 6 === 0 && sim.run) {
        const run = sim.run, window = Math.min(sim.t, Math.max(1000, 20 * sim.p.tlpNs));
        let got = 0, sent = 0, resent = 0, naks = 0;
        for (const a of run.accepted) if (a !== undefined && a > sim.t - window && a <= sim.t) got++;
        for (const s of run.sends) {
          if (s.start > sim.t) break;
          sent++;
          if (s.replay) resent++;
        }
        for (const d of run.dllps) if (d.kind === 'nak' && d.arrive <= sim.t) naks++;
        readout = { delivered: window > 0 ? (got * payload) / window : 0, sent, resent, naks, measured: window > 0 ? (got * sim.p.tlpNs) / window : 0 };
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
      themeWatch.disconnect();
      scene?.dispose();
      scene = null;
    };
  });
</script>

<main class="page scene-lesson pcie">
  <section class="work">
    <aside class="side" aria-label="Guided tour and settings">
      <section class="tour" aria-label="Guided tour">
        {#if tourOpen}
          <div class="tour-top">
            <span class="label">Guided tour · {tour + 1} of {TOUR.length}</span>
            <button type="button" class="link" onclick={() => (tourOpen = false)}>Hide</button>
          </div>
          <div class="dots" role="group" aria-label="Tour steps">
            {#each TOUR as t, i (t.title)}<button type="button" aria-label={`Step ${i + 1}: ${t.title}`} aria-current={i === tour ? 'step' : undefined} onclick={() => applyStep(i)}></button>{/each}
          </div>
          <h2>{step.title}</h2>
          <p>{@html step.body}</p>
          {#if step.action === 'lanes'}
            <Segmented size="sm" mono label="Lanes" options={LANE_OPTIONS} bind:value={lanes} />
          {:else if step.action === 'gen'}
            <div class="row"><span>Generation</span><Segmented size="sm" mono label="Generation" options={GEN_OPTIONS} bind:value={gen} /></div>
          {:else if step.action === 'payload'}
            <Range id="pcie-tour-payload" bind:value={payloadLog} min={4} max={12} step={1} output={`${payload.toLocaleString('en-US')} B`}>Payload</Range>
          {:else if step.action === 'zap'}
            <button type="button" class="primary" onclick={zap}>⚡ Zap a packet</button>
          {:else if step.action === 'credits'}
            <Range id="pcie-tour-credits" bind:value={credits} min={1} max={16} step={1} output={`${credits}`}>Packet slots</Range>
          {/if}
          <p class="look"><b>Look for</b>{step.look}</p>
          <div class="nav">
            <button type="button" disabled={tour === 0} onclick={() => applyStep(tour - 1)}>Back</button>
            {#if tour < TOUR.length - 1}
              <button type="button" class="primary" onclick={() => applyStep(tour + 1)}>Next</button>
            {:else}
              <button type="button" class="primary" onclick={() => (tourOpen = false)}>Explore on your own</button>
            {/if}
          </div>
        {:else}
          <button type="button" class="primary wide" onclick={() => { tourOpen = true; applyStep(0); }}>Start the guided tour</button>
        {/if}
      </section>
      <section>
        <h2 class="label">Link</h2>
        <div class="row"><span>Generation</span><Segmented size="sm" mono label="PCIe generation" options={GEN_OPTIONS} bind:value={gen} /></div>
        <div class="row"><span>Lanes</span><Segmented size="sm" mono label="Link width" options={LANE_OPTIONS} bind:value={lanes} /></div>
        <p class="hint">Gen {g.gen} ({g.year}) · {g.gts} GT/s per lane · {g.code === 'flit' ? 'PAM4, 256-byte flits with FEC' : g.code} · {gbps(lanes * g.gts / 8)} GB/s raw each way</p>
      </section>
      <section>
        <h2 class="label">Packets</h2>
        <Range id="pcie-payload" bind:value={payloadLog} min={4} max={12} step={1} output={`${payload.toLocaleString('en-US')} B`}>Payload</Range>
        <div class="row"><span>{flit ? 'Modeled TLP header' : 'Header'}</span><Segmented size="sm" label="Header size" options={[{ value: 12, label: '12 B (32-bit address)' }, { value: 16, label: '16 B' }]} bind:value={header} /></div>
        <p class="hint">{nf(share * 100, 1)}% of the line rate is data · {flit ? 'packed-stream average' : 'serialization per packet'} {nf(params.tlpNs, params.tlpNs < 10 ? 2 : 1)} ns</p>
      </section>
      {#if !flit}
      <section>
        <h2 class="label">Round trip</h2>
        <Range id="pcie-latency" bind:value={latency} min={20} max={400} step={10} output={`${latency} ns`}>Latency, one way</Range>
        <Range id="pcie-drain" bind:value={drain} min={0} max={200} step={2} output={`${drain} ns`}>Device time per packet</Range>
        <Range id="pcie-credits" bind:value={credits} min={1} max={32} step={1} output={`${credits}`}>Packet slots</Range>
        <p class="hint">A slot returns no sooner than {nf(params.tlpNs + 2 * latency + drain, 0)} ns. {#if drain > params.tlpNs}Device processing limits utilization to {nf(100 * params.tlpNs / drain, 0)}%, even with more slots.{:else}{Math.ceil((params.tlpNs + 2 * latency + drain) / params.tlpNs)} slots cover this round trip.{/if}</p>
      </section>
      <section>
        <h2 class="label">Playback</h2>
        <div class="row start">
          <button type="button" class="primary" aria-pressed={playing} onclick={() => (playing = !playing)}>{playing ? 'Pause' : 'Play'}</button>
          <button type="button" onclick={() => restart()}>Restart</button>
          <button type="button" onclick={zap}>⚡ Zap</button>
          <button type="button" aria-pressed={labels} onclick={() => { labels = !labels; scene?.setLabels(labels); }}>Labels</button>
          <button type="button" aria-pressed={spin} onclick={() => { spin = !spin; scene?.setSpin(spin); }}>Auto-rotate</button>
        </div>
        <Range id="pcie-speed" bind:value={() => Math.log10(speed), (x: number) => (speed = Number((10 ** x).toPrecision(2)))} min={0} max={3.6} step={0.01} output={`${nf(speed, speed < 10 ? 1 : 0)} ns/s`}>Speed</Range>
        <p class="hint">Each second shows {nf(speed, speed < 10 ? 1 : 0)} ns of the link: {slowText} times slower than real</p>
      </section>
      <section>
        <h2 class="label">Key</h2>
        <ul class="legend-list">
          <li><i class="bar" style:background={FIELD_COLORS.framing}></i>start of packet + sequence number</li>
          <li><i class="bar" style:background={FIELD_COLORS.header}></i>header · <i class="bar inline" style:background={FIELD_COLORS.replay}></i>header of a resent copy</li>
          <li><i class="bar" style:background={FIELD_COLORS.payload}></i>payload: the data</li>
          <li><i class="bar" style:background={FIELD_COLORS.lcrc}></i>LCRC: the error check</li>
          <li><i class="bar" style:background={FIELD_COLORS.bad}></i>damaged by noise</li>
          <li><i style:background={DLLP_COLORS.ack}></i>ACK · <i class="inline" style:background={DLLP_COLORS.nak}></i>NAK · <i class="inline" style:background={DLLP_COLORS.credit}></i>credit, coming back</li>
        </ul>
      </section>
      {/if}
    </aside>

    <div class="stage" class:flit-mode={flit} bind:this={host}>
      {#if flit}
        <section class="flit-card" aria-label="FLIT format and serialization">
          <span class="label">Gen {gen} · PAM4 · {g.gts / 2} GBd per lane</span>
          <h2>One FLIT, 256 bytes</h2>
          <p>TLPs share a fixed block. CRC, FEC and replay protect the FLIT.</p>
          <div class="flit-block" aria-label="236 bytes TLP, 6 bytes data link, 8 bytes CRC, 6 bytes FEC">
            {#each Array.from({ length: 256 }, (_, i) => i) as i}<i class:tlp={i < 236} class:dlp={i >= 236 && i < 242} class:crc={i >= 242 && i < 250} class:fec={i >= 250}></i>{/each}
          </div>
          <div class="flit-key"><span><i class="tlp"></i>236 B · TLPs</span><span><i class="dlp"></i>6 B · link</span><span><i class="crc"></i>8 B · CRC</span><span><i class="fec"></i>6 B · FEC</span></div>
          <div class="flit-equation">256 × 8 ÷ ({lanes} × {g.gts}) = <b>{nf(FLIT * 8 / (lanes * g.gts), 2)} ns</b></div>
          <p>One {header + payload}-byte modeled TLP starting in an empty FLIT needs <b>{Math.ceil((header + payload) / FLIT_TLP)} FLITs</b>: {nf(isolatedTlpNs(g, lanes, payload, header), 2)} ns, including final padding.</p>
          <p class="hint">Continuous packing shares that padding with the next TLP. Payload rates are upper bounds with the chosen header size; optional headers, ordered sets and scheduling are excluded.</p>
          <p class="hint">Select Gen 1–5 to explore LCRC, ACK/NAK and packet replay. Gen 6–7 use FLIT-level error correction and replay; that protocol is not animated here.</p>
        </section>
      {/if}
      {#if !flit}
      {#if noGl}<p class="nogl">This view needs WebGL, which is turned off or unavailable in this browser.</p>{/if}
      <div class="views" role="group" aria-label="Camera views">
        {#each VIEWS as v (v.value)}<button type="button" aria-pressed={view === v.value} onclick={() => go(v.value)}>{v.label}</button>{/each}
      </div>
      {/if}
    </div>

    <aside class="scope" aria-label="Link numbers">
      <div class="numbers">
        <div class="metric"><span class="label">{flit ? 'After CRC & FEC' : 'After line coding'}</span><span class="mono big">{gbps(linkRate)}</span><span class="unit">GB/s</span></div>
        <div class="metric"><span class="label">{flit ? 'Payload ceiling' : 'Data arriving now'}</span><span class="mono big">{gbps(flit ? dataRate : readout.delivered)}</span><span class="unit">GB/s</span></div>
      </div>
      <p class="hint">Raw rate: {gbps(lanes * g.gts / 8)} GB/s each way. Payload ceiling: {gbps(dataRate)} GB/s ({nf(share * 100, 1)}% of raw). {flit ? 'The first number includes the 6-byte data-link field.' : `Buffer slots and device service limit utilization to ${nf(creditShare * 100, 0)}%.`}</p>
      {#if !flit}<div class="line">
        <span class="counts mono">{readout.sent.toLocaleString('en-US')} sent · {readout.resent} resent · {readout.naks} NAK{readout.naks === 1 ? '' : 's'}</span>
      </div>{/if}
      <div class="bars" role="group" aria-label="Bandwidth of each generation at this link width">
        <div class="cap"><span class="label">Each generation, x{lanes}</span><span>GB/s each way</span></div>
        {#each rates as r (r.gen)}
          <button type="button" class="bar-row" aria-pressed={r.gen === gen} onclick={() => (gen = r.gen)}>
            <span class="mono">Gen {r.gen}</span>
            <span class="track"><span class="fill" style:width={`${100 * r.rate / rates[6].rate}%`}></span></span>
            <span class="mono val">{gbps(r.rate)}</span>
          </button>
        {/each}
        <p class="hint">Linear scale, after line coding or CRC/FEC. Gen 2 → 3 rises from 5 to 8 GT/s; coding efficiency also improves. Click to switch.</p>
      </div>
      <div class="chart">
        <div class="cap"><span class="label">Share of the link that is data</span><span>payload size</span></div>
        <SharePlot {g} {header} {payload} />
      </div>
      {#if !flit}<div class="chart">
        <div class="cap"><span class="label">Data rate against packet slots</span><span><i class="k1"></i>limit <i class="dot"></i>measured</span></div>
        <CreditPlot p={params} measured={readout.measured} />
      </div>
      <p class="hint">One slot per packet is a teaching abstraction. PCIe has separate posted, non-posted and completion header/data credit pools. ACKs can be cumulative; this model replies to every TLP and omits return-link serialization.</p>{/if}
    </aside>
  </section>
</main>

<style>
  .flit-mode :global(.pcie-canvas), .flit-mode :global(.pcie-labels) { visibility: hidden; }
  .flit-card { position: relative; z-index: 2; padding: clamp(18px, 3vw, 42px); height: 100%; overflow: auto; display: flex; flex-direction: column; justify-content: flex-start; gap: 18px; background: var(--plot); }
  .flit-card h2 { font-size: 26px; margin: 0; }
  .flit-card p { margin: 0; font-size: 14px; line-height: 1.6; }
  .flit-block { display: grid; grid-template-columns: repeat(16, 1fr); gap: 3px; }
  .flit-block i { aspect-ratio: 1.8; border-radius: 2px; }
  .tlp { background: var(--brand); } .dlp { background: var(--s1); } .crc { background: var(--s2); } .fec { background: #9971c7; }
  .flit-key { display: flex; flex-wrap: wrap; gap: 10px 16px; font: 12px var(--mono); }
  .flit-key i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; }
  .flit-equation { font: 15px var(--mono); }
  .pcie { grid-template-rows: minmax(0, 1fr); }
  .work { display: grid; grid-template-columns: 290px minmax(0, 1fr) 320px; gap: 18px; min-height: 0; }
  .side, .scope { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
  .side { --accent: var(--brand); --accent-soft: var(--brand-soft); }
  .side section { display: grid; gap: 8px; padding: 12px 0; border-top: 1px solid var(--rule); }
  .side section:first-child { border-top: 0; padding-top: 2px; }
  .side h2 { margin: 0; }
  .side section.tour { gap: 10px; padding: 14px; margin-bottom: 4px; border: 0; border-radius: 10px; background: var(--plot); box-shadow: inset 0 0 0 1px var(--rule); }
  .side section :global(.range) { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'label out' 'input input'; align-items: center; gap: 5px 8px; }
  .side section :global(.range label) { grid-area: label; }
  .side section :global(.range input) { grid-area: input; width: 100%; }
  .side section :global(.range output) { grid-area: out; width: auto; text-align: right; }
  .tour-top { display: flex; align-items: center; justify-content: space-between; }
  .tour h2 { font: 600 17px/1.25 var(--sans); color: var(--ink); letter-spacing: -0.01em; }
  .tour p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--ink-2); }
  .tour p :global(b) { color: var(--ink); font-weight: 600; }
  .tour p :global(b.g) { color: var(--brand); }
  .tour p :global(b.r) { color: var(--bad); }
  .tour p :global(b.y) { color: var(--s2); }
  .tour p :global(a) { color: var(--brand); }
  .tour .look { padding: 8px 10px; border-radius: 8px; background: var(--brand-soft); color: var(--ink); font-size: 13px; }
  .tour .look b { display: block; margin-bottom: 2px; font: 500 11px/1.3 var(--sans); letter-spacing: 0.09em; text-transform: uppercase; color: var(--brand); }
  .dots { display: flex; gap: 6px; }
  .dots button { width: 22px; height: 6px; padding: 0; border-radius: 3px; background: var(--rule); box-shadow: none; }
  .dots button[aria-current='step'] { background: var(--brand); }
  .nav { display: flex; justify-content: space-between; gap: 8px; }
  .nav button { min-width: 84px; }
  button.link { padding: 2px 4px; background: none; box-shadow: none; color: var(--ink-3); font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
  button.wide { width: 100%; padding: 10px; }
  button:disabled { opacity: 0.4; cursor: default; }
  .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--ink-2); }
  .row.start { justify-content: flex-start; gap: 6px; }
  .hint { margin: -2px 0 0; font: 11px/1.45 var(--mono); color: var(--ink-3); }
  .legend-list { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--ink-2); }
  .legend-list i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; vertical-align: -1px; }
  .legend-list i.bar { width: 14px; height: 7px; border-radius: 2px; vertical-align: 0; }
  .legend-list i.inline { margin-left: 4px; }
  .stage { position: relative; min-height: 0; overflow: hidden; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--rule); background: var(--plot); }
  .stage :global(.pcie-canvas) { position: absolute; inset: 0; display: block; touch-action: none; }
  .stage :global(.pcie-labels) { position: absolute; inset: 0; pointer-events: none; }
  .stage :global(.pcie-lbl) { position: relative; top: -14px; padding: 3px 7px; border-radius: 5px; background: color-mix(in srgb, var(--plot) 88%, transparent); box-shadow: 0 0 0 1px var(--rule); color: var(--ink); font: 500 11.5px/1.25 var(--sans); white-space: nowrap; transition: opacity 0.3s; }
  .stage :global(.pcie-lbl small) { display: block; font-size: 10.5px; color: var(--ink-3); }
  .stage :global(.pcie-lbl.tick) { top: 0; padding: 1px 5px; font: 500 10.5px var(--mono); color: var(--ink-2); }
  .stage :global(.pcie-lbl.dir) { top: -8px; font-size: 11px; color: var(--ink-2); }
  .stage :global(.pcie-lbl.note) { top: 0; font-size: 11px; color: var(--ink-2); }
  .stage :global(.pcie-lbl.noise) { color: var(--bad); box-shadow: 0 0 0 1px color-mix(in srgb, var(--bad) 60%, transparent); }
  .stage :global(.far .pcie-lbl) { opacity: 0; }
  .nogl { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 20px; color: var(--ink-2); text-align: center; }
  .views { position: absolute; z-index: 2; top: 10px; left: 10px; display: flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 8px; background: color-mix(in srgb, var(--plot) 86%, transparent); box-shadow: inset 0 0 0 1px var(--rule); }
  button { font: 500 12.5px/1 var(--sans); color: var(--ink-2); background: var(--plot); border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; white-space: nowrap; box-shadow: inset 0 0 0 1px var(--rule); }
  button:hover:not(:disabled) { color: var(--ink); }
  .views button { box-shadow: none; background: transparent; }
  button[aria-pressed='true'] { color: var(--ink); background: var(--brand-soft); box-shadow: inset 0 0 0 1px var(--brand); }
  button.primary { color: var(--ground); background: var(--brand); box-shadow: none; min-width: 58px; }
  button.primary:hover:not(:disabled) { color: var(--ground); filter: brightness(1.08); }
  .scope { gap: 10px; }
  .numbers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .metric { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 5px; }
  .metric .label { width: 100%; }
  .big { font-size: 24px; letter-spacing: -0.02em; color: var(--ink); }
  .unit { font-size: 12px; color: var(--ink-2); }
  .line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .counts { font-size: 11px; color: var(--ink-3); }
  .bars { display: grid; gap: 3px; flex: none; }
  .bar-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; align-items: center; gap: 8px; padding: 3px 6px; box-shadow: none; background: transparent; font-size: 11.5px; }
  .bar-row .track { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--rule) 60%, transparent); overflow: hidden; }
  .bar-row .fill { display: block; height: 100%; border-radius: 4px; background: var(--s1); }
  .bar-row[aria-pressed='true'] .fill { background: var(--brand); }
  .bar-row .val { text-align: right; color: var(--ink); }
  .chart { display: flex; flex-direction: column; gap: 2px; height: 150px; flex: none; }
  .cap { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 10px; font-size: 12px; color: var(--ink-2); }
  .cap i { display: inline-block; width: 10px; height: 2px; margin: 0 5px 3px 8px; vertical-align: middle; }
  .cap i.dot { width: 8px; height: 8px; border-radius: 50%; margin-bottom: 0; background: var(--s2); }
  .k1 { background: var(--s1); }
  .scope .hint { margin: -4px 0 2px; }
  @media (max-width: 1180px) { .work { grid-template-columns: 260px minmax(0, 1fr) 290px; gap: 14px; } }
  @media (max-width: 900px) {
    .pcie.scene-lesson .work > .stage.flit-mode { height: auto; min-height: 0; }
    .flit-mode .flit-card { height: auto; overflow: visible; }
    .work { grid-template-columns: minmax(0, 1fr); }
    .stage { order: -1; height: 62vh; min-height: 380px; }
    .side, .scope { overflow: visible; padding-right: 0; }
  }
</style>
