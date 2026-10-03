/**
 * Two pictures of one CDR. The conveyor belt, for a first look: bits ride past a reader and an edge checker in slow
 * motion, and a timing knob moves the moment they look. The phase tunnel, for the long view: height is time (the last
 * WINDOW UI, newest at the top), the angle around the tunnel is the phase inside one UI. Data edges are dots, the
 * recovered edge and data samplers are stripes on the wall, the band around the data sampler is the eye keep-out. The
 * loop (samplers, bang-bang PD, loop filter, phase interpolator) stands in front of the tunnel. Client-only;
 * CdrLesson.svelte loads it on mount.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EYE_CLOSURE, NPI } from './model';
import { BELT_SPAN as SPAN, COLORS, WINDOW, type CdrView, type History } from './view';

const R = 8, H = 20, DY = H / WINDOW, STRIPES = WINDOW / 2, BAND_SEG = 14;
/** The belt stands BX along x from the tunnel and carries L units per UI. */
const BX = 52, L = 3;
const THEMES = {
  dark: { bg: 0x0a0d13, floorIn: '#141b26', floorOut: '#0a0d13', shadow: 0.5, grid: 0x243041, sky: 0xa9c1d6, ground: 0x10161d, hemi: 0.55, sun: 1.9, env: 0.45, glass: 0x9fb4c8, edgeSampler: 0xe9eef6, ring: 0xc6d2e0 },
  light: { bg: 0xf6f8fa, floorIn: '#ffffff', floorOut: '#f6f8fa', shadow: 0.2, grid: 0xc9d2de, sky: 0xffffff, ground: 0x9aa6b2, hemi: 0.9, sun: 2.2, env: 0.75, glass: 0x5f7185, edgeSampler: 0x55637a, ring: 0x3c4a5c },
};
const VIEWS: Record<CdrView, [[number, number, number], [number, number, number]]> = {
  belt: [[BX, 11, 40], [BX, 1.8, 0]],
  tunnel: [[-6, 17, 36], [0, 10, 0]],
  wheel: [[0.01, 44, 6], [0, H, 0]],
  loop: [[0, 26, 41], [0, 1, R + 9]],
};

interface Token { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number }

