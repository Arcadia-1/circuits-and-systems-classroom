/**
 * The 3-D link: two flip-chip packages on a board, their die floorplans, the differential pair and the travelling
 * waveform. Client-only; SerdesLink.svelte loads it on mount and drives update() once per animation frame.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CATEGORY, ERROR_COLOR, SYMBOL_COLORS, type BlockId, type Category } from './blocks';
import { NF, NFLY, NFPRE, OS, PLEN, PS, T0 } from './model';
import { MASK, type Receiver, type SymbolStream } from './streams';

export type ViewName = 'overview' | 'tx' | 'channel' | 'rx' | 'adc';

const THEMES = {
  dark: { bg: 0x0a0d13, floorIn: '#141b26', floorOut: '#0a0d13', shadow: 0.55, grid: 0x243041, gridOp: 0.5, sky: 0xa9c1d6, ground: 0x10161d, hemi: 0.55, sun: 2.0, env: 0.45, exp: 1.05, wave: 0x66aaff, edge: 0xc6ddff },
  light: { bg: 0xf6f8fa, floorIn: '#ffffff', floorOut: '#f6f8fa', shadow: 0.22, grid: 0xc9d2de, gridOp: 0.6, sky: 0xffffff, ground: 0x9aa6b2, hemi: 0.9, sun: 2.3, env: 0.75, exp: 1.0, wave: 0x246dc1, edge: 0x123d73 },
};
const VIEWS: Record<Exclude<ViewName, 'overview'>, [[number, number, number], [number, number, number]]> = {
  tx: [[-62, 34, 40], [-60, 4.5, -1]],
  channel: [[8, 40, 82], [0, 6, 0]],
  rx: [[62, 34, 40], [60, 4.5, -1]],
  adc: [[62.5, 17, 12], [62, 4.6, -5.5]],
};

const PKG_X = 62, PKG_W = 52, PKG_H = 2.6, SUB_BOT = 0.8, SUB_TOP = SUB_BOT + PKG_H;
const DIE_W = 34, DIE_D = 28, DIE_H = 0.8, DIE_BOT = SUB_TOP + 0.3, DIE_TOP = DIE_BOT + DIE_H;
const PCB_W = 220, PCB_D = 120, PCB_T = 2, FLOOR_Y = -9;
const CH_XZ: [number, number][] = [[-46, -6], [-36, -6], [-27, -6], [-17, 1], [-6, 6.5], [6, 6.5], [17, 1], [27, -6], [36, -6], [46, -6]];
const CPU = 12, NPTS = NFLY * CPU + 1, CURT_Y = 12, CURT_K = 5.2;
const DUR = [24, 12, 6, 3, 1.5], TX_CUM = [0, 24, 36, 42, 45], RX_CUM = [22.5, 10.5, 4.5, 1.5, 0];

interface Tree { nodes: THREE.Vector3[][]; sparks: THREE.InstancedMesh }
interface Flow { path: THREE.CurvePath<THREE.Vector3>; mesh: THREE.InstancedMesh; count: number; len: number }
interface Label { wrap: HTMLDivElement; text: HTMLSpanElement; lod: number; world: THREE.Vector3; far: boolean }
interface Block { mats: Set<THREE.MeshStandardMaterial>; meshes: THREE.Object3D[]; category: Category }

export interface SceneOptions {
  reducedMotion: boolean;
  onHover: (id: BlockId | null, x: number, y: number) => void;
  onPick: (id: BlockId | null) => void;
  onUserMove: () => void;
}

export class SerdesScene {
  private readonly host: HTMLElement;
  private readonly opts: SceneOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 1, 3000);
  private readonly controls: OrbitControls;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly resizeObserver: ResizeObserver;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x9aa6b2, 0.9);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.3);
  private readonly floorCanvas = document.createElement('canvas');
  private readonly floorTex: THREE.CanvasTexture;
  private readonly shadowCatcher: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private readonly grid: THREE.GridHelper;
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly spark = new THREE.IcosahedronGeometry(0.21, 0);
  private readonly m4 = new THREE.Matrix4();
  private readonly q4 = new THREE.Quaternion();
  private readonly qi = new THREE.Quaternion();
  private readonly v3 = new THREE.Vector3();
  private readonly s3 = new THREE.Vector3();
  private readonly col = new THREE.Color();
  private readonly symbolColors = SYMBOL_COLORS.map((c) => new THREE.Color(c));
  private readonly errorColor = new THREE.Color(ERROR_COLOR);
  private readonly glowColor = new THREE.Color(0x66aaff);
  private readonly blocks = new Map<BlockId, Block>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly labelList: Label[] = [];
  private readonly chPts: THREE.Vector3[];
  private readonly chTan: THREE.Vector3[];
  private readonly capIndex: number;
  private readonly mats = this.makeMaterials();
  private readonly tex = this.makeTextures();
  private dieA!: THREE.Group;
  private dieB!: THREE.Group;
  private txTree!: Tree;
  private rxTree!: Tree;
  private segments: THREE.Mesh[] = [];
  private txPillars: THREE.Mesh[] = [];
  private rxPillars: THREE.Mesh[] = [];
  private tiles!: THREE.InstancedMesh;
  private bars!: THREE.InstancedMesh;
  private thBoxes!: THREE.InstancedMesh;
  private flows: Flow[] = [];
  private inductors: THREE.MeshStandardMaterial[] = [];
  private needle!: THREE.Group;
  private glows: THREE.BufferGeometry[] = [];
  private curtainGeo!: THREE.BufferGeometry;
  private curtainMat!: THREE.ShaderMaterial;
  private edgeGeo!: THREE.BufferGeometry;
  private edgeMat!: THREE.LineBasicMaterial;
  private baseMat!: THREE.LineBasicMaterial;
  private padLabel!: Label;
  private readonly curtainV = new Float32Array(NPTS);
  private readonly tileV = new Float32Array(64);
  private readonly tileT = new Float32Array(64).fill(-1e9);
  private readonly thT = new Float32Array(8).fill(-1e9);
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private hovered: BlockId | null = null;
  private pointer: [number, number] | null = null;
  private down: [number, number, number] | null = null;
  private dragging = false;
  private tween: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number; dur: number } | null = null;
  private spin: boolean;
  private frame = 0;

  constructor(host: HTMLElement, opts: SceneOptions) {
    this.host = host;
    this.opts = opts;
    this.spin = !opts.reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.className = 'serdes-canvas';
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'serdes-labels';
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(THEMES.light.bg);
    this.scene.fog = new THREE.Fog(THEMES.light.bg, 420, 1300);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(this.hemi);
    this.sun.position.set(-70, 170, 95);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -135, right: 135, top: 105, bottom: -105, near: 40, far: 460 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    const rim = new THREE.DirectionalLight(0xa9d4ff, 0.55);
    rim.position.set(130, 70, -150);
    this.scene.add(rim);

    this.floorCanvas.width = this.floorCanvas.height = 512;
    this.floorTex = new THREE.CanvasTexture(this.floorCanvas);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1400, 72), new THREE.MeshBasicMaterial({ map: this.floorTex, toneMapped: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y - 0.05;
    this.scene.add(floor);
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(700, 480), new THREE.ShadowMaterial({ opacity: 0.4 }));
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.y = FLOOR_Y;
    this.shadowCatcher.receiveShadow = true;
    this.scene.add(this.shadowCatcher);
    this.grid = new THREE.GridHelper(640, 64, THEMES.dark.grid, THEMES.dark.grid);
    this.grid.position.y = FLOOR_Y + 0.02;
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.depthWrite = false;
    this.scene.add(this.grid);

    const curve = new THREE.CatmullRomCurve3(CH_XZ.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
    this.chPts = curve.getSpacedPoints(NPTS - 1);
    this.chTan = this.chPts.map((_, i) => curve.getTangentAt(i / (NPTS - 1)));
    this.capIndex = this.chPts.findIndex((p) => p.x > 30);

    this.buildBoard();
    this.buildPackages();
    this.buildTransmitter();
    this.buildReceiver();
    this.buildChannel();
    this.buildLabels();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 8, maxDistance: 780, maxPolarAngle: Math.PI * 0.485, autoRotateSpeed: 0.5 });
    this.controls.addEventListener('start', this.onStart);
    this.controls.addEventListener('end', this.onEnd);
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    const pose = this.overviewPose();
    this.controls.target.copy(pose.tgt);
    if (opts.reducedMotion) this.camera.position.copy(pose.pos);
    else {
      this.camera.position.copy(pose.pos).add(new THREE.Vector3(-150, 120, 170));
      this.fly(pose, 2.8);
    }
  }

  /* ------------------------------------------------------------------ public API */

  setTheme(light: boolean): void {
    const th = light ? THEMES.light : THEMES.dark;
    (this.scene.background as THREE.Color).setHex(th.bg);
    (this.scene.fog as THREE.Fog).color.setHex(th.bg);
    const g = this.floorCanvas.getContext('2d');
    if (g) {
      const r = g.createRadialGradient(256, 256, 20, 256, 256, 256);
      r.addColorStop(0, th.floorIn);
      r.addColorStop(0.35, th.floorIn);
      r.addColorStop(1, th.floorOut);
      g.fillStyle = r;
      g.fillRect(0, 0, 512, 512);
      this.floorTex.needsUpdate = true;
    }
    this.shadowCatcher.material.opacity = th.shadow;
    const ca = this.grid.geometry.getAttribute('color') as THREE.BufferAttribute;
    this.col.setHex(th.grid);
    for (let i = 0; i < ca.count; i++) ca.setXYZ(i, this.col.r, this.col.g, this.col.b);
    ca.needsUpdate = true;
    (this.grid.material as THREE.LineBasicMaterial).opacity = th.gridOp;
    this.hemi.color.setHex(th.sky);
    this.hemi.groundColor.setHex(th.ground);
    this.hemi.intensity = th.hemi;
    this.sun.intensity = th.sun;
    this.scene.environmentIntensity = th.env;
    this.renderer.toneMappingExposure = th.exp;
    (this.curtainMat.uniforms.uColor.value as THREE.Color).setHex(th.wave);
    this.edgeMat.color.setHex(th.edge);
    this.baseMat.color.setHex(th.grid);
  }
  setLabels(on: boolean): void {
    this.labels.domElement.hidden = !on;
  }
  setSpin(on: boolean): void {
    this.spin = on;
  }
  setPadLoss(lossDb: number): void {
    this.padLabel.text.textContent = `RX pad · −${lossDb.toFixed(1)} dB at 28 GHz`;
  }
  flyTo(view: ViewName): void {
    if (view === 'overview') this.fly(this.overviewPose());
    else {
      const [p, t] = VIEWS[view];
      this.fly({ pos: new THREE.Vector3(...p), tgt: new THREE.Vector3(...t) });
    }
  }
  focus(id: BlockId): void {
    const b = this.blocks.get(id);
    if (!b) return;
    const box = new THREE.Box3();
    for (const m of b.meshes) box.expandByObject(m);
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    const dist = Math.min(140, Math.max(14, size * 1.3 + 9));
    this.fly({ pos: c.clone().addScaledVector(new THREE.Vector3(0.1, 0.8, 0.6).normalize(), dist), tgt: c });
  }
  hasBlock(id: BlockId): boolean {
    return this.blocks.has(id);
  }
  /** Record an ADC sample for the tile of symbol n. */
  sampled(n: number, v: number, tSample: number): void {
    this.tileV[n & 63] = v;
    this.tileT[n & 63] = n + tSample;
    this.thT[n & 7] = n + tSample;
  }

  update(dt: number, t: number, clockT: number, rx: Receiver, stream: SymbolStream, line: Float32Array[], txFfe: boolean): void {
    this.frame++;
    this.updateTx(t, stream);
    this.updateRx(t, rx, stream);
    this.updateCurtain(t, stream, line);
    this.updateTiles(t, rx);
    this.updatePillars(rx, txFfe);
    for (const f of this.flows) this.updateFlow(f, clockT);
    for (const m of this.inductors) m.emissiveIntensity = 0.75 + 0.5 * Math.sin(clockT * 3.1);
    this.needle.rotation.y = -2 * Math.PI * rx.a.phaseUi + 0.5 + 0.07 * Math.sin(clockT * 1.7) + 0.03 * Math.sin(clockT * 5.3);
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
    const tg = this.controls.target;
    tg.set(Math.min(130, Math.max(-130, tg.x)), Math.min(30, Math.max(-2, tg.y)), Math.min(90, Math.max(-90, tg.z)));
    if (this.pointer && !this.dragging && this.frame % 2 === 0) this.hoverAt(this.pointer[0], this.pointer[1]);
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
    this.controls.removeEventListener('start', this.onStart);
    this.controls.removeEventListener('end', this.onEnd);
    this.controls.dispose();
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
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
    el.remove();
    this.labels.domElement.remove();
  }

  /* ------------------------------------------------------------------ camera and picking */

  private overviewPose(): { pos: THREE.Vector3; tgt: THREE.Vector3 } {
    const w = this.host.clientWidth || 800, h = this.host.clientHeight || 600, tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    if (w / h < 0.9) {
      const dist = Math.min(780, Math.max(150, Math.max((92 * 0.83) / tan, 34 / (tan * (w / h)))));
      const tgt = new THREE.Vector3(0, 3, 0);
      return { pos: tgt.clone().addScaledVector(new THREE.Vector3(0.56, 0.83, 0).normalize(), dist), tgt };
    }
    const dist = Math.min(780, Math.max(150, 96 / (tan * (w / h))));
    const tgt = new THREE.Vector3(0, 3, 2);
    return { pos: tgt.clone().addScaledVector(new THREE.Vector3(0, 0.6, 0.8).normalize(), dist), tgt };
  }
  private fly(pose: { pos: THREE.Vector3; tgt: THREE.Vector3 }, dur = 1.3): void {
    this.tween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pose.pos, t1: pose.tgt, k: 0, dur: this.opts.reducedMotion ? 0.001 : dur };
  }
  private resize(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  private pick(x: number, y: number): BlockId | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    return hit ? (hit.object.userData.block as BlockId) : null;
  }
  private hoverAt(x: number, y: number): void {
    let id = this.pick(x, y);
    if (id === 'pcb') id = null;
    if (id !== this.hovered) {
      if (this.hovered) for (const m of this.blocks.get(this.hovered)?.mats ?? []) m.emissive.setHex(m.userData.e0 ?? 0);
      this.hovered = id;
      if (id) {
        const b = this.blocks.get(id);
        for (const m of b?.mats ?? []) {
          if (m.userData.e0 === undefined) m.userData.e0 = m.emissive.getHex();
          m.emissive.setHex(CATEGORY[b!.category].color).multiplyScalar(0.6);
        }
      }
      this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    }
    this.opts.onHover(id, x, y);
  }
  private readonly onStart = (): void => {
    this.tween = null;
    this.dragging = true;
    this.opts.onHover(null, 0, 0);
    this.opts.onUserMove();
  };
  private readonly onEnd = (): void => {
    this.dragging = false;
  };
  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pointer = [e.clientX, e.clientY];
  };
  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    this.hoverAt(-1e6, -1e6);
    this.opts.onHover(null, 0, 0);
  };
  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = [e.clientX, e.clientY, performance.now()];
  };
  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.down && Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) < 6 && performance.now() - this.down[2] < 500) {
      this.opts.onPick(this.pick(e.clientX, e.clientY));
    }
    this.down = null;
  };

  /* ------------------------------------------------------------------ construction helpers */

  private makeMaterials() {
    const std = (color: number, roughness: number, metalness: number) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    return {
      sub: std(0x353d2f, 0.55, 0.08),
      dieSide: std(0x39414e, 0.28, 0.6),
      solder: std(0xc9ced4, 0.25, 1),
      copper: std(0xc98d45, 0.3, 1),
      gold: std(0xd9b45c, 0.27, 1),
      lid: std(0xbfc6cd, 0.32, 0.9),
      ceramic: std(0x9a7b55, 0.55, 0),
      dark: std(0x262b31, 0.45, 0.35),
      laminate: std(0x6d6a4a, 0.85, 0),
      brass: std(0xb59a5a, 0.35, 1),
      wire: new THREE.LineBasicMaterial({ color: 0xd3dde8, transparent: true, opacity: 0.5 }),
      clockWire: new THREE.LineBasicMaterial({ color: 0xa28bff, transparent: true, opacity: 0.7 }),
      edge: new THREE.LineBasicMaterial({ color: 0x06090d, transparent: true, opacity: 0.38 }),
      treeEdge: new THREE.LineBasicMaterial({ color: 0xf1d3cb, transparent: true, opacity: 0.5 }),
      pos: new THREE.MeshStandardMaterial({ color: 0x2fb3a0, emissive: 0x0b3a33, roughness: 0.4 }),
      neg: new THREE.MeshStandardMaterial({ color: 0xe0705a, emissive: 0x3a150d, roughness: 0.4 }),
      main: new THREE.MeshStandardMaterial({ color: 0x66aaff, emissive: 0x0b2d52, roughness: 0.35 }),
      dfe: new THREE.MeshStandardMaterial({ color: 0x9a86ff, emissive: 0x241a58, roughness: 0.4 }),
      segUp: new THREE.MeshStandardMaterial({ color: 0x9fd0ff, emissive: 0x1d6fbf, roughness: 0.35 }),
      segDown: new THREE.MeshStandardMaterial({ color: 0x31505c, roughness: 0.5 }),
    };
  }
  private canvasTexture(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, this.renderer?.capabilities.getMaxAnisotropy() ?? 4);
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }
  private makeTextures(): Record<'std' | 'analog' | 'array', THREE.CanvasTexture> {
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      return [c, c.getContext('2d') as CanvasRenderingContext2D] as const;
    };
    const tex = (c: HTMLCanvasElement) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      return t;
    };
    let [c, g] = mk();
    g.fillStyle = '#dde3e8';
    g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 8) {
      g.fillStyle = '#9ea8b3';
      g.fillRect(0, y, 256, 1);
      for (let x = 0; x < 256;) {
        const w = 2 + Math.random() * 9, l = (160 + Math.random() * 80) | 0;
        g.fillStyle = `rgb(${l},${l + 4},${l + 10})`;
        g.fillRect(x, y + 1.6, w - 0.8, 5.4);
        x += w;
      }
    }
    const std = tex(c);
    [c, g] = mk();
    g.fillStyle = '#cfd7de';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 22; i++) {
      const x = Math.random() * 230, y = Math.random() * 230, w = 12 + Math.random() * 40, h = 10 + Math.random() * 40, l = (150 + Math.random() * 70) | 0;
      g.fillStyle = `rgb(${l},${l + 6},${l + 12})`;
      g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(40,50,60,0.25)';
      for (let k = 0; k < w; k += 3) g.fillRect(x + k, y, 1, h);
    }
    const analog = tex(c);
    [c, g] = mk();
    g.fillStyle = '#b9c2cb';
    g.fillRect(0, 0, 256, 256);
    for (let y = 4; y < 256; y += 16) for (let x = 4; x < 256; x += 16) {
      g.fillStyle = '#e8edf1';
      g.fillRect(x, y, 12, 12);
      g.fillStyle = '#8f9aa5';
      g.fillRect(x + 3, y + 3, 6, 6);
    }
    return { std, analog, array: tex(c) };
  }
  private register(id: BlockId, mesh: THREE.Object3D, category: Category, glow = true): void {
    let b = this.blocks.get(id);
    if (!b) this.blocks.set(id, (b = { mats: new Set(), meshes: [], category }));
    b.meshes.push(mesh);
    mesh.userData.block = id;
    this.pickables.push(mesh);
    const m = (mesh as THREE.Mesh).material;
    if (glow && m) for (const mat of ([] as THREE.Material[]).concat(m)) if (mat instanceof THREE.MeshStandardMaterial) b.mats.add(mat);
  }
  private block(die: THREE.Group, id: BlockId, s: { cat: Category; x: number; z: number; w: number; d: number; h: number; tex?: 'std' | 'analog' | 'array' }): void {
    const c = CATEGORY[s.cat].color;
    const side = new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0.1 });
    let top = side;
    if (s.tex) {
      const map = this.tex[s.tex].clone();
      map.repeat.set(s.w / 3.2, s.d / 3.2);
      map.needsUpdate = true;
      top = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.12, map });
    }
    const geo = new THREE.BoxGeometry(s.w, s.h, s.d);
    const mesh = new THREE.Mesh(geo, [side, side, top, side, side, side]);
    mesh.position.set(s.x, s.h / 2, s.z);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), this.mats.edge));
    die.add(mesh);
    this.register(id, mesh, s.cat);
  }
  private part(die: THREE.Group, id: BlockId, cat: Category, mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
    const m = new THREE.Mesh(this.unitBox, mat);
    m.position.set(x, y, z);
    m.scale.set(w, h, d);
    m.castShadow = true;
    die.add(m);
    this.register(id, m, cat, false);
    return m;
  }
  private wires(die: THREE.Group, segs: number[][], mat = this.mats.wire, y = 0.16): void {
    const a: number[] = [];
    for (const [x0, z0, x1, z1] of segs) a.push(x0, y, z0, x1, y, z1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3));
    die.add(new THREE.LineSegments(g, mat));
  }
  /** Octagonal spiral inductor drawn from flat top-metal segments, with its two leads. */
  private spiral(die: THREE.Group, id: BlockId, cat: Category, cx: number, cz: number, R: number, turns: number, pitch: number, width: number, y: number, mat: THREE.MeshStandardMaterial): void {
    const steps = Math.round(turns * 8), pts: [number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const th = (s * Math.PI) / 4 + Math.PI / 8, r = R - (pitch * s) / 8;
      pts.push([cx + r * Math.cos(th), cz + r * Math.sin(th)]);
    }
    const im = new THREE.InstancedMesh(this.unitBox, mat, steps + 2);
    const seg = (i: number, x0: number, z0: number, x1: number, z1: number, yy: number, w: number) => {
      const dx = x1 - x0, dz = z1 - z0;
      this.q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(dz, dx));
      this.m4.compose(this.v3.set((x0 + x1) / 2, yy, (z0 + z1) / 2), this.q4, this.s3.set(Math.hypot(dx, dz) + w * 0.9, 0.14, w));
      im.setMatrixAt(i, this.m4);
    };
    for (let s = 0; s < steps; s++) seg(s, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1], y, width);
    const a0 = Math.PI / 8, a1 = (steps * Math.PI) / 4 + Math.PI / 8, rIn = R - (pitch * steps) / 8;
    seg(steps, pts[0][0], pts[0][1], cx + (R + 1.3) * Math.cos(a0), cz + (R + 1.3) * Math.sin(a0), y, width);
    seg(steps + 1, cx + rIn * Math.cos(a1), cz + rIn * Math.sin(a1), cx + (R + 1.3) * Math.cos(a1), cz + (R + 1.3) * Math.sin(a1), y - 0.1, width * 0.8);
    im.castShadow = true;
    die.add(im);
    this.register(id, im, cat, mat !== this.mats.copper);
  }
  private pillars(die: THREE.Group, id: BlockId, xz: [number, number][], y0: number): THREE.Mesh[] {
    return xz.map(([x, z]) => {
      const m = this.part(die, id, 'digital', this.mats.pos, x, y0 + 0.5, z, 0.42, 1, 0.42);
      m.userData.y0 = y0;
      return m;
    });
  }
  private setPillar(m: THREE.Mesh, rel: number, mat: THREE.Material): void {
    const h = 0.12 + 2.4 * Math.min(1.4, Math.abs(rel));
    m.scale.y = h;
    m.position.y = (m.userData.y0 as number) + h / 2;
    m.material = mat;
  }
  /** 16 leaves → 8 → 4 → 2 → 1 → end node, with the edges drawn and room for the symbol sparks. */
  private tree(die: THREE.Group, id: BlockId, X: number[], zMin: number, zMax: number, end: [number, number]): Tree {
    const nodes: THREE.Vector3[][] = [[]];
    for (let i = 0; i < 16; i++) nodes[0].push(new THREE.Vector3(X[0], 0, zMin + ((zMax - zMin) * i) / 15));
    for (let l = 1; l <= 4; l++) {
      nodes[l] = [];
      for (let j = 0; j < 16 >> l; j++) nodes[l].push(new THREE.Vector3(X[l], 0, (nodes[l - 1][2 * j].z + nodes[l - 1][2 * j + 1].z) / 2));
    }
    nodes[5] = [new THREE.Vector3(end[0], 0, end[1])];
    const mux = new THREE.InstancedMesh(this.unitBox, new THREE.MeshStandardMaterial({ color: 0xcf9184, roughness: 0.5, metalness: 0.15 }), 31);
    let k = 0;
    for (let l = 0; l <= 4; l++) for (const n of nodes[l]) {
      const big = l > 0;
      this.m4.compose(this.v3.set(n.x, big ? 0.3 : 0.2, n.z), new THREE.Quaternion(), this.s3.set(big ? 0.62 : 0.36, big ? 0.4 : 0.2, big ? 0.5 : 0.34));
      mux.setMatrixAt(k++, this.m4);
    }
    mux.castShadow = true;
    die.add(mux);
    this.register(id, mux, 'mixed');
    const seg: number[] = [];
    for (let e = 0; e <= 4; e++) for (let i = 0; i < 16 >> e; i++) {
      const a = nodes[e][i], b = nodes[e + 1][i >> 1];
      seg.push(a.x, 0.36, a.z, b.x, 0.36, b.z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    die.add(new THREE.LineSegments(lg, this.mats.treeEdge));
    const sparks = new THREE.InstancedMesh(this.spark, new THREE.MeshBasicMaterial({ toneMapped: false }), 96);
    for (let i = 0; i < 96; i++) sparks.setColorAt(i, this.col.set(0xffffff));
    sparks.frustumCulled = false;
    sparks.count = 0;
    die.add(sparks);
    return { nodes, sparks };
  }
  private flow(die: THREE.Group, pts: [number, number][], count: number): void {
    const vs = pts.map(([x, z]) => new THREE.Vector3(x, 0.42, z));
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < vs.length - 1; i++) path.add(new THREE.LineCurve3(vs[i], vs[i + 1]));
    die.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs), this.mats.clockWire));
    const mesh = new THREE.InstancedMesh(this.spark, new THREE.MeshBasicMaterial({ color: 0xb49bff, toneMapped: false }), count);
    mesh.frustumCulled = false;
    die.add(mesh);
    this.flows.push({ path, mesh, count, len: path.getLength() });
  }
  private traceY(x: number): number {
    const ax = Math.abs(x);
    if (ax >= 36) return SUB_TOP + 0.02;
    if (ax <= 34.2) return 0.03;
    return 0.03 + ((SUB_TOP - 0.01) * (ax - 34.2)) / 1.8;
  }

  private buildBoard(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = Math.round((2048 * PCB_D) / PCB_W);
    const g = canvas.getContext('2d') as CanvasRenderingContext2D, W = canvas.width, H = canvas.height, S = W / PCB_W;
    const X = (x: number) => (x + PCB_W / 2) * S, Z = (z: number) => (z + PCB_D / 2) * S;
    g.fillStyle = '#0e3a2e';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(120, 190, 150, 0.045)';
    for (const [x0, z0, x1, z1] of [[-108, -58, 108, -14], [-108, 14, 108, 58], [-108, -58, -40, 58], [40, -58, 108, 58]]) g.fillRect(X(x0), Z(z0), (x1 - x0) * S, (z1 - z0) * S);
    for (let i = 0; i < 14000; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
      g.fillRect(Math.random() * W, Math.random() * H, 1.6, 1.6);
    }
    const via = (x: number, z: number, r: number) => {
      g.fillStyle = '#5d7a52';
      g.beginPath();
      g.arc(X(x), Z(z), r * S, 0, 7);
      g.fill();
      g.fillStyle = '#06140f';
      g.beginPath();
      g.arc(X(x), Z(z), r * 0.45 * S, 0, 7);
      g.fill();
    };
    for (let i = 0; i < NPTS; i += 5) {
      const p = this.chPts[i], t = this.chTan[i];
      if (Math.abs(p.x) > 33.5) continue;
      for (const sd of [-1, 1]) via(p.x - t.z * 3.3 * sd, p.z + t.x * 3.3 * sd, 0.42);
    }
    for (let x = -104; x <= 104; x += 4) {
      via(x, -57, 0.34);
      via(x, 57, 0.34);
    }
    g.strokeStyle = 'rgba(214, 235, 222, 0.55)';
    g.lineWidth = 0.9 * S;
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.moveTo(X(sx * PKG_X), Z(36.5));
      g.lineTo(X(sx * PKG_X), Z(27));
      g.stroke();
    }
    g.strokeStyle = g.fillStyle = '#e6eee8';
    g.lineWidth = 0.35 * S;
    for (const sx of [-1, 1]) {
      const cx = sx * PKG_X, h = PKG_W / 2 + 1.6, L = 7;
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        g.beginPath();
        g.moveTo(X(cx + dx * h), Z(dz * h - dz * L));
        g.lineTo(X(cx + dx * h), Z(dz * h));
        g.lineTo(X(cx + dx * h - dx * L), Z(dz * h));
        g.stroke();
      }
      g.beginPath();
      g.moveTo(X(cx - h - 1.2), Z(-h - 1.2));
      g.lineTo(X(cx - h + 2.2), Z(-h - 1.2));
      g.lineTo(X(cx - h - 1.2), Z(-h + 2.2));
      g.closePath();
      g.fill();
    }
    g.textBaseline = 'middle';
    const txt = (s: string, x: number, z: number, size: number, align: CanvasTextAlign = 'left', w = 600) => {
      g.font = `${w} ${size * S}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;
      g.textAlign = align;
      g.fillText(s, X(x), Z(z));
    };
    const cap = this.chPts[this.capIndex];
    txt('U1 · SERDES TX', -PKG_X - 27.6, 31.4, 2.3);
    txt('U2 · SERDES RX', PKG_X + 27.6, 31.4, 2.3, 'right');
    txt('Y1 156.25 MHz', -PKG_X + 4, 41.6, 1.7);
    txt('Y2 156.25 MHz', PKG_X + 4, 41.6, 1.7);
    txt('VR1', -98, -26.5, 1.8, 'center');
    txt('VR2', 98, -26.5, 1.8, 'center');
    txt('C41', cap.x, cap.z - 5.2, 1.5, 'center');
    txt('C42', cap.x, cap.z + 5.2, 1.5, 'center');
    txt('TL1 · 100 Ω DIFF · STRIPLINE', 0, 17.5, 1.9, 'center');
    txt('112G PAM4 LINK · EVALUATION BOARD · REV B', -105, -51.5, 2.4);
    txt('LOW-LOSS LAMINATE · 16 LAYERS · BACK-DRILLED VIAS', 105, 51.5, 1.7, 'right', 500);
    for (const [x, z] of [[-104, 54], [104, -54], [-104, -54], [104, 54]]) {
      g.beginPath();
      g.arc(X(x), Z(z), 3.4 * S, 0, 7);
      g.stroke();
    }
    const top = new THREE.MeshStandardMaterial({ map: this.canvasTexture(canvas), roughness: 0.6, metalness: 0.05 });
    const lam = this.mats.laminate;
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(PCB_W, PCB_T, PCB_D), [lam, lam, top, lam, lam, lam]);
    pcb.position.y = -PCB_T / 2;
    pcb.castShadow = pcb.receiveShadow = true;
    this.scene.add(pcb);
    this.register('pcb', pcb, 'io', false);
    for (const [x, z] of [[-104, 54], [104, -54], [-104, -54], [104, 54]]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.08, 28), this.mats.gold);
      ring.position.set(x, 0.04, z);
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.1, 24), new THREE.MeshBasicMaterial({ color: 0x050607 }));
      hole.position.set(x, 0.09, z);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, -FLOOR_Y - PCB_T, 6), this.mats.brass);
      post.position.set(x, (FLOOR_Y - PCB_T) / 2, z);
      post.castShadow = true;
      this.scene.add(ring, hole, post);
    }
    for (const sx of [-1, 1]) {
      const osc = new THREE.Mesh(new THREE.BoxGeometry(5, 1.3, 3.2), this.mats.lid);
      osc.position.set(sx * PKG_X, 0.65, 38.2);
      osc.castShadow = true;
      this.scene.add(osc);
      this.register('refclk', osc, 'clock');
      const vrm = new THREE.Mesh(new THREE.BoxGeometry(10, 4.2, 10), this.mats.dark);
      vrm.position.set(sx * 98, 2.1, -34);
      vrm.castShadow = vrm.receiveShadow = true;
      this.scene.add(vrm);
      this.register('vrm', vrm, 'afe', false);
    }
    const caps: [number, number, number][] = [];
    for (const s of [-1, 1]) {
      const cx = s * PKG_X;
      for (let z = -22; z <= 22; z += 4) caps.push([cx + s * 29.6, z, 0]);
      for (let dx = -22; dx <= 22; dx += 4) {
        caps.push([cx + dx, -29.6, 1]);
        if (Math.abs(dx) > 3) caps.push([cx + dx, 29.6, 1]);
      }
    }
    this.scene.add(this.instancedBoxes(caps, this.mats.ceramic, 0.45, [1.9, 0.9, 1]));
  }
  private instancedBoxes(pos: [number, number, number][], mat: THREE.Material, y: number, size: [number, number, number]): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(this.unitBox, mat, pos.length);
    const up = new THREE.Vector3(0, 1, 0);
    pos.forEach(([x, z, r], i) => {
      this.q4.setFromAxisAngle(up, r ? Math.PI / 2 : 0);
      this.m4.compose(this.v3.set(x, y, z), this.q4, this.s3.set(...size));
      im.setMatrixAt(i, this.m4);
    });
    im.castShadow = true;
    return im;
  }

  private buildPackages(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = Math.round((1024 * DIE_D) / DIE_W);
    const g = canvas.getContext('2d') as CanvasRenderingContext2D, W = canvas.width, H = canvas.height;
    g.fillStyle = '#1b2029';
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 6) for (let x = ((y / 6) % 2) * 3; x < W; x += 6) {
      g.fillStyle = Math.random() < 0.5 ? '#222833' : '#262d39';
      g.fillRect(x, y, 3.2, 3.2);
    }
    g.strokeStyle = '#6f7887';
    g.lineWidth = 5;
    g.strokeRect(8, 8, W - 16, H - 16);
    g.strokeStyle = '#4c5461';
    g.lineWidth = 2;
    g.strokeRect(18, 18, W - 36, H - 36);
    const dieTop = new THREE.MeshStandardMaterial({ map: this.canvasTexture(canvas), roughness: 0.32, metalness: 0.45 });
    const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(0.44, 10, 8), this.mats.solder, 2 * 22 * 22);
    const bumps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 6, 5), this.mats.solder, 2 * 26 * 21);
    const caps: [number, number, number][] = [];
    let nb = 0, nu = 0;
    const groups: THREE.Group[] = [];
    for (const s of [-1, 1]) {
      const cx = s * PKG_X;
      const sub = new THREE.Mesh(new THREE.BoxGeometry(PKG_W, PKG_H, PKG_W), this.mats.sub);
      sub.position.set(cx, SUB_BOT + PKG_H / 2, 0);
      sub.castShadow = sub.receiveShadow = true;
      this.scene.add(sub);
      this.register('pkg', sub, 'io');
      for (let i = 0; i < 22; i++) for (let j = 0; j < 22; j++) balls.setMatrixAt(nb++, this.m4.makeTranslation(cx + (i - 10.5) * 2.25, 0.42, (j - 10.5) * 2.25));
      for (let i = 0; i < 26; i++) for (let j = 0; j < 21; j++) bumps.setMatrixAt(nu++, this.m4.makeTranslation(cx + (i - 12.5) * 1.25, SUB_TOP + 0.15, (j - 10) * 1.25));
      for (let x = -15; x <= 15; x += 3.3) caps.push([cx + x, -17.4, 0], [cx + x, 17.4, 0]);
      for (let z = -12; z <= 12; z += 3) caps.push([cx + s * 20, z, 1]);
      const ds = this.mats.dieSide;
      const die = new THREE.Mesh(new THREE.BoxGeometry(DIE_W, DIE_H, DIE_D), [ds, ds, dieTop, ds, ds, ds]);
      die.position.set(cx, DIE_BOT + DIE_H / 2, 0);
      die.castShadow = die.receiveShadow = true;
      this.scene.add(die);
      const fp = new THREE.Group();
      fp.position.set(cx, DIE_TOP, 0);
      this.scene.add(fp);
      groups.push(fp);
    }
    balls.castShadow = true;
    this.scene.add(balls, bumps, this.instancedBoxes(caps, this.mats.ceramic, SUB_TOP + 0.35, [1.7, 0.7, 0.85]));
    [this.dieA, this.dieB] = groups;
  }

  private buildTransmitter(): void {
    const d = this.dieA;
    this.block(d, 'pcs_a', { cat: 'digital', x: -14, z: 0, w: 5, d: 26, h: 0.55, tex: 'std' });
    this.block(d, 'txdsp', { cat: 'digital', x: -9.1, z: -6, w: 3.6, d: 14, h: 0.6, tex: 'std' });
    this.block(d, 'ser', { cat: 'mixed', x: 0.3, z: -6, w: 14, d: 14.2, h: 0.1 });
    this.block(d, 'pll_a', { cat: 'clock', x: -1.75, z: 8, w: 18.5, d: 10, h: 0.1 });
    this.block(d, 'pll_a', { cat: 'clock', x: -8.8, z: 8, w: 3.6, d: 8.4, h: 0.18, tex: 'array' });
    this.block(d, 'pll_a', { cat: 'clock', x: 0.85, z: 8, w: 1.5, d: 3.0, h: 0.25, tex: 'array' });
    this.block(d, 'pll_a', { cat: 'clock', x: 4.9, z: 10.2, w: 4.4, d: 4.8, h: 0.35, tex: 'std' });
    this.block(d, 'pll_a', { cat: 'clock', x: 4.9, z: 5.2, w: 4.4, d: 3.4, h: 0.3, tex: 'analog' });
    this.block(d, 'drv', { cat: 'afe', x: 10.75, z: -6, w: 4.3, d: 8, h: 0.25 });
    this.block(d, 'esd_a', { cat: 'io', x: 15.1, z: -6, w: 3.0, d: 6.4, h: 0.1 });
    this.block(d, 'bias_a', { cat: 'afe', x: 12.6, z: 6.6, w: 7.6, d: 12.4, h: 0.4, tex: 'analog' });
    this.block(d, 'dft_a', { cat: 'digital', x: 12.6, z: -11.8, w: 7.8, d: 2.4, h: 0.35, tex: 'std' });
    const ind = this.mats.copper.clone();
    this.inductors.push(ind);
    this.spiral(d, 'pll_a', 'clock', -3.4, 8, 3.1, 2.5, 0.52, 0.34, 0.26, ind);
    this.txTree = this.tree(d, 'ser', [-6.2, -2.9, 0.2, 3.0, 5.4], -12.4, 0.4, [8.8, -6]);
    this.wires(d, this.txTree.nodes[0].map((n) => [-7.3, n.z, n.x, n.z]));
    this.segments = Array.from({ length: 8 }, (_, i) => this.part(d, 'drv', 'afe', this.mats.segDown, 9.0 + i * 0.5, 0.5, -6, 0.36, 0.5, 7.2));
    for (const z of [-7.6, -4.4]) this.spiral(d, 'esd_a', 'io', 14.6, z, 0.85, 1.5, 0.3, 0.16, 0.2, this.mats.copper);
    for (const z of [-7.1, -4.9]) this.part(d, 'esd_a', 'io', this.mats.gold, 16.2, 0.16, z, 0.9, 0.08, 0.9);
    for (const z of [-8.9, -3.1]) this.part(d, 'esd_a', 'io', this.mats.dark, 15.7, 0.2, z, 1.2, 0.2, 0.7);
    this.wires(d, [[12.9, -7.2, 13.8, -7.6], [15.4, -7.6, 16.2, -7.1], [12.9, -4.8, 13.8, -4.4], [15.4, -4.4, 16.2, -4.9]]);
    this.txPillars = this.pillars(d, 'txdsp', [[-9.1, -9.4], [-9.1, -6], [-9.1, -2.6]], 0.6);
    this.flow(d, [[4.9, 3.5], [6.9, 2.2], [6.9, -6], [8.6, -6]], 12);
  }

  private buildReceiver(): void {
    const d = this.dieB;
    this.block(d, 'esd_b', { cat: 'io', x: -15.1, z: -6, w: 3.0, d: 6.4, h: 0.1 });
    this.block(d, 'ctle', { cat: 'afe', x: -11.9, z: -6, w: 2.6, d: 8, h: 0.45 });
    this.block(d, 'vga', { cat: 'afe', x: -9.5, z: -6, w: 1.8, d: 8, h: 0.4 });
    this.block(d, 'th', { cat: 'afe', x: -7.0, z: -6, w: 1.6, d: 14.2, h: 0.1 });
    this.block(d, 'adc', { cat: 'conv', x: 0.1, z: -6, w: 11.8, d: 14.2, h: 0.1 });
    this.block(d, 'dsp', { cat: 'digital', x: 11.4, z: -6, w: 10.2, d: 14.2, h: 0.5, tex: 'std' });
    this.block(d, 'pll_b', { cat: 'clock', x: -8.1, z: 8, w: 9.8, d: 10, h: 0.1 });
    this.block(d, 'pll_b', { cat: 'clock', x: -11.9, z: 8, w: 1.8, d: 8, h: 0.18, tex: 'array' });
    this.block(d, 'pll_b', { cat: 'clock', x: -3.9, z: 8, w: 1.2, d: 3, h: 0.25, tex: 'array' });
    this.block(d, 'cdr', { cat: 'clock', x: -1.35, z: 8, w: 3.3, d: 10, h: 0.3, tex: 'std' });
    this.block(d, 'fw', { cat: 'digital', x: 3.3, z: 8, w: 5.4, d: 10, h: 0.45, tex: 'std' });
    this.block(d, 'deser', { cat: 'mixed', x: 9.35, z: 8, w: 6.2, d: 10, h: 0.1 });
    this.block(d, 'pcs_b', { cat: 'digital', x: 14.6, z: 8, w: 4, d: 10, h: 0.55, tex: 'std' });
    this.block(d, 'bias_b', { cat: 'afe', x: -15.0, z: 6.2, w: 3.2, d: 13.6, h: 0.4, tex: 'analog' });
    this.block(d, 'mon_b', { cat: 'digital', x: -12.3, z: -11.8, w: 8.4, d: 2.4, h: 0.35, tex: 'std' });
    const ind = this.mats.copper.clone();
    this.inductors.push(ind);
    this.spiral(d, 'pll_b', 'clock', -7.6, 8.2, 2.9, 2.5, 0.5, 0.32, 0.26, ind);
    for (const z of [-7.6, -4.4]) this.spiral(d, 'esd_b', 'io', -14.6, z, 0.85, 1.5, 0.3, 0.16, 0.2, this.mats.copper);
    for (const z of [-7.1, -4.9]) this.part(d, 'esd_b', 'io', this.mats.gold, -16.2, 0.16, z, 0.9, 0.08, 0.9);
    for (const z of [-6.35, -5.65]) this.part(d, 'esd_b', 'io', this.mats.dark, -15.6, 0.2, z, 1.4, 0.12, 0.28);
    for (const z of [-8.3, -3.7]) this.spiral(d, 'ctle', 'afe', -12.2, z, 0.75, 1.5, 0.26, 0.14, 0.52, this.mats.copper);
    this.wires(d, [[-16.2, -7.1, -15.4, -7.6], [-13.8, -7.6, -13.2, -7.2], [-16.2, -4.9, -15.4, -4.4], [-13.8, -4.4, -13.2, -4.8]]);
    const rowZ = Array.from({ length: 8 }, (_, r) => -12.2 + r * 1.74), colX = Array.from({ length: 8 }, (_, c) => -5.0 + c * 1.45);
    this.wires(d, rowZ.map((z) => [-8.6, -6, -7.6, z]));
    this.wires(d, rowZ.map((z) => [-6.4, z, 6.0, z]), this.mats.wire, 0.13);
    this.tiles = new THREE.InstancedMesh(this.unitBox, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 }), 64);
    this.bars = new THREE.InstancedMesh(this.unitBox, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }), 64);
    this.thBoxes = new THREE.InstancedMesh(this.unitBox, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.15 }), 8);
    this.tiles.userData.colX = colX;
    this.tiles.userData.rowZ = rowZ;
    for (let i = 0; i < 64; i++) {
      this.tiles.setMatrixAt(i, this.m4.compose(this.v3.set(colX[i >> 3], 0.18, rowZ[i & 7]), new THREE.Quaternion(), this.s3.set(1.15, 0.16, 1.3)));
      this.tiles.setColorAt(i, TILE_BASE);
      this.bars.setMatrixAt(i, this.m4.compose(this.v3.set(colX[i >> 3], 0.4, rowZ[i & 7]), new THREE.Quaternion(), this.s3.set(0.46, 0.2, 0.46)));
      this.bars.setColorAt(i, TILE_BASE);
    }
    for (let r = 0; r < 8; r++) {
      this.thBoxes.setMatrixAt(r, this.m4.compose(this.v3.set(-7.0, 0.27, rowZ[r]), new THREE.Quaternion(), this.s3.set(1.1, 0.34, 1.2)));
      this.thBoxes.setColorAt(r, TH_BASE);
    }
    for (const m of [this.tiles, this.bars, this.thBoxes]) {
      m.castShadow = true;
      m.frustumCulled = false;
      d.add(m);
    }
    this.register('adc', this.tiles, 'conv', false);
    this.register('adc', this.bars, 'conv', false);
    this.register('th', this.thBoxes, 'afe', false);
    this.rxPillars = this.pillars(d, 'dsp', Array.from({ length: NF + 1 }, (_, i): [number, number] => (i < NF ? [7.2 + i * 0.64, -6.6] : [15.4, -6.6])), 0.5);
    this.rxTree = this.tree(d, 'deser', [11.9, 10.8, 9.7, 8.7, 7.7], 3.5, 12.5, [7.3, 1.7]);
    this.wires(d, this.rxTree.nodes[0].map((n) => [n.x, n.z, 12.6, n.z]));
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xb9a8ff, emissive: 0x2d1f73, roughness: 0.3, metalness: 0.4 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.07, 8, 48), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(-1.35, 0.42, 9.6);
    d.add(ring);
    this.register('cdr', ring, 'clock');
    this.needle = new THREE.Group();
    this.needle.position.set(-1.35, 0.44, 9.6);
    d.add(this.needle);
    const hand = new THREE.Mesh(this.unitBox, ringMat);
    hand.scale.set(0.95, 0.07, 0.12);
    hand.position.x = 0.45;
    this.needle.add(hand);
    this.register('cdr', hand, 'clock', false);
    this.flow(d, [[-3.3, 8], [-1.35, 8], [-1.35, 2.3], [-7.0, 2.3], [-7.0, -12.9]], 16);
    this.flow(d, [[-1.35, 2.3], [6.15, 2.3], [6.15, -12.9]], 12);
  }

  private strip(offset: number, width: number, lift: number): THREE.BufferGeometry {
    const pos = new Float32Array(NPTS * 6), idx: number[] = [];
    for (let i = 0; i < NPTS; i++) {
      const p = this.chPts[i], t = this.chTan[i], l = Math.hypot(t.x, t.z) || 1, ux = -t.z / l, uz = t.x / l;
      const cx = p.x + ux * offset, cz = p.z + uz * offset, y = this.traceY(cx) + lift, hw = width / 2;
      pos.set([cx + ux * hw, y, cz + uz * hw, cx - ux * hw, y, cz - uz * hw], i * 6);
      if (i < NPTS - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  private buildChannel(): void {
    const traceMat = this.mats.copper.clone();
    traceMat.side = THREE.DoubleSide;
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    for (const off of [0.9, -0.9]) {
      const tr = new THREE.Mesh(this.strip(off, 0.78, 0), traceMat);
      tr.receiveShadow = true;
      this.scene.add(tr);
      this.register('chan', tr, 'io', false);
      const gg = this.strip(off, 0.5, 0.05);
      gg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(NPTS * 6), 3));
      const gm = new THREE.Mesh(gg, glowMat);
      gm.frustumCulled = false;
      gm.renderOrder = 1;
      this.scene.add(gm);
      this.glows.push(gg);
    }
    const p = this.chPts[this.capIndex], t = this.chTan[this.capIndex], l = Math.hypot(t.x, t.z), ux = -t.z / l, uz = t.x / l;
    for (const off of [0.9, -0.9]) {
      const g = new THREE.Group();
      g.position.set(p.x + ux * off, this.traceY(p.x) + 0.55, p.z + uz * off);
      g.rotation.y = -Math.atan2(t.z, t.x);
      this.scene.add(g);
      const body = new THREE.Mesh(this.unitBox, this.mats.ceramic);
      body.scale.set(1.5, 0.9, 1.0);
      body.castShadow = true;
      g.add(body);
      this.register('accaps', body, 'io', false);
      for (const sx of [-1, 1]) {
        const e = new THREE.Mesh(this.unitBox, this.mats.solder);
        e.scale.set(0.42, 0.95, 1.05);
        e.position.x = sx * 0.95;
        g.add(e);
        this.register('accaps', e, 'io', false);
      }
    }
    const pos = new Float32Array(NPTS * 6), edge = new Float32Array(NPTS * 2), idx: number[] = [];
    for (let i = 0; i < NPTS; i++) {
      const q = this.chPts[i];
      pos.set([q.x, CURT_Y, q.z, q.x, CURT_Y, q.z], i * 6);
      edge[i * 2 + 1] = 1;
      if (i < NPTS - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.curtainGeo = new THREE.BufferGeometry();
    this.curtainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.curtainGeo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
    this.curtainGeo.setIndex(idx);
    this.curtainMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x66aaff) } },
      vertexShader: 'attribute float aEdge;\nvarying float vE;\nvoid main() { vE = aEdge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor;\nvarying float vE;\nvoid main() {\n  gl_FragColor = vec4(uColor, mix(0.035, 0.5, pow(vE, 1.7)));\n  #include <colorspace_fragment>\n}',
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const curtain = new THREE.Mesh(this.curtainGeo, this.curtainMat);
    curtain.frustumCulled = false;
    curtain.renderOrder = 2;
    this.scene.add(curtain);
    this.edgeGeo = new THREE.BufferGeometry();
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NPTS * 3), 3));
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0xc6ddff, transparent: true, opacity: 0.95, toneMapped: false });
    const edgeLine = new THREE.Line(this.edgeGeo, this.edgeMat);
    edgeLine.frustumCulled = false;
    edgeLine.renderOrder = 3;
    this.scene.add(edgeLine);
    this.baseMat = new THREE.LineBasicMaterial({ color: 0x7f8d9b, transparent: true, opacity: 0.35 });
    this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.chPts.map((q) => new THREE.Vector3(q.x, CURT_Y, q.z))), this.baseMat));
  }

  private label(parent: THREE.Object3D, text: string, x: number, y: number, z: number, cat: Category | null, lod = 140, big = false): Label {
    const wrap = document.createElement('div'), el = document.createElement('div'), dot = document.createElement('i'), span = document.createElement('span');
    el.className = big ? 'serdes-lbl big' : 'serdes-lbl';
    if (cat) dot.style.background = `#${CATEGORY[cat].color.toString(16).padStart(6, '0')}`;
    span.textContent = text;
    el.append(dot, span);
    wrap.append(el);
    const obj = new CSS2DObject(wrap);
    obj.position.set(x, y, z);
    parent.add(obj);
    parent.updateMatrixWorld(true);
    const l: Label = { wrap, text: span, lod, world: new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld), far: false };
    this.labelList.push(l);
    return l;
  }
  private buildLabels(): void {
    const a = this.dieA, b = this.dieB, s = this.scene, cap = this.chPts[this.capIndex];
    this.label(a, 'Chip A · transmitter', 0, 3.2, -15.2, 'digital', 1e9, true);
    this.label(b, 'Chip B · receiver', 0, 3.2, -15.2, 'digital', 1e9, true);
    this.label(a, 'PCS · KP4 FEC', -14, 1.1, -9, 'digital');
    this.label(a, 'TX FFE', -9.1, 3.4, -6, 'digital');
    this.label(a, 'MUX tree', 0.3, 1.3, -12.6, 'mixed');
    this.label(a, 'LC-PLL · 14 GHz', -3.4, 1.3, 8, 'clock');
    this.label(a, 'SST driver', 10.75, 1.4, -9.6, 'afe');
    this.label(a, 'T-coil · ESD', 15.1, 0.9, -2.4, 'io', 95);
    this.label(a, 'Bias · LDO', 12.6, 1.0, 6.6, 'afe', 95);
    this.label(b, 'CTLE', -11.9, 1.5, -10.4, 'afe');
    this.label(b, 'VGA', -9.5, 1.4, -1.6, 'afe', 100);
    this.label(b, 'T/H ×8', -7.0, 1.1, 1.8, 'afe', 100);
    this.label(b, '64× SAR TI-ADC', 0.1, 2.1, -13.3, 'conv');
    this.label(b, 'DSP · FFE + DFE', 11.4, 3.5, -6.6, 'digital');
    this.label(b, 'CDR · PI', -1.35, 1.5, 11.9, 'clock', 110);
    this.label(b, 'LC-PLL', -7.6, 1.2, 8.2, 'clock', 110);
    this.label(b, 'DEMUX tree', 9.4, 1.2, 12.9, 'mixed', 110);
    this.label(b, 'PCS · FEC', 14.6, 1.3, 8, 'digital', 110);
    this.label(b, 'Adaptation µC', 3.3, 1.2, 8, 'digital', 95);
    this.label(s, 'Line voltage · slow motion', 0, CURT_Y + 8.6, 6.5, null, 1e9);
    this.label(s, 'Launch · 1.0 Vppd', this.chPts[0].x + 5, CURT_Y + 7.4, -6, null, 190);
    this.padLabel = this.label(s, 'RX pad', this.chPts[NPTS - 1].x - 5, CURT_Y + 7.4, -6, null, 190);
    this.label(s, 'AC-coupling caps', cap.x, 2.2, cap.z + 3.2, 'io', 120);
    this.label(s, 'PCB stripline · 100 Ω differential', 0, 0.5, 14.5, 'io', 190);
    this.label(s, '156.25 MHz reference', -PKG_X, 1.7, 38.2, 'clock', 130);
    this.label(s, 'FCBGA package', PKG_X + 17, SUB_TOP + 0.2, 25.5, 'io', 150);
  }

  /* ------------------------------------------------------------------ per-frame updates */

  private edgeIndex(n: number, e: number): number {
    let idx = 0;
    for (let l = 3; l >= e; l--) idx = (idx << 1) | ((n >> (3 - l)) & 1);
    return idx;
  }
  private sparkAt(T: Tree, k: number, n: number, e: number, fr: number, rev: boolean, c: THREE.Color, sc: number): void {
    const idx = this.edgeIndex(n, e), a = T.nodes[e][idx], b = T.nodes[e + 1][idx >> 1];
    this.v3.lerpVectors(a, b, rev ? 1 - fr : fr);
    this.v3.y = 0.5 + 0.32 * Math.sin(Math.PI * fr);
    T.sparks.setMatrixAt(k, this.m4.compose(this.v3, this.qi, this.s3.setScalar(sc)));
    T.sparks.setColorAt(k, c);
  }
  private static touch(m: THREE.InstancedMesh): void {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  /** Symbol n leaves the MUX tree at n − 0.5 and is launched at about n + 0.5. */
  private updateTx(t: number, s: SymbolStream): void {
    let k = 0;
    for (let n = Math.ceil(t + 0.5); n <= Math.floor(t + 47); n++) {
      const el = t - (n - 47);
      if (el < 0 || el >= 46.5) continue;
      let e = 0;
      while (e < 4 && el >= TX_CUM[e + 1]) e++;
      this.sparkAt(this.txTree, k++, n, e, (el - TX_CUM[e]) / DUR[e], false, this.symbolColors[s.sym[n & MASK]], 1);
    }
    this.txTree.sparks.count = k;
    SerdesScene.touch(this.txTree.sparks);
    const up = [0, 3, 5, 8][s.sym[Math.floor(t + 0.5) & MASK]];
    for (let i = 0; i < 8; i++) this.segments[i].material = i < up ? this.mats.segUp : this.mats.segDown;
  }
  /** Decided symbols fan out through the DEMUX tree; errors are drawn larger in red. */
  private updateRx(t: number, rx: Receiver, s: SymbolStream): void {
    const base = NFPRE + rx.tSample + 2;
    let k = 0;
    for (let n = Math.max(0, Math.ceil(t - base - 46.5)); n <= Math.min(s.decided - 1, Math.floor(t - base)); n++) {
      const el = t - (n + base);
      if (el < 0 || el >= 46.5) continue;
      let e = 4;
      while (e > 0 && el >= RX_CUM[e - 1]) e--;
      const err = s.error[n & MASK] === 1;
      this.sparkAt(this.rxTree, k++, n, e, (el - RX_CUM[e]) / DUR[e], true, err ? this.errorColor : this.symbolColors[s.decision[n & MASK]], err ? 1.8 : 1);
    }
    this.rxTree.sparks.count = k;
    SerdesScene.touch(this.rxTree.sparks);
  }
  /** v(s, t): the symbols convolved with the pulse response of a line of fractional length s. */
  private updateCurtain(t: number, s: SymbolStream, line: Float32Array[]): void {
    const cPos = (this.curtainGeo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const ePos = (this.edgeGeo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < NPTS; i++) {
      const u = (i / (NPTS - 1)) * 15, j0 = Math.min(14, Math.floor(u)), fr = u - j0, q0 = line[j0], q1 = line[j0 + 1];
      const m = Math.floor((t - (i / (NPTS - 1)) * NFLY + T0) * OS), nHi = Math.floor((m - PS) / OS);
      let v0 = 0, v1 = 0;
      for (let n = nHi, k = m - nHi * OS - PS; k < PLEN; n--, k += OS) {
        const a = s.level[n & MASK];
        v0 += a * q0[k];
        v1 += a * q1[k];
      }
      const v = v0 + (v1 - v0) * fr, y = CURT_Y + CURT_K * v;
      this.curtainV[i] = v;
      cPos[i * 6 + 4] = y;
      ePos[i * 3] = this.chPts[i].x;
      ePos[i * 3 + 1] = y;
      ePos[i * 3 + 2] = this.chPts[i].z;
    }
    this.curtainGeo.getAttribute('position').needsUpdate = true;
    this.edgeGeo.getAttribute('position').needsUpdate = true;
    const gc = this.glowColor;
    for (let g = 0; g < 2; g++) {
      const attr = this.glows[g].getAttribute('color') as THREE.BufferAttribute, arr = attr.array as Float32Array, sg = g ? -1 : 1;
      for (let i = 0; i < NPTS; i++) {
        const b = 0.08 + 0.92 * Math.min(1, Math.max(0, sg * this.curtainV[i])), o = i * 6;
        arr[o] = arr[o + 3] = gc.r * b;
        arr[o + 1] = arr[o + 4] = gc.g * b;
        arr[o + 2] = arr[o + 5] = gc.b * b;
      }
      attr.needsUpdate = true;
    }
  }
  private levelColor(x: number, out: THREE.Color): THREE.Color {
    const p = Math.min(3, Math.max(0, (x + 1) * 1.5)), i = Math.min(2, Math.floor(p));
    return out.copy(this.symbolColors[i]).lerp(this.symbolColors[i + 1], p - i);
  }
  private updateTiles(t: number, rx: Receiver): void {
    const h0 = rx.a.h[6] || 0.3, colX = this.tiles.userData.colX as number[], rowZ = this.tiles.userData.rowZ as number[];
    for (let i = 0; i < 64; i++) {
      const fl = t >= this.tileT[i] ? Math.exp(-(t - this.tileT[i]) / 2.5) : 0, v = this.tileV[i], h = 0.1 + 0.75 * (v + 1);
      this.tiles.setColorAt(i, this.col.copy(TILE_BASE).lerp(TILE_FLASH, fl));
      this.bars.setMatrixAt(i, this.m4.compose(this.v3.set(colX[i >> 3], 0.26 + h / 2, rowZ[i & 7]), this.qi, this.s3.set(0.46, h, 0.46)));
      this.bars.setColorAt(i, this.levelColor(v / (1.15 * h0), this.col).lerp(TILE_FLASH, fl * 0.45));
    }
    for (let r = 0; r < 8; r++) this.thBoxes.setColorAt(r, this.col.copy(TH_BASE).lerp(TH_FLASH, t >= this.thT[r] ? Math.exp(-(t - this.thT[r]) / 1.2) : 0));
    SerdesScene.touch(this.tiles);
    SerdesScene.touch(this.bars);
    SerdesScene.touch(this.thBoxes);
  }
  private updatePillars(rx: Receiver, txFfe: boolean): void {
    const main = rx.taps[NFPRE] || 1;
    for (let a = 0; a < NF; a++) {
      const rel = rx.taps[a] / main;
      this.setPillar(this.rxPillars[a], rel, a === NFPRE ? this.mats.main : rel >= 0 ? this.mats.pos : this.mats.neg);
    }
    this.setPillar(this.rxPillars[NF], rx.dsp ? rx.live.b1 : 0, this.mats.dfe);
    const c = txFfe ? [-0.1, 0.75, -0.15] : [0, 1, 0];
    for (let i = 0; i < 3; i++) this.setPillar(this.txPillars[i], c[i] / c[1], i === 1 ? this.mats.main : c[i] >= 0 ? this.mats.pos : this.mats.neg);
  }
  private updateFlow(f: Flow, time: number): void {
    for (let i = 0; i < f.count; i++) {
      f.path.getPointAt(((time * 5) / f.len + i / f.count) % 1, this.v3);
      f.mesh.setMatrixAt(i, this.m4.makeTranslation(this.v3.x, this.v3.y, this.v3.z));
    }
    f.mesh.instanceMatrix.needsUpdate = true;
  }
}

const TILE_BASE = new THREE.Color(0x8a6a2e), TILE_FLASH = new THREE.Color(0xfff0b8);
const TH_BASE = new THREE.Color(0x2f8f83), TH_FLASH = new THREE.Color(0xc8fff4);
