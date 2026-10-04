/**
 * A PCI Express link on a motherboard: the CPU (root complex) on the left, a device on the right, and between them the
 * lanes, each a pair of wires to the device and a pair back. Every TLP is a train of coloured fields dealt across all
 * lanes at once, so more lanes make it shorter; ACK, NAK and credit messages ride back the same way. The CPU keeps
 * unacknowledged copies on its replay shelf and spends credits from its stack; the device fills and empties its
 * receive buffer. Client-only; PcieLesson.svelte loads it on mount.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { LinkParams, LinkRun } from './model';
import { DLLP_COLORS, FIELD_COLORS, fields, type PcieView } from './view';

/** Traces run from XA to XB; lanes sit GAP apart, each a pair to the device at −PAIR/2 and a pair back at +PAIR/2. */
const XA = -18.5, XB = 18.5, LX = XB - XA, GAP = 1.15, PAIR = 0.52, WIRE = 0.075;
const CPU_X = -24, DEV_X = 24, MAX_LANES = 16;
/** Visible length of a message on the wire, a replayed copy's shelf spacing, and how long a rejected packet lingers. */
const DLLP_LEN = 0.45, SPLASH = 0.35;
/** Where the noise that damages a packet strikes. */
const NOISE_X = 0;
const THEMES = {
  dark: { bg: 0x0a0d13, floorIn: '#141b26', floorOut: '#0a0d13', shadow: 0.5, grid: 0x243041, sky: 0xa9c1d6, ground: 0x10161d, hemi: 0.6, sun: 1.9, env: 0.45, board: 0x10392c, copper: 0xc98a4b },
  light: { bg: 0xf6f8fa, floorIn: '#ffffff', floorOut: '#f6f8fa', shadow: 0.2, grid: 0xc9d2de, sky: 0xffffff, ground: 0x9aa6b2, hemi: 0.95, sun: 2.2, env: 0.75, board: 0x1f6b4d, copper: 0xd49254 },
};
const VIEWS: Record<PcieView, [[number, number, number], [number, number, number]]> = {
  board: [[0, 38, 24], [0, 0, 1]],
  lane: [[-10, 4.6, 8.5], [-4, 0, 0]],
  cpu: [[-11, 17, 21], [-10, 0, 2]],
  device: [[16, 15, 22], [15, 0, 2]],
  packet: [[0, 9, -1], [0, 4.4, -16]],
};

type FieldKey = 'framing' | 'header' | 'payload' | 'lcrc';
interface Label { wrap: HTMLDivElement; el: HTMLDivElement; obj: CSS2DObject; world: THREE.Vector3; lod: number; far: boolean; text: string }