export class CdrScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly beltRoot = new THREE.Group();
  private readonly tunnelRoot = new THREE.Group();
  private readonly loopRoot = new THREE.Group();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 1, 2000);
  private readonly controls: OrbitControls;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly resizeObserver: ResizeObserver;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x9aa6b2, 0.9);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly floorCanvas = document.createElement('canvas');
  private readonly floorTex: THREE.CanvasTexture;
  private readonly shadowCatcher: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private readonly grid: THREE.GridHelper;
  private readonly glassMat = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.07, roughness: 0.2, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
  private readonly guideMat = new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.18 });
  private readonly ringMat = new THREE.MeshStandardMaterial({ color: 0xc6d2e0, roughness: 0.35, metalness: 0.6 });
  private readonly dots: THREE.InstancedMesh;
  private readonly edgeStripe: THREE.Mesh;
  private readonly dataStripe: THREE.Mesh;
  private readonly band: THREE.Mesh;
  private readonly needles: THREE.Group[] = [];
  private readonly piNeedle = new THREE.Group();
  private gauge!: THREE.Mesh;
  private readonly tokens: Token[] = [];
  private blocks!: THREE.InstancedMesh;
  private dataStamps!: THREE.InstancedMesh;
  private edgeStamps!: THREE.InstancedMesh;
  private readerBeam!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private edgeBeam!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private readonly edgeHead = new THREE.Group();
  private readonly edgeHeadMat = new THREE.MeshBasicMaterial({ color: COLORS.edgeSampler, toneMapped: false });
  private readonly knob = new THREE.Group();
  /** The bit each of the latest reads saw, floating over its mark. */
  private readonly reads: { o: CSS2DObject; el: HTMLDivElement; text: string }[] = [];
  private readonly cdrLabels: HTMLElement[] = [];
  private cdrOn = true;
  private readonly beltColors = { one: new THREE.Color(0x8fa3bf), zero: new THREE.Color(0x4a5566), ok: new THREE.Color(COLORS.dataSampler), neutral: new THREE.Color(0xc9d2de) };
  private readonly colors = { early: new THREE.Color(COLORS.early), late: new THREE.Color(COLORS.late), error: new THREE.Color(COLORS.error) };
  private readonly m4 = new THREE.Matrix4();
  private readonly v3 = new THREE.Vector3();
  private readonly qi = new THREE.Quaternion();
  private readonly s3 = new THREE.Vector3();
  private readonly labelList: { wrap: HTMLDivElement; world: THREE.Vector3; lod: number; group: 'belt' | 'tunnel' | 'loop' }[] = [];
  private readonly pd = new THREE.Vector3(-4, 1.6, R + 6);
  private readonly lf = new THREE.Vector3(4, 1.6, R + 6);
  private tween: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number; dur: number } | null = null;
  /** The view the camera was sent to, kept fitted to the stage until the user moves the camera. */
  private current: CdrView | null = 'belt';
  private activeView: CdrView = 'belt';
  private spin: boolean;
  private frame = 0;
  private lastUpdate = -1;
  private readonly reduced: boolean;

  constructor(host: HTMLElement, opts: { reducedMotion: boolean; onUserMove: () => void }) {
    this.host = host;
    this.reduced = opts.reducedMotion;
    this.spin = !opts.reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.className = 'cdr-canvas';
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'cdr-labels';
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(THEMES.light.bg);
    this.scene.fog = new THREE.Fog(THEMES.light.bg, 160, 520);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(this.hemi);
    this.sun.position.set(-40, 70, 45);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // wide enough for the tunnel at the origin and the belt at x = BX
    Object.assign(this.sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 240 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.floorCanvas.width = this.floorCanvas.height = 512;
    this.floorTex = new THREE.CanvasTexture(this.floorCanvas);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(600, 64), new THREE.MeshBasicMaterial({ map: this.floorTex, toneMapped: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.62;
    this.scene.add(floor);
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.4 }));
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.y = -0.6;
    this.shadowCatcher.receiveShadow = true;
    this.scene.add(this.shadowCatcher);
    this.grid = new THREE.GridHelper(200, 50, THEMES.dark.grid, THEMES.dark.grid);
    this.grid.position.y = -0.59;
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.5;
    gm.depthWrite = false;
    this.scene.add(this.grid);

    this.scene.add(this.beltRoot, this.tunnelRoot, this.loopRoot);
    this.tunnelRoot.visible = this.loopRoot.visible = false;

    // tunnel shell, time rings every 100 UI, phase guides at 0, ¼, ½, ¾ UI, and the rim where "now" is
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 96, 1, true), this.glassMat);
    shell.position.y = H / 2;
    this.tunnelRoot.add(shell);
    for (let k = 0; k <= WINDOW; k += 100) {
      const pts = Array.from({ length: 97 }, (_, i) => new THREE.Vector3(R * Math.cos((i / 96) * 2 * Math.PI), k * DY, R * Math.sin((i / 96) * 2 * Math.PI)));
      this.tunnelRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.guideMat));
    }
    for (let q = 0; q < 4; q++) {
      const a = (q / 4) * 2 * Math.PI;
      this.tunnelRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(R * Math.cos(a), 0, R * Math.sin(a)), new THREE.Vector3(R * Math.cos(a), H, R * Math.sin(a))]), this.guideMat));
    }
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.1, 10, 128), this.ringMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = H;
    this.tunnelRoot.add(rim);
    const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.08, 0.7), this.ringMat, 16);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI;
      this.m4.compose(new THREE.Vector3((R + 0.45) * Math.cos(a), H, (R + 0.45) * Math.sin(a)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a + Math.PI / 2), new THREE.Vector3(1, 1, i % 4 === 0 ? 1.6 : 1));
      ticks.setMatrixAt(i, this.m4);
    }
    this.tunnelRoot.add(ticks);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.8, R + 1.1, 0.6, 96), new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.5, metalness: 0.4 }));
    base.position.y = -0.3;
    base.receiveShadow = true;
    this.tunnelRoot.add(base);

    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 8, 6), new THREE.MeshBasicMaterial({ toneMapped: false }), WINDOW);
    for (let i = 0; i < WINDOW; i++) this.dots.setColorAt(i, this.colors.late);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.tunnelRoot.add(this.dots);
    this.edgeStripe = this.stripeMesh(COLORS.edgeSampler, 0.9);
    this.dataStripe = this.stripeMesh(COLORS.dataSampler, 0.95);
    this.band = new THREE.Mesh(this.gridGeometry(STRIPES, BAND_SEG), new THREE.MeshBasicMaterial({ color: COLORS.error, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    this.band.frustumCulled = false;
    this.tunnelRoot.add(this.band);
    for (const c of [COLORS.edgeSampler, COLORS.dataSampler]) {
      const g = new THREE.Group();
      const hand = new THREE.Mesh(new THREE.BoxGeometry(R - 0.4, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
      hand.position.x = (R - 0.4) / 2;
      g.add(hand);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
      tip.position.x = R;
      g.add(tip);
      g.position.y = H;
      this.tunnelRoot.add(g);
      this.needles.push(g);
    }
    this.buildLoop();
    this.buildBelt();
    this.buildLabels();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 8, maxDistance: 220, maxPolarAngle: Math.PI * 0.49, autoRotateSpeed: 0.45 });
    this.controls.addEventListener('start', () => {
      this.tween = null;
      this.current = null;
      opts.onUserMove();
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    const start = this.pose('belt');
    this.controls.target.copy(start.tgt);
    this.camera.position.copy(start.pos);
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
    this.glassMat.color.setHex(th.glass);
    this.guideMat.color.setHex(th.glass);
    this.ringMat.color.setHex(th.ring);
    ((this.edgeStripe.material as THREE.MeshBasicMaterial).color).setHex(th.edgeSampler);
    const hand = this.needles[0].children as THREE.Mesh[];
    for (const m of hand) (m.material as THREE.MeshBasicMaterial).color.setHex(th.edgeSampler);
    this.edgeHeadMat.color.setHex(th.edgeSampler);
    this.edgeBeam.material.color.setHex(th.edgeSampler);
  }
  setLabels(on: boolean): void {
    this.labels.domElement.hidden = !on;
  }
  setSpin(on: boolean): void {
    this.spin = on;
  }
  flyTo(view: CdrView, dur = 1.3): void {
    this.current = view;
    this.activeView = view;
    this.beltRoot.visible = view === 'belt';
    this.tunnelRoot.visible = view === 'tunnel' || view === 'wheel';
    this.loopRoot.visible = view === 'loop';
    const { pos, tgt } = this.pose(view);
    this.tween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: tgt, k: 0, dur: this.reduced ? 0.001 : dur };
  }
  /** Fit the whole teaching diagram, including room for its labels, at every aspect ratio. */
  private pose(view: CdrView): { pos: THREE.Vector3; tgt: THREE.Vector3 } {
    const [p, t] = VIEWS[view], tgt = new THREE.Vector3(...t);
    const bounds: Record<CdrView, [number[], number[]]> = {
      belt: [[BX - SPAN * L - 3, -1, -5], [BX + SPAN * L + 3, 9, 5]],
      tunnel: [[-12, -1, -12], [12, 24, 12]],
      wheel: [[-12, 0, -12], [12, 23, 12]],
      loop: [[-16, -1, 10], [17, 7, 23]],
    };
    const w = this.host.clientWidth || 800, h = this.host.clientHeight || 600;
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tanX = tanY * w / h;
    const direction = new THREE.Vector3(...p).sub(tgt).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const [lo, hi] = bounds[view];
    let distance = 8;
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
      const v = new THREE.Vector3(x, y, z).sub(tgt), depth = v.dot(direction);
      distance = Math.max(distance, depth + Math.abs(v.dot(right)) / (tanX * 0.8), depth + Math.abs(v.dot(up)) / (tanY * 0.78));
    }
    return { pos: tgt.clone().addScaledVector(direction, distance), tgt };
  }

  /** Draw the history at display time `now` (UI); `updates` counts loop updates so a token can leave the phase detector. */
  update(dt: number, h: History, now: number, integPpm: number, updates: number, lastVote: number): void {
    this.frame++;
    this.updateBelt(h, now);
    const at = (n: number) => ((n % WINDOW) + WINDOW) % WINDOW;
    // edge dots: one per transition in the window, coloured by the early/late decision or red when it closed the eye
    let k = 0;
    for (let n = Math.max(0, h.end - WINDOW); n < h.end; n++) {
      const i = at(n);
      if (!h.transition[i]) continue;
      const a = 2 * Math.PI * h.edge[i], y = H - (h.end - 1 - n) * DY;
      this.m4.compose(this.v3.set(R * Math.cos(a), y, R * Math.sin(a)), this.qi, this.s3.setScalar(h.error[i] ? 1.6 : 1));
      this.dots.setMatrixAt(k, this.m4);
      this.dots.setColorAt(k, h.error[i] ? this.colors.error : h.decision[i] > 0 ? this.colors.early : this.colors.late);
      k++;
    }
    this.dots.count = k;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
    // stripes: edge sampler at θ, data sampler at θ + ½, keep-out ±EYE_CLOSURE around the data sampler
    const thetaAt = (s: number) => {
      const n = Math.max(0, h.end - 1 - (STRIPES - 1 - s) * 2);
      return { theta: h.theta[at(n)], y: H - (h.end - 1 - n) * DY };
    };
    this.fillStripe(this.edgeStripe.geometry, thetaAt, 0, 0.005, R - 0.03);
    this.fillStripe(this.dataStripe.geometry, thetaAt, 0.5, 0.005, R - 0.03);
    this.fillStripe(this.band.geometry, thetaAt, 0.5, EYE_CLOSURE, R - 0.06, BAND_SEG);
    const theta = h.end > 0 ? h.theta[at(h.end - 1)] : 0;
    this.needles[0].rotation.y = -2 * Math.PI * theta;
    this.needles[1].rotation.y = -2 * Math.PI * (theta + 0.5);
    this.piNeedle.rotation.y = -2 * Math.PI * theta;
    const g = Math.max(-1, Math.min(1, integPpm / 1000));
    this.gauge.scale.y = Math.max(0.02, Math.abs(g)) * 2.4;
    this.gauge.position.y = 1.4 + (g >= 0 ? 1 : -1) * this.gauge.scale.y * 0.5;
    this.updateTokens(dt, updates, lastVote);
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
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    if (this.frame % 4 === 0) this.layoutLabels();
  }

  private layoutLabels(): void {
    const box = this.host.getBoundingClientRect();
    const occupied: DOMRect[] = [];
    for (const l of this.labelList) {
      const relevant = this.activeView === 'belt' ? l.group === 'belt'
        : this.activeView === 'loop' ? l.group === 'loop'
        : this.activeView === 'wheel' ? l.group === 'tunnel'
        : l.group === 'tunnel';
      const r = l.wrap.getBoundingClientRect();
      const inside = r.left >= box.left + 6 && r.right <= box.right - 6 && r.top >= box.top + 66 && r.bottom <= box.bottom - 8;
      const overlap = occupied.some((o) => r.left < o.right + 5 && r.right > o.left - 5 && r.top < o.bottom + 4 && r.bottom > o.top - 4);
      const show = relevant && inside && !overlap && this.camera.position.distanceTo(l.world) <= l.lod;
      l.wrap.style.visibility = show ? 'visible' : 'hidden';
      if (show) occupied.push(r);
    }
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

  /** A strip of (STRIPES × (seg + 1)) vertices wound around the tunnel. */
  private gridGeometry(rows: number, seg: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry(), idx: number[] = [];
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows * (seg + 1) * 3), 3));
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < seg; c++) {
      const a = r * (seg + 1) + c, b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    g.setIndex(idx);
    return g;
  }
  private stripeMesh(color: string, opacity: number): THREE.Mesh {
    const m = new THREE.Mesh(this.gridGeometry(STRIPES, 1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, toneMapped: false }));
    m.frustumCulled = false;
    m.renderOrder = 2;
    this.tunnelRoot.add(m);
    return m;
  }
  private fillStripe(geo: THREE.BufferGeometry, at: (s: number) => { theta: number; y: number }, offset: number, halfWidth: number, radius: number, seg = 1): void {
    const attr = geo.getAttribute('position') as THREE.BufferAttribute, p = attr.array as Float32Array;
    for (let s = 0; s < STRIPES; s++) {
      const { theta, y } = at(s);
      for (let c = 0; c <= seg; c++) {
        const a = 2 * Math.PI * (theta + offset - halfWidth + (2 * halfWidth * c) / seg), o = (s * (seg + 1) + c) * 3;
        p[o] = radius * Math.cos(a);
        p[o + 1] = y;
        p[o + 2] = radius * Math.sin(a);
      }
    }
    attr.needsUpdate = true;
  }

  private box(x: number, z: number, w: number, d: number, h: number, color: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 }));
    m.position.set(x, h / 2, z);
    m.castShadow = m.receiveShadow = true;
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0x06090d, transparent: true, opacity: 0.35 })));
    this.loopRoot.add(m);
    return m;
  }
  private buildLoop(): void {
    const z = R + 6;
    this.box(-12, z, 5, 3.2, 1.4, 0x9a5b52);
    this.box(-4, z, 5, 3.2, 1.4, 0x4c6a8f);
    this.box(4, z, 5, 3.2, 1.0, 0x6a5aa8);
    this.box(12, z, 5, 3.2, 1.2, 0x2f8f83);
    this.box(12, z + 6.5, 4, 2.6, 1.0, 0x6a5aa8);
    const flow = new THREE.MeshStandardMaterial({ color: 0xb7c4d4, roughness: 0.4, metalness: 0.5 });
    const tube = (pts: THREE.Vector3[]) => {
      const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05), 48, 0.1, 8, false), flow);
      m.castShadow = true;
      this.loopRoot.add(m);
    };
    tube([new THREE.Vector3(-9.5, 0.8, z), new THREE.Vector3(-6.5, 0.8, z)]);
    tube([new THREE.Vector3(-1.5, 0.8, z), new THREE.Vector3(1.5, 0.8, z)]);
    tube([new THREE.Vector3(6.5, 0.8, z), new THREE.Vector3(9.5, 0.8, z)]);
    tube([new THREE.Vector3(12, 0.6, z + 5.2), new THREE.Vector3(12, 0.6, z + 1.6)]);
    tube([new THREE.Vector3(12, 0.6, z - 1.6), new THREE.Vector3(12, 0.6, z - 3.2), new THREE.Vector3(-12, 0.6, z - 3.2), new THREE.Vector3(-12, 0.6, z - 1.6)]);
    // integrator gauge on the loop filter and the phase-interpolator dial
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, 4.8, 0.9), new THREE.MeshStandardMaterial({ color: 0x1b2230, transparent: true, opacity: 0.35 }));
    post.position.set(5.6, 1.4, z);
    this.loopRoot.add(post);
    this.gauge = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1, 0.7), new THREE.MeshStandardMaterial({ color: 0xa28bff, emissive: 0x2d1f73, roughness: 0.4 }));
    this.gauge.position.set(5.6, 1.4, z);
    this.loopRoot.add(this.gauge);
    const dial = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.08, 8, 64), this.ringMat);
    dial.rotation.x = Math.PI / 2;
    dial.position.set(12, 1.35, z);
    this.loopRoot.add(dial);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.12), new THREE.MeshBasicMaterial({ color: COLORS.dataSampler, toneMapped: false }));
    hand.position.x = 0.7;
    this.piNeedle.add(hand);
    this.piNeedle.position.set(12, 1.4, z);
    this.loopRoot.add(this.piNeedle);
  }
  /* ------------------------------------------------------------------ the conveyor belt */

  private buildBelt(): void {
    const len = 2 * SPAN * L + 5;
    const belt = new THREE.Mesh(new THREE.BoxGeometry(len, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.85 }));
    belt.position.set(BX, -0.25, 0);
    belt.receiveShadow = true;
    this.beltRoot.add(belt);
    for (const sx of [-1, 1]) {
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 6.4, 24), this.ringMat);
      roller.rotation.x = Math.PI / 2;
      roller.position.set(BX + sx * (len / 2), -0.3, 0);
      this.beltRoot.add(roller);
    }
    this.blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }), 2 * SPAN + 8);
    this.dataStamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.34, 16, 12), new THREE.MeshBasicMaterial({ toneMapped: false }), 2 * SPAN + 8);
    this.edgeStamps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.9 }), 2 * SPAN + 8);
    for (const m of [this.blocks, this.dataStamps, this.edgeStamps]) {
      for (let i = 0; i < m.count; i++) m.setColorAt(i, this.beltColors.neutral);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = m === this.blocks;
      this.beltRoot.add(m);
    }
    // the reading station: an arm from behind the belt, so nothing stands between the camera and the heads
    const metal = new THREE.MeshStandardMaterial({ color: 0x6b7788, roughness: 0.4, metalness: 0.6 });
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5.7, 0.5), metal);
    post.position.set(BX, 2.85, -3.8);
    post.castShadow = true;
    this.beltRoot.add(post);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 5.9), metal);
    bar.position.set(BX, 5.4, -1.1);
    bar.castShadow = true;
    this.beltRoot.add(bar);
    const head = (group: THREE.Group, z: number, mat: THREE.MeshBasicMaterial) => {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 20), mat);
      cone.rotation.x = Math.PI;
      cone.position.set(BX, 4.6, z);
      group.add(cone);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 4.1, 8), new THREE.MeshBasicMaterial({ color: mat.color, transparent: true, opacity: 0, toneMapped: false }));
      beam.position.set(BX, 2.05, z);
      group.add(beam);
      this.beltRoot.add(group);
      return beam;
    };
    this.readerBeam = head(new THREE.Group(), -1.2, new THREE.MeshBasicMaterial({ color: COLORS.dataSampler, toneMapped: false }));
    this.edgeBeam = head(this.edgeHead, 1.2, this.edgeHeadMat);
    const dial = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.08, 8, 48), this.ringMat);
    dial.rotation.x = Math.PI / 2;
    this.knob.add(dial);
    // 32 notches: in the tour one verdict turns the knob by one of them
    const notches = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.06, 0.06), this.ringMat, 32);
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * 2 * Math.PI;
      notches.setMatrixAt(i, this.m4.compose(new THREE.Vector3(1.05 * Math.cos(a), 0, 1.05 * Math.sin(a)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a), new THREE.Vector3(1, 1, 1)));
    }
    this.knob.add(notches);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.1, 0.14), new THREE.MeshBasicMaterial({ color: COLORS.dataSampler, toneMapped: false }));
    hand.position.x = 0.42;
    this.knob.add(hand);
    this.knob.position.set(BX, 5.8, 0);
    this.beltRoot.add(this.knob);
    for (let i = 0; i < SPAN + 3; i++) {
      const el = document.createElement('div'), o = new CSS2DObject(el);
      el.className = 'cdr-bit';
      o.visible = false;
      this.beltRoot.add(o);
      this.reads.push({ o, el, text: '' });
    }
  }

  /** Show or hide the parts that only a CDR has: the edge checker, its marks and the timing knob. */
  setCdr(on: boolean): void {
    if (on === this.cdrOn) return;
    this.cdrOn = on;
    this.edgeHead.visible = this.edgeStamps.visible = this.knob.visible = on;
    for (const l of this.cdrLabels) l.hidden = !on;
  }

  /**
   * Bits ride the belt past the reader at display time `now` (UI). Block m covers [m + edge, m + 1 + next edge); the
   * reader of UI n fires at n + θ + ½ and the edge checker at n + θ, each leaving a mark that rides on with the belt.
   */
  private updateBelt(h: History, now: number): void {
    const at = (n: number) => ((n % WINDOW) + WINDOW) % WINDOW;
    const oldest = Math.max(1, h.end - WINDOW + 1), newest = h.end - 1, last = h.end + h.ahead - 2;
    const hide = () => {
      this.blocks.count = this.dataStamps.count = this.edgeStamps.count = 0;
      for (const r of this.reads) r.o.visible = false;
    };
    if (newest - oldest < 2 * SPAN + 6 || !Number.isFinite(now)) return void hide();
    // bits up to `newest` have been through the loop; the ones after it are still on their way
    const bit = (m: number) => (m < h.end ? h.bit[at(m)] : h.nextBit[m - h.end]);
    const start = (m: number) => m + (m < h.end ? h.edge[at(m)] : h.nextEdge[m - h.end]);
    const clamp = (m: number) => Math.min(last, Math.max(oldest, m));
    const x = (tau: number) => (now - tau) * L;
    /** The block that holds time tau; the edge phase moves slowly, so two fixed-point steps land next to it. */
    const blockAt = (tau: number) => {
      let m = clamp(Math.floor(tau));
      m = clamp(Math.floor(tau - (start(m) - m)));
      m = clamp(Math.floor(tau - (start(m) - m)));
      for (let i = 0; i < 8 && m > oldest && start(m) > tau; i++) m--;
      for (let i = 0; i < 8 && m < last && start(m + 1) <= tau; i++) m++;
      return m;
    };
    const centre = blockAt(now);
    if (start(centre) > now + 1 || start(centre + 1) < now - 1) return void hide();
    let k = 0;
    for (let m = Math.max(oldest, centre - SPAN - 2); m <= Math.min(last, centre + SPAN + 2); m++) {
      const x0 = Math.max(x(start(m + 1)), -SPAN * L), x1 = Math.min(x(start(m)), SPAN * L), w = x1 - x0 - 0.1;
      if (w <= 0.05) continue;
      const one = bit(m) === 1, hgt = one ? 1.9 : 0.45;
      this.blocks.setMatrixAt(k, this.m4.compose(this.v3.set(BX + (x0 + x1) / 2, hgt / 2, 0), this.qi, this.s3.set(w, hgt, 3.6)));
      this.blocks.setColorAt(k++, one ? this.beltColors.one : this.beltColors.zero);
    }
    this.blocks.count = k;
    // the newest UI whose reader has fired by now
    const fired = (n: number) => n + h.theta[at(n)] + 0.5 <= now;
    let read = Math.min(newest, Math.max(oldest, Math.floor(now - 0.5 - h.theta[at(newest)])));
    for (let i = 0; i < 8 && read < newest && fired(read + 1); i++) read++;
    for (let i = 0; i < 8 && read > oldest && !fired(read); i++) read--;
    let kd = 0, ke = 0, lastData = -Infinity, lastEdge = -Infinity, theta = h.theta[at(read)];
    for (let n = Math.max(oldest + 1, read - SPAN - 2); n <= Math.min(newest, read + 1); n++) {
      const th = h.theta[at(n)], td = n + th + 0.5, te = n + th;
      if (td <= now && x(td) <= SPAN * L) {
        const m = blockAt(td), left = td - start(m), right = start(m + 1) - td;
        const bad = (bit(m) !== bit(m - 1) && left < EYE_CLOSURE) || (bit(m + 1) !== bit(m) && right < EYE_CLOSURE);
        const top = (bit(m) ? 1.9 : 0.45) + 0.34;
        this.dataStamps.setMatrixAt(kd, this.m4.compose(this.v3.set(BX + x(td), top, -1.2), this.qi, this.s3.setScalar(1)));
        this.dataStamps.setColorAt(kd, bad ? this.colors.error : this.beltColors.ok);
        const r = this.reads[kd++];
        if (r) {
          const text = `${bit(m)}${bad ? '?' : ''}`;
          if (text !== r.text) {
            r.el.textContent = r.text = text;
            r.el.classList.toggle('bad', bad);
          }
          r.o.position.set(BX + x(td), top + 0.9, -1.2);
          r.o.visible = true;
        }
        if (td > lastData) {
          lastData = td;
          theta = th;
        }
      }
      if (this.cdrOn && te <= now && x(te) <= SPAN * L) {
        // the colour is the verdict the loop acted on for this UI
        const d = h.decision[at(n)];
        this.edgeStamps.setMatrixAt(ke, this.m4.compose(this.v3.set(BX + x(te), 1.45, 1.2), this.qi, this.s3.set(0.12, 2.9, 2.2)));
        this.edgeStamps.setColorAt(ke++, d > 0 ? this.colors.early : d < 0 ? this.colors.late : this.beltColors.neutral);
        lastEdge = Math.max(lastEdge, te);
      }
    }
    this.dataStamps.count = kd;
    this.edgeStamps.count = ke;
    for (let i = kd; i < this.reads.length; i++) this.reads[i].o.visible = false;
    for (const m of [this.blocks, this.dataStamps, this.edgeStamps]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.readerBeam.material.opacity = Math.exp(-(now - lastData) / 0.12);
    this.edgeBeam.material.opacity = Math.exp(-(now - lastEdge) / 0.12);
    this.knob.rotation.y = -2 * Math.PI * theta;
  }

  private updateTokens(dt: number, updates: number, vote: number): void {
    if (this.cdrOn && updates !== this.lastUpdate && vote !== 0 && this.tokens.length < 6) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: vote > 0 ? COLORS.early : COLORS.late, toneMapped: false }));
      this.loopRoot.add(m);
      this.tokens.push({ mesh: m, from: this.pd.clone(), to: this.lf.clone(), t: 0 });
    }
    this.lastUpdate = updates;
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const tk = this.tokens[i];
      tk.t += dt / 0.6;
      tk.mesh.position.lerpVectors(tk.from, tk.to, Math.min(1, tk.t)).setY(1.6 + 0.8 * Math.sin(Math.PI * Math.min(1, tk.t)));
      if (tk.t >= 1) {
        this.loopRoot.remove(tk.mesh);
        tk.mesh.geometry.dispose();
        (tk.mesh.material as THREE.Material).dispose();
        this.tokens.splice(i, 1);
      }
    }
  }
  private label(text: string, pos: THREE.Vector3, lod = 1e9, cls = ''): HTMLElement {
    const wrap = document.createElement('div'), el = document.createElement('div');
    el.className = `cdr-lbl ${cls}`.trim();
    el.textContent = text;
    wrap.append(el);
    const o = new CSS2DObject(wrap);
    o.position.copy(pos);
    const group = pos.x > BX / 2 ? 'belt' : pos.z >= R + 5 ? 'loop' : 'tunnel';
    (group === 'belt' ? this.beltRoot : group === 'loop' ? this.loopRoot : this.tunnelRoot).add(o);
    this.labelList.push({ wrap, world: pos.clone(), lod, group });
    return el;
  }
  private buildLabels(): void {
    const z = R + 6;
    this.label('bits arrive →', new THREE.Vector3(BX - 8.5, 3.4, 0), 160);
    this.label('tall = 1 · short = 0', new THREE.Vector3(BX + 8.5, 3.4, 0), 160);
    this.label('Reader', new THREE.Vector3(BX - 2.2, 5.6, -1.2), 160, 'reader');
    this.cdrLabels.push(this.label('Edge checker', new THREE.Vector3(BX + 2.8, 4.6, 1.2), 160, 'checker'));
    this.cdrLabels.push(this.label('Timing knob', new THREE.Vector3(BX + 2.6, 6.6, 0), 160));
    this.label('now', new THREE.Vector3(0, H + 1.3, 0));
    this.label('0', new THREE.Vector3(R + 1.8, H, 0), 1e9, 'tick');
    this.label('0.25 UI', new THREE.Vector3(0, H, R + 1.8), 1e9, 'tick');
    this.label('0.5 UI', new THREE.Vector3(-R - 1.8, H, 0), 1e9, 'tick');
    this.label('0.75 UI', new THREE.Vector3(0, H, -R - 1.8), 1e9, 'tick');
    this.label(`time ↑ · last ${WINDOW} UI`, new THREE.Vector3(-R - 1.2, H * 0.45, R * 0.3));
    this.label('Samplers', new THREE.Vector3(-12, 2.6, z), 200);
    this.label('Early / late', new THREE.Vector3(-4, 2.6, z), 200);
    this.label('P + I filter', new THREE.Vector3(4, 4.2, z), 200);
    this.label(`${NPI}-step PI`, new THREE.Vector3(12, 4.4, z), 200);
    this.label('8-phase PLL', new THREE.Vector3(12, 2.2, z + 6.5), 200);
  }
}