/** Index of the last element whose key is ≤ t, or −1. */
function lastAtOrBefore(n: number, key: (i: number) => number, t: number): number {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(mid) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export class PcieScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2000);
  private readonly controls: OrbitControls;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly resizeObserver: ResizeObserver;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x9aa6b2, 0.9);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly floorCanvas = document.createElement('canvas');
  private readonly floorTex: THREE.CanvasTexture;
  private readonly shadowCatcher: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private readonly grid: THREE.GridHelper;
  private readonly boardMat = new THREE.MeshStandardMaterial({ color: THEMES.dark.board, roughness: 0.7, metalness: 0.05 });
  private readonly copperMat = new THREE.MeshStandardMaterial({ color: THEMES.dark.copper, roughness: 0.35, metalness: 0.8 });
  private readonly traces: THREE.InstancedMesh;
  private readonly trains: THREE.InstancedMesh;
  private readonly slabs: THREE.InstancedMesh;
  private readonly splashes: THREE.InstancedMesh;
  private readonly shelf: THREE.InstancedMesh;
  private readonly coins: THREE.InstancedMesh;
  private readonly slots: THREE.InstancedMesh;
  private readonly fills: THREE.InstancedMesh;
  private readonly anatomy: Record<FieldKey, THREE.Mesh> = {} as Record<FieldKey, THREE.Mesh>;
  private readonly anatomyLabels: Partial<Record<FieldKey, Label>> = {};
  private flitNote!: Label;
  private readonly shelfLabel: Label;
  private readonly coinLabel: Label;
  private readonly slotLabel: Label;
  private readonly noise: Label;
  private readonly laneLabels: Label[] = [];
  private readonly dirLabels: Label[] = [];
  private readonly colors = {
    framing: new THREE.Color(FIELD_COLORS.framing), header: new THREE.Color(FIELD_COLORS.header), payload: new THREE.Color(FIELD_COLORS.payload), lcrc: new THREE.Color(FIELD_COLORS.lcrc),
    replay: new THREE.Color(FIELD_COLORS.replay), bad: new THREE.Color(FIELD_COLORS.bad), dropped: new THREE.Color(0x7d8794),
    ack: new THREE.Color(DLLP_COLORS.ack), nak: new THREE.Color(DLLP_COLORS.nak), credit: new THREE.Color(DLLP_COLORS.credit),
    slot: new THREE.Color(0x3b4656), fill: new THREE.Color(FIELD_COLORS.payload),
  };
  private readonly m4 = new THREE.Matrix4();
  private readonly v3 = new THREE.Vector3();
  private readonly s3 = new THREE.Vector3();
  private readonly qi = new THREE.Quaternion();
  private readonly labelList: Label[] = [];
  private tween: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number; dur: number } | null = null;
  /** The view the camera was sent to, kept fitted to the stage until the user moves the camera. */
  private current: PcieView | null = 'board';
  private spin = false;
  private frame = 0;
  private readonly reduced: boolean;
  private lanes = 4;
  private run: LinkRun | null = null;
  private p: LinkParams = { tlpNs: 1, latencyNs: 100, drainNs: 0, credits: 8 };
  private layout: { key: FieldKey; from: number; to: number }[] = [];
  /** Times from the run, each in increasing order, for counting what happened by a given time. */
  private creditBack: number[] = [];
  private acceptedAt: number[] = [];
  private drainedAt: number[] = [];
  private releasedAt: number[] = [];

  constructor(host: HTMLElement, opts: { reducedMotion: boolean; onUserMove: () => void }) {
    this.host = host;
    this.reduced = opts.reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.className = 'pcie-canvas';
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'pcie-labels';
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(THEMES.light.bg);
    this.scene.fog = new THREE.Fog(THEMES.light.bg, 160, 520);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(this.hemi);
    this.sun.position.set(-30, 60, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 10, far: 200 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.floorCanvas.width = this.floorCanvas.height = 512;
    this.floorTex = new THREE.CanvasTexture(this.floorCanvas);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(600, 64), new THREE.MeshBasicMaterial({ map: this.floorTex, toneMapped: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.02;
    this.scene.add(floor);
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.4 }));
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.y = -1;
    this.shadowCatcher.receiveShadow = true;
    this.scene.add(this.shadowCatcher);
    this.grid = new THREE.GridHelper(200, 50, THEMES.dark.grid, THEMES.dark.grid);
    this.grid.position.y = -0.99;
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.5;
    gm.depthWrite = false;
    this.scene.add(this.grid);

    // the motherboard, the CPU and the device
    const board = new THREE.Mesh(new THREE.BoxGeometry(66, 0.6, 34), this.boardMat);
    board.position.set(0, -0.3, -1);
    board.receiveShadow = true;
    this.scene.add(board);
    this.chip(CPU_X, 10, 10, 0x3a3f48, 0xb9c2cc, 7.4);
    const card = new THREE.Mesh(new THREE.BoxGeometry(11, 0.3, 13), new THREE.MeshStandardMaterial({ color: 0x173f63, roughness: 0.6 }));
    card.position.set(DEV_X + 0.5, 0.45, 0);
    card.castShadow = card.receiveShadow = true;
    this.scene.add(card);
    const connector = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 13.4), new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.5 }));
    connector.position.set(XB + 0.9, 0.45, 0);
    connector.castShadow = true;
    this.scene.add(connector);
    this.chip(DEV_X, 6, 6, 0x2b3038, 0x9aa6b2, 4.4, 0.6);
    for (const z of [-4.3, 4.3]) {
      const mem = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.35, 2.2), new THREE.MeshStandardMaterial({ color: 0x20252c, roughness: 0.4 }));
      mem.position.set(DEV_X + 3.2, 0.78, z);
      mem.castShadow = true;
      this.scene.add(mem);
    }

    // the wires of all sixteen lanes; setLanes shows as many as the link uses
    this.traces = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.copperMat, MAX_LANES * 4);
    this.traces.receiveShadow = true;
    this.scene.add(this.traces);
    // lit for shape, but kept out of tone mapping so the field colours stay as saturated as in the key
    const unlit = () => new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, envMapIntensity: 0.25, toneMapped: false });
    this.trains = this.instanced(unlit(), 6144, true);
    this.slabs = this.instanced(unlit(), 4096, false);
    this.splashes = this.instanced(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, toneMapped: false }), 512, false);
    this.shelf = this.instanced(unlit(), 32, true);
    this.coins = this.instanced(new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.8 }), 64, true, new THREE.CylinderGeometry(0.42, 0.42, 0.14, 24));
    this.slots = this.instanced(new THREE.MeshStandardMaterial({ roughness: 0.6, transparent: true, opacity: 0.55 }), 64, false);
    this.fills = this.instanced(unlit(), 64, true);
    // the replay shelf in front of the CPU, the credit tray behind it, the receive buffer in front of the device
    const shelfBase = new THREE.Mesh(new THREE.BoxGeometry(10, 0.25, 2.2), new THREE.MeshStandardMaterial({ color: 0x59636f, roughness: 0.5, metalness: 0.4 }));
    shelfBase.position.set(CPU_X, 0.12, 8.2);
    shelfBase.receiveShadow = true;
    this.scene.add(shelfBase);
    const tray = new THREE.Mesh(new THREE.BoxGeometry(10, 0.2, 2.6), new THREE.MeshStandardMaterial({ color: 0x4a4236, roughness: 0.5, metalness: 0.5 }));
    tray.position.set(CPU_X, 0.1, -8.4);
    this.scene.add(tray);
    const rack = new THREE.Mesh(new THREE.BoxGeometry(10, 0.25, 2.2), new THREE.MeshStandardMaterial({ color: 0x59636f, roughness: 0.5, metalness: 0.4 }));
    rack.position.set(DEV_X, 0.12, 8.2);
    this.scene.add(rack);
    this.buildAnatomy();

    this.label('CPU · root complex', new THREE.Vector3(CPU_X, 3.2, -1), 400);
    this.label('Device · endpoint', new THREE.Vector3(DEV_X, 3.2, -1), 400);
    this.shelfLabel = this.label('', new THREE.Vector3(CPU_X, 2.6, 8.2), 120);
    this.coinLabel = this.label('', new THREE.Vector3(CPU_X, 2.6, -8.4), 120);
    this.slotLabel = this.label('', new THREE.Vector3(DEV_X, 2.6, 8.2), 120);
    this.noise = this.label('⚡ noise hits a packet', new THREE.Vector3(NOISE_X, 2.2, 0), 400, 'noise');
    this.noise.el.hidden = true;
    for (let i = 0; i < MAX_LANES; i++) this.laneLabels.push(this.label(`lane ${i}`, new THREE.Vector3(XA - 1.1, 0.2, 0), 34, 'tick'));
    this.dirLabels.push(this.label('to the device →', new THREE.Vector3(-8, 0.5, 0), 26, 'dir'), this.label('← back to the CPU', new THREE.Vector3(-3, 0.5, 0), 26, 'dir'));

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 4, maxDistance: 220, maxPolarAngle: Math.PI * 0.48, autoRotateSpeed: 0.45 });
    this.controls.addEventListener('start', () => {
      this.tween = null;
      this.current = null;
      opts.onUserMove();
    });
    this.setLanes(4);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    const start = this.pose('board');
    this.controls.target.copy(start.tgt);
    this.camera.position.copy(start.pos);
    if (!this.reduced) {
      this.camera.position.add(new THREE.Vector3(-14, 16, 24));
      this.flyTo('board', 2.2);
    }
  }

  setTheme(light: boolean): void {
    const th = light ? THEMES.light : THEMES.dark;
    (this.scene.background as THREE.Color).setHex(th.bg);
    (this.scene.fog as THREE.Fog).color.setHex(th.bg);
    const g = this.floorCanvas.getContext('2d');
    if (g) {
      const r = g.createRadialGradient(256, 256, 20, 256, 256, 256);
      r.addColorStop(0, th.floorIn);
      r.addColorStop(0.4, th.floorIn);
      r.addColorStop(1, th.floorOut);
      g.fillStyle = r;
      g.fillRect(0, 0, 512, 512);
      this.floorTex.needsUpdate = true;
    }
    this.shadowCatcher.material.opacity = th.shadow;
    const ca = this.grid.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color(th.grid);
    for (let i = 0; i < ca.count; i++) ca.setXYZ(i, c.r, c.g, c.b);
    ca.needsUpdate = true;
    this.hemi.color.setHex(th.sky);
    this.hemi.groundColor.setHex(th.ground);
    this.hemi.intensity = th.hemi;
    this.sun.intensity = th.sun;
    this.scene.environmentIntensity = th.env;
    this.boardMat.color.setHex(th.board);
    this.copperMat.color.setHex(th.copper);
  }
  setLabels(on: boolean): void {
    this.labels.domElement.hidden = !on;
  }
  setSpin(on: boolean): void {
    this.spin = on;
  }
  flyTo(view: PcieView, dur = 1.3): void {
    this.current = view;
    const { pos, tgt } = this.pose(view);
    this.tween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: tgt, k: 0, dur: this.reduced ? 0.001 : dur };
  }

  /** Lay out `lanes` lanes of wires, centred on the board, with their numbers and the direction labels on lane 0. */
  setLanes(lanes: number): void {
    this.lanes = Math.max(1, Math.min(MAX_LANES, lanes));
    let k = 0;
    for (let l = 0; l < this.lanes; l++) {
      const z = this.laneZ(l);
      for (const side of [-1, 1]) for (const w of [-1, 1]) {
        this.traces.setMatrixAt(k++, this.m4.compose(this.v3.set(0, 0.015, z + (side * PAIR) / 2 + w * 0.085), this.qi, this.s3.set(LX + 1.2, 0.03, WIRE)));
      }
    }
    this.traces.count = k;
    this.traces.instanceMatrix.needsUpdate = true;
    this.laneLabels.forEach((l, i) => {
      this.move(l, XA - 1.2, 0.2, this.laneZ(i));
      l.el.hidden = i >= this.lanes;
    });
    const z0 = this.laneZ(0);
    this.move(this.dirLabels[0], -6, 0.5, z0 - PAIR / 2);
    this.move(this.dirLabels[1], -1.5, 0.5, z0 + PAIR / 2);
    if (this.current === 'lane') this.flyTo('lane', 0.6);
  }

  /** The run to draw, the link it came from, and the packet layout (flit mode has no per-packet framing or LCRC). */
  setLink(run: LinkRun, p: LinkParams, payload: number, header: number, flit: boolean): void {
    this.run = run;
    this.p = p;
    const parts = fields(payload, header, flit), total = parts.reduce((a, f) => a + f.bytes, 0);
    let at = 0;
    this.layout = parts.map((f) => {
      const from = at / total;
      at += f.bytes;
      return { key: f.key, from, to: at / total };
    });
    this.creditBack = run.dllps.filter((d) => d.kind === 'credit').map((d) => d.arrive);
    this.acceptedAt = [];
    this.drainedAt = [];
    this.releasedAt = [];
    for (let s = 0; s < run.accepted.length && run.accepted[s] !== undefined; s++) this.acceptedAt.push(run.accepted[s]);
    for (let s = 0; s < run.drained.length && run.drained[s] !== undefined; s++) this.drainedAt.push(run.drained[s]);
    for (let s = 0; s < run.released.length && run.released[s] !== undefined; s++) this.releasedAt.push(run.released[s]);
    this.updateAnatomy(payload, header, flit);
  }

  update(dt: number, t: number): void {
    this.frame++;
    if (this.run) this.draw(t);
    if (this.tween) {
      const tw = this.tween;
      tw.k = Math.min(1, tw.k + dt / tw.dur);
      const e = tw.k < 0.5 ? 4 * tw.k ** 3 : 1 - (-2 * tw.k + 2) ** 3 / 2;
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (tw.k >= 1) this.tween = null;
    }
    this.controls.autoRotate = this.spin && !this.tween;
    this.controls.update(dt);
    if (this.frame % 4 === 0) {
      for (const l of this.labelList) {
        const far = this.camera.position.distanceTo(l.world) > l.lod;
        if (far !== l.far) {
          l.far = far;
          l.wrap.classList.toggle('far', far);
        }
      }
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      for (const mat of ([] as THREE.Material[]).concat(m.material ?? [])) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
    this.scene.environment?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  /* ------------------------------------------------------------------ drawing one moment */

  private draw(t: number): void {
    const run = this.run as LinkRun, p = this.p, lat = p.latencyNs, x = (dep: number) => XA + ((t - dep) / lat) * LX;
    const clampX = (v: number) => Math.min(XB, Math.max(XA, v));
    // packets on the wire: every field of every packet on every lane
    let k = 0, ks = 0, zapped = false;
    const last = lastAtOrBefore(run.sends.length, (i) => run.sends[i].start, t);
    for (let i = last; i >= 0; i--) {
      const s = run.sends[i];
      if (s.arrive + SPLASH * lat < t) {
        if (s.start < t - 4 * (p.tlpNs + lat)) break;
        continue;
      }
      if (t >= s.arrive) {
        // a packet the device refused fades at its door
        if (s.fate === 'corrupt' || s.fate === 'dropped') {
          const fade = 1 - (t - s.arrive) / (SPLASH * lat);
          for (let l = 0; l < this.lanes && ks < this.splashes.instanceMatrix.count; l++) {
            this.splashes.setMatrixAt(ks, this.m4.compose(this.v3.set(XB - 0.4, 0.25, this.laneZ(l) - PAIR / 2), this.qi, this.s3.set(0.8 * fade + 0.1, 0.5 * fade + 0.05, 0.4)));
            this.splashes.setColorAt(ks++, s.fate === 'corrupt' ? this.colors.bad : this.colors.dropped);
          }
        }
        continue;
      }
      const dur = s.end - s.start;
      // a sliver of space after each packet so back-to-back packets stay countable (the real link has none)
      const gap = Math.min(0.3, 0.12 * (p.tlpNs / lat) * LX);
      if (s.corrupt && x(s.start) > NOISE_X && x(s.end) < NOISE_X) zapped = true;
      for (const f of this.layout) {
        const lead = clampX(x(s.start + f.from * dur)), tail = clampX(x(s.start + f.to * dur) + (f.to === 1 ? gap : 0));
        const own = s.replay && f.key === 'header' ? this.colors.replay : this.colors[f.key];
        // a damaged packet turns red where the noise hit it
        const pieces: [number, number, THREE.Color][] = s.corrupt ? [[Math.min(lead, NOISE_X), tail, own], [lead, Math.max(tail, NOISE_X), this.colors.bad]] : [[lead, tail, own]];
        for (const [a, b, color] of pieces) {
          if (a - b < 0.01) continue;
          for (let l = 0; l < this.lanes && k < this.trains.instanceMatrix.count; l++) {
            this.trains.setMatrixAt(k, this.m4.compose(this.v3.set((a + b) / 2, 0.2, this.laneZ(l) - PAIR / 2), this.qi, this.s3.set(a - b, f.key === 'payload' ? 0.26 : 0.34, 0.36)));
            this.trains.setColorAt(k++, color);
          }
        }
      }
    }
    this.noise.el.hidden = !zapped;
    this.finish(this.trains, k);
    this.finish(this.splashes, ks);
    // messages coming back, dealt across the lanes like everything else
    let kd = 0;
    const lastD = lastAtOrBefore(run.dllps.length, (i) => run.dllps[i].sent, t);
    for (let i = lastD; i >= 0; i--) {
      const d = run.dllps[i];
      if (d.sent < t - lat) break;
      const at = XB - ((t - d.sent) / lat) * LX;
      for (let l = 0; l < this.lanes && kd < this.slabs.instanceMatrix.count; l++) {
        this.slabs.setMatrixAt(kd, this.m4.compose(this.v3.set(at, 0.2, this.laneZ(l) + PAIR / 2), this.qi, this.s3.set(DLLP_LEN, d.kind === 'credit' ? 0.3 : 0.24, 0.36)));
        this.slabs.setColorAt(kd++, this.colors[d.kind]);
      }
    }
    this.finish(this.slabs, kd);
    // the CPU's copies and credits, the device's buffer
    const sent = lastAtOrBefore(run.firstStart.length, (i) => run.firstStart[i], t) + 1;
    const freed = lastAtOrBefore(this.releasedAt.length, (i) => this.releasedAt[i], t) + 1;
    const back = lastAtOrBefore(this.creditBack.length, (i) => this.creditBack[i], t) + 1;
    const held = Math.max(0, sent - freed), credits = Math.max(0, p.credits - sent + back);
    const inside = Math.max(0, lastAtOrBefore(this.acceptedAt.length, (i) => this.acceptedAt[i], t) + 1 - (lastAtOrBefore(this.drainedAt.length, (i) => this.drainedAt[i], t) + 1));
    const shown = Math.min(held, 24);
    for (let i = 0; i < shown; i++) {
      this.shelf.setMatrixAt(i, this.m4.compose(this.v3.set(CPU_X - 4.4 + (i % 12) * 0.8, 0.55 + Math.floor(i / 12) * 0.62, 8.2), this.qi, this.s3.set(0.62, 0.55, 1.4)));
      this.shelf.setColorAt(i, this.colors.payload);
    }
    this.finish(this.shelf, shown);
    const coinsShown = Math.min(credits, 64);
    for (let i = 0; i < coinsShown; i++) {
      this.coins.setMatrixAt(i, this.m4.compose(this.v3.set(CPU_X - 4 + (i % 8) * 1.1, 0.28 + Math.floor(i / 8) * 0.16, -8.4), this.qi, this.s3.set(1, 1, 1)));
      this.coins.setColorAt(i, this.colors.credit);
    }
    this.finish(this.coins, coinsShown);
    const slotsShown = Math.min(p.credits, 32), cols = Math.min(slotsShown, 8), w = 8.6 / Math.max(cols, 1);
    let kf = 0;
    for (let i = 0; i < slotsShown; i++) {
      const pos = this.v3.set(DEV_X - 4.3 + w * ((i % 8) + 0.5), 0.45, 8.2 - 0.9 + Math.floor(i / 8) * 0.6);
      this.slots.setMatrixAt(i, this.m4.compose(pos, this.qi, this.s3.set(w * 0.82, 0.5, 0.5)));
      this.slots.setColorAt(i, this.colors.slot);
      if (i < inside) {
        this.fills.setMatrixAt(kf, this.m4.compose(pos.setY(0.5), this.qi, this.s3.set(w * 0.7, 0.44, 0.42)));
        this.fills.setColorAt(kf++, this.colors.fill);
      }
    }
    this.finish(this.slots, slotsShown);
    this.finish(this.fills, kf);
    this.setText(this.shelfLabel, `Replay buffer · ${held} kept until ACKed`);
    this.setText(this.coinLabel, `Packet slots · ${credits} of ${p.credits} left`);
    this.setText(this.slotLabel, `Receive buffer · ${inside} of ${p.credits} slots full`);
  }

  private finish(m: THREE.InstancedMesh, n: number): void {
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ building */

  /** Lane 0 is the one nearest the viewer. */
  private laneZ(l: number): number {
    return ((this.lanes - 1) / 2 - l) * GAP;
  }
  private instanced(mat: THREE.Material, n: number, shadow: boolean, geo: THREE.BufferGeometry = new THREE.BoxGeometry(1, 1, 1)): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, n);
    for (let i = 0; i < n; i++) m.setColorAt(i, this.colors.payload);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = shadow;
    this.scene.add(m);
    return m;
  }
  private chip(x: number, w: number, d: number, sub: number, lid: number, lidSize: number, z = 0): void {
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), new THREE.MeshStandardMaterial({ color: sub, roughness: 0.6 }));
    base.position.set(x, 0.25 + (x > 0 ? 0.6 : 0), z);
    base.castShadow = base.receiveShadow = true;
    this.scene.add(base);
    const top = new THREE.Mesh(new THREE.BoxGeometry(lidSize, 0.55, lidSize), new THREE.MeshStandardMaterial({ color: lid, roughness: 0.3, metalness: 0.85 }));
    top.position.set(x, 0.75 + (x > 0 ? 0.6 : 0), z);
    top.castShadow = true;
    this.scene.add(top);
  }
  /** A TLP on a stand behind the board, one block per field, widths to scale except a long payload. */
  private buildAnatomy(): void {
    const keys: FieldKey[] = ['framing', 'header', 'payload', 'lcrc'];
    for (const key of keys) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1.6, 1.6), new THREE.MeshStandardMaterial({ color: FIELD_COLORS[key], roughness: 0.45 }));
      m.castShadow = true;
      this.scene.add(m);
      this.anatomy[key] = m;
    }
    const stand = new THREE.Mesh(new THREE.BoxGeometry(24, 0.3, 2.4), new THREE.MeshStandardMaterial({ color: 0x59636f, roughness: 0.5, metalness: 0.4 }));
    stand.position.set(0, 3.25, -16);
    this.scene.add(stand);
    for (const [x, z] of [[-11, -16], [11, -16]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.4, 0.3), stand.material);
      leg.position.set(x, 1.6, z);
      this.scene.add(leg);
    }
    this.label('One packet (TLP), as it leaves the CPU →', new THREE.Vector3(0, 7.9, -16), 60);
    this.flitNote = this.label('Gen 6+: sequence number, CRC and FEC belong to the whole 256-byte flit', new THREE.Vector3(0, 2.3, -15), 60, 'note');
  }
  private updateAnatomy(payload: number, header: number, flit: boolean): void {
    const bytes: Record<FieldKey, number> = { framing: flit ? 0 : 4, header, payload, lcrc: flit ? 0 : 4 };
    const unit = 0.16, width = (k: FieldKey) => (k === 'payload' ? Math.min(payload, 72) : bytes[k]) * unit;
    const total = (['framing', 'header', 'payload', 'lcrc'] as FieldKey[]).reduce((a, k) => a + (bytes[k] ? width(k) + 0.15 : 0), 0);
    // the first byte on the wire leads, so it sits on the right, towards the device
    let right = total / 2;
    const text: Record<FieldKey, string> = {
      framing: 'start + sequence no. · 4 B<small>physical / data link</small>',
      header: `header · ${header} B<small>transaction layer: what, where</small>`,
      payload: `payload · ${payload.toLocaleString('en-US')} B<small>the data${payload > 72 ? ' (not to scale)' : ''}</small>`,
      lcrc: 'LCRC · 4 B<small>data link: error check</small>',
    };
    for (const key of ['framing', 'header', 'payload', 'lcrc'] as FieldKey[]) {
      const m = this.anatomy[key], on = bytes[key] > 0, w = width(key);
      m.visible = on;
      let l = this.anatomyLabels[key];
      if (!l) l = this.anatomyLabels[key] = this.label('', new THREE.Vector3(), 60, 'field');
      l.el.hidden = !on;
      if (!on) continue;
      m.scale.x = w;
      m.position.set(right - w / 2, 4.2, -16);
      this.move(l, right - w / 2, key === 'header' || key === 'lcrc' ? 6.7 : 5.6, -16);
      if (l.text !== text[key]) {
        l.text = text[key];
        l.el.innerHTML = text[key];
      }
      right -= w + 0.15;
    }
    this.flitNote.el.hidden = !flit;
  }
  private label(text: string, pos: THREE.Vector3, lod = 1e9, cls = ''): Label {
    const wrap = document.createElement('div'), el = document.createElement('div');
    el.className = `pcie-lbl ${cls}`.trim();
    el.textContent = text;
    wrap.append(el);
    const obj = new CSS2DObject(wrap);
    obj.position.copy(pos);
    this.scene.add(obj);
    const l: Label = { wrap, el, obj, world: pos.clone(), lod, far: false, text };
    this.labelList.push(l);
    return l;
  }
  private move(l: Label, x: number, y: number, z: number): void {
    l.world.set(x, y, z);
    l.obj.position.copy(l.world);
  }
  private setText(l: Label, text: string): void {
    if (l.text === text) return;
    l.text = text;
    l.el.textContent = text;
  }

  /** Camera for a view; the board view backs off until the CPU and the device both fit. */
  private pose(view: PcieView): { pos: THREE.Vector3; tgt: THREE.Vector3 } {
    const [p, t] = VIEWS[view], tgt = new THREE.Vector3(...t), pos = new THREE.Vector3(...p);
    if (view === 'lane') {
      const z0 = this.laneZ(0);
      tgt.z += z0;
      pos.z += z0;
      return { pos, tgt };
    }
    if (view !== 'board') return { pos, tgt };
    const w = this.host.clientWidth || 800, h = this.host.clientHeight || 600, tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max(20 / tan, 37 / (tan * (w / h)));
    return { pos: tgt.clone().addScaledVector(pos.sub(tgt).normalize(), dist), tgt };
  }
  private resize(): void {
    const w = this.host.clientWidth, hgt = this.host.clientHeight;
    if (!w || !hgt) return;
    this.renderer.setSize(w, hgt);
    this.labels.setSize(w, hgt);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    // the stage often settles after the scene is built: refit the view unless the user has taken the camera
    if (this.current && this.controls) {
      const { pos, tgt } = this.pose(this.current);
      if (this.tween) {
        this.tween.p1 = pos;
        this.tween.t1 = tgt;
      } else {
        this.camera.position.copy(pos);
        this.controls.target.copy(tgt);
      }
    }
  }
}
