// 3D living-room stage: characters, props, spinner wheel, camera moves.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

let renderer, scene, camera;
const clock = new THREE.Clock();
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0, ...opts }));
  return matCache.get(key);
}
function add(parent, geo, material, pos = [0, 0, 0], { cast = true, receive = false, rot, scale } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.castShadow = cast; m.receiveShadow = receive;
  parent.add(m);
  return m;
}
const rbox = (w, h, d, r = 0.08) => new RoundedBoxGeometry(w, h, d, 4, r);

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- textures ----------
function woodTex() {
  const t = canvasTex(1024, 1024, (g, w, h) => {
    const pw = w / 8;
    for (let i = 0; i < 8; i++) {
      for (let seg = 0; seg < 3; seg++) {
        const y0 = ((seg + (i % 2) * 0.5) * h) / 3 - h / 6;
        const hue = 24 + Math.random() * 6, l = 34 + Math.random() * 8;
        g.fillStyle = `hsl(${hue},58%,${l}%)`;
        g.fillRect(i * pw, y0, pw, h / 3 + 2);
        g.fillStyle = `hsl(${hue},58%,${l}%)`;
        g.fillRect(i * pw, y0 + h, pw, h / 3 + 2);
        for (let k = 0; k < 14; k++) {
          g.strokeStyle = `hsla(20,50%,${l - 10}%,${0.15 + Math.random() * 0.2})`;
          g.lineWidth = 1 + Math.random() * 2;
          const x = i * pw + Math.random() * pw;
          g.beginPath(); g.moveTo(x, y0); g.bezierCurveTo(x + 6, y0 + 100, x - 6, y0 + 200, x + 2, y0 + h / 3); g.stroke();
        }
        g.fillStyle = 'rgba(40,18,8,.55)';
        g.fillRect(i * pw, y0, pw, 3);
      }
      g.fillStyle = 'rgba(40,18,8,.6)';
      g.fillRect(i * pw, 0, 4, h);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 3);
  return t;
}
function wallTex() {
  return canvasTex(512, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#3e1c1c'); gr.addColorStop(0.55, '#6b2f28'); gr.addColorStop(1, '#58261f');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  });
}
function glowTex(color) {
  return canvasTex(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, color); gr.addColorStop(0.25, color.replace('1)', '0.5)')); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  });
}
function rugTex() {
  return canvasTex(512, 512, (g) => {
    for (let r = 250; r > 0; r -= 22) {
      g.fillStyle = (r / 22) % 2 < 1 ? '#b3245f' : '#c7336f';
      g.beginPath(); g.arc(256, 256, r, 0, TAU); g.fill();
    }
  });
}
function logoTex() {
  return canvasTex(1400, 760, (g, w, h) => {
    const cx = w / 2;
    // sound arcs
    g.lineCap = 'round';
    [['#ffcf3a', 190], ['#ff4f9a', 250], ['#9b5cff', 310]].forEach(([c, r], i) => {
      g.strokeStyle = '#2a0f14'; g.lineWidth = 46;
      g.beginPath(); g.arc(cx, 300, r, -Math.PI * 0.32, Math.PI * 0.32); g.stroke();
      g.beginPath(); g.arc(cx, 300, r, Math.PI * 0.68, Math.PI * 1.32); g.stroke();
      g.strokeStyle = c; g.lineWidth = 30;
      g.beginPath(); g.arc(cx, 300, r, -Math.PI * 0.32, Math.PI * 0.32); g.stroke();
      g.beginPath(); g.arc(cx, 300, r, Math.PI * 0.68, Math.PI * 1.32); g.stroke();
    });
    // microphone
    g.fillStyle = '#2a0f14';
    g.beginPath(); g.roundRect(cx - 88, 120, 176, 270, 88); g.fill();
    const mg = g.createLinearGradient(cx - 80, 0, cx + 80, 0);
    mg.addColorStop(0, '#ff7ab8'); mg.addColorStop(1, '#e0206e');
    g.fillStyle = mg;
    g.beginPath(); g.roundRect(cx - 72, 136, 144, 238, 72); g.fill();
    g.fillStyle = 'rgba(255,255,255,.35)';
    for (let y = 170; y < 340; y += 34) { g.beginPath(); g.roundRect(cx - 50, y, 100, 12, 6); g.fill(); }
    g.strokeStyle = '#2a0f14'; g.lineWidth = 22;
    g.beginPath(); g.arc(cx, 300, 118, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
    g.beginPath(); g.moveTo(cx, 418); g.lineTo(cx, 470); g.stroke();
    g.strokeStyle = '#ffcf3a'; g.lineWidth = 10;
    g.beginPath(); g.arc(cx, 300, 118, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
    // wordmark
    const word = (txt, y, size, fill, rot) => {
      g.save(); g.translate(cx, y); g.rotate(rot);
      g.font = `${size}px "Lilita One"`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.strokeStyle = '#2a0f14'; g.lineWidth = 34; g.strokeText(txt, 0, 8);
      g.strokeStyle = '#fff6e0'; g.lineWidth = 14; g.strokeText(txt, 0, 0);
      g.fillStyle = fill; g.fillText(txt, 0, 0);
      g.restore();
    };
    const yg = g.createLinearGradient(0, 470, 0, 600); yg.addColorStop(0, '#ffe56b'); yg.addColorStop(1, '#ffa81f');
    word('MIMIC', 540, 190, yg, -0.03);
    const pg = g.createLinearGradient(0, 610, 0, 720); pg.addColorStop(0, '#ff6fb0'); pg.addColorStop(1, '#e0205e');
    word('VOICE', 672, 150, pg, 0.02);
  });
}
function neonTex(lines) {
  return canvasTex(512, 400, (g, w) => {
    g.font = '86px "Lilita One"'; g.textAlign = 'center';
    lines.forEach((l, i) => {
      const y = 110 + i * 110;
      g.save(); g.translate(w / 2, y); g.rotate(-0.08);
      g.shadowColor = '#ff3fa4'; g.shadowBlur = 30;
      g.strokeStyle = '#ff5fb5'; g.lineWidth = 8; g.strokeText(l, 0, 0);
      g.shadowBlur = 10; g.fillStyle = '#ffd6ee'; g.fillText(l, 0, 0);
      g.restore();
    });
  });
}
let spkTexCache = null;
function speakerTex() {
  if (spkTexCache) return spkTexCache;
  spkTexCache = canvasTex(128, 128, (g) => {
    g.fillStyle = '#2fd05a'; g.strokeStyle = '#0d4a1c'; g.lineWidth = 8; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(20, 50); g.lineTo(44, 50); g.lineTo(72, 24); g.lineTo(72, 104); g.lineTo(44, 78); g.lineTo(20, 78); g.closePath(); g.stroke(); g.fill();
    g.lineCap = 'round'; g.lineWidth = 12;
    [[22, 0.9], [40, 0.9]].forEach(([r]) => { g.strokeStyle = '#0d4a1c'; g.beginPath(); g.arc(76, 64, r, -0.8, 0.8); g.stroke(); g.strokeStyle = '#2fd05a'; g.lineWidth = 7; g.beginPath(); g.arc(76, 64, r, -0.8, 0.8); g.stroke(); g.lineWidth = 12; });
  });
  return spkTexCache;
}
function dustTex() {
  return canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(235,215,190,.9)'); gr.addColorStop(1, 'rgba(235,215,190,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}
function labelTex(text) {
  const t = canvasTex(512, 128, (g, w, h) => {
    g.font = '600 64px "Fredoka"'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.strokeStyle = 'rgba(40,15,15,.85)'; g.lineWidth = 12; g.strokeText(text, w / 2, h / 2);
    g.fillStyle = '#fff4ea'; g.fillText(text, w / 2, h / 2);
  });
  return t;
}

// ---------- props ----------
function buildRoom() {
  const floor = add(scene, new THREE.PlaneGeometry(44, 26), new THREE.MeshStandardMaterial({ map: woodTex(), roughness: 0.55 }), [0, 0, 2], { cast: false, receive: true, rot: [-Math.PI / 2, 0, 0] });
  floor.material.color.set('#e8b98f');
  add(scene, new THREE.PlaneGeometry(44, 14), new THREE.MeshStandardMaterial({ map: wallTex(), roughness: 0.95 }), [0, 7, -4.6], { cast: false, receive: true });
  add(scene, new THREE.BoxGeometry(44, 0.32, 0.12), mat('#2e1310'), [0, 0.16, -4.54], { cast: false });
  // side walls angled in for depth
  [-1, 1].forEach((s) => add(scene, new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ map: wallTex(), roughness: 0.95, color: '#c9a39a' }), [s * 13, 7, 0], { cast: false, receive: true, rot: [0, -s * Math.PI / 2.4, 0] }));

  // logo + neon sign
  add(scene, new THREE.PlaneGeometry(6.4, 3.47), new THREE.MeshBasicMaterial({ map: logoTex(), transparent: true, toneMapped: false, color: '#e8d8d0' }), [0, 4.35, -4.5], { cast: false });
  add(scene, new THREE.PlaneGeometry(2.4, 1.9), new THREE.MeshBasicMaterial({ map: neonTex(['NO SHY', 'VOICES']), transparent: true, toneMapped: false }), [-5.3, 4.6, -4.5], { cast: false });

  // hanging bulbs + spot pools on the wall
  const glow = new THREE.SpriteMaterial({ map: glowTex('rgba(255,210,110,1)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  [-3.4, 3.4].forEach((x) => {
    add(scene, new THREE.CylinderGeometry(0.015, 0.015, 3), mat('#1b0d0b'), [x, 8.3, -2.6], { cast: false });
    add(scene, new THREE.CylinderGeometry(0.1, 0.1, 0.18, 16), mat('#2b2b2b', { metalness: 0.6, roughness: 0.4 }), [x, 6.85, -2.6], { cast: false });
    add(scene, new THREE.SphereGeometry(0.22, 24, 16), new THREE.MeshBasicMaterial({ color: '#fff2a8', toneMapped: false }), [x, 6.58, -2.6], { cast: false });
    const sp = new THREE.Sprite(glow); sp.position.set(x, 6.58, -2.5); sp.scale.set(2.2, 2.2, 1); scene.add(sp);
    const spot = new THREE.SpotLight('#ffc27a', 60, 16, 0.62, 0.75, 1.4);
    spot.position.set(x, 6.5, -2.6);
    spot.target.position.set(x * 0.9, 0, -3.6);
    scene.add(spot, spot.target);
  });

  // shelf + plants + string lights (left)
  add(scene, rbox(2.4, 0.14, 0.6, 0.04), mat('#8a4a2c'), [-7.4, 3.35, -4.25]);
  potPlant(-8.1, 3.42, -4.2, 0.55);
  potPlant(-7.0, 3.42, -4.2, 0.4);
  const bulbMat = new THREE.MeshBasicMaterial({ color: '#ffe36a', toneMapped: false });
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const x = lerp(-9.4, -6.1, t), y = 3.25 - Math.sin(t * Math.PI) * 0.45 - (t > 0.6 ? (t - 0.6) * 4.5 : 0);
    add(scene, new THREE.SphereGeometry(0.07, 10, 8), bulbMat, [x, y, -4.1], { cast: false });
  }

  // armchair
  const chair = new THREE.Group(); chair.position.set(-7.6, 0, -2.3); chair.rotation.y = 0.35; scene.add(chair);
  const red = mat('#d3242a'), yel = mat('#ffcf2e');
  add(chair, rbox(1.9, 0.5, 1.5, 0.18), red, [0, 0.62, 0]);
  add(chair, rbox(1.9, 2.2, 0.45, 0.22), red, [0, 1.6, -0.55]);
  add(chair, rbox(0.4, 0.9, 1.5, 0.16), red, [-0.95, 0.95, 0]);
  add(chair, rbox(0.4, 0.9, 1.5, 0.16), red, [0.95, 0.95, 0]);
  add(chair, new THREE.BoxGeometry(2.1, 0.14, 1.6), yel, [0, 0.3, 0]);
  for (let i = 0; i < 12; i++) add(chair, new THREE.SphereGeometry(0.07, 10, 8), yel, [((i % 4) - 1.5) * 0.4, 1.3 + Math.floor(i / 4) * 0.45, -0.32]);
  [[-0.8, -0.6], [0.8, -0.6], [-0.8, 0.6], [0.8, 0.6]].forEach(([x, z]) => add(chair, new THREE.CylinderGeometry(0.07, 0.05, 0.3), yel, [x, 0.15, z]));
  potPlant(-5.6, 0, -3.2, 1.3);

  // speakers
  speakers.push(buildSpeaker(-4.7, -3.3, 0.25), buildSpeaker(4.9, -3.3, -0.25));

  // couch + table + plant (right)
  const couch = new THREE.Group(); couch.position.set(8.2, 0, -1.8); couch.rotation.y = -0.5; scene.add(couch);
  const green = mat('#5f8f1d');
  add(couch, rbox(3.4, 0.55, 1.4, 0.16), green, [0, 0.55, 0]);
  add(couch, rbox(3.4, 1.2, 0.4, 0.18), green, [0, 1.2, -0.55]);
  add(couch, rbox(0.4, 0.9, 1.4, 0.16), green, [-1.7, 0.85, 0]);
  add(couch, rbox(0.8, 0.7, 0.25, 0.1), mat('#c81f82'), [-0.9, 1.15, -0.25], { rot: [-0.2, 0.1, 0.1] });
  const table = new THREE.Group(); table.position.set(6.8, 0, 1.4); scene.add(table);
  add(table, rbox(1.6, 0.12, 0.9, 0.04), mat('#7a3f22'), [0, 0.62, 0]);
  [[-0.65, -0.35], [0.65, -0.35], [-0.65, 0.35], [0.65, 0.35]].forEach(([x, z]) => add(table, new THREE.BoxGeometry(0.08, 0.6, 0.08), mat('#6a331b'), [x, 0.3, z]));
  add(table, new THREE.CylinderGeometry(0.1, 0.1, 0.14, 16), mat('#e9f3d8'), [0.3, 0.75, 0]);
  add(table, new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial({ color: '#ffd35a' }), [0.3, 0.86, 0], { cast: false });
  potPlant(9.6, 0, -3.3, 1.4);

  // rugs
  const rug = new THREE.MeshStandardMaterial({ map: rugTex(), roughness: 1 });
  add(scene, new THREE.CircleGeometry(2.4, 64), rug, [-6.4, 0.01, 1.4], { cast: false, receive: true, rot: [-Math.PI / 2, 0, 0] });
  add(scene, new THREE.CircleGeometry(2.6, 64), rug, [6.8, 0.01, 1.6], { cast: false, receive: true, rot: [-Math.PI / 2, 0, 0] });

  // mic stand
  micStand = new THREE.Group(); micStand.position.set(0, 0, 1.3); scene.add(micStand);
  const metal = mat('#1c1c1f', { metalness: 0.7, roughness: 0.35 });
  add(micStand, new THREE.CylinderGeometry(0.34, 0.38, 0.06, 32), metal, [0, 0.03, 0]);
  add(micStand, new THREE.CylinderGeometry(0.025, 0.025, 1.75), metal, [0, 0.9, 0]);
  add(micStand, new THREE.CapsuleGeometry(0.07, 0.18, 6, 12), mat('#3a3a3f', { metalness: 0.8, roughness: 0.3 }), [0, 1.85, 0.03], { rot: [0.35, 0, 0] });
}

function potPlant(x, y, z, s) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.scale.setScalar(s); scene.add(g);
  add(g, new THREE.CylinderGeometry(0.32, 0.24, 0.55, 20), mat('#d8cbb3'), [0, 0.27, 0]);
  const leaf = mat('#3f7a2c'), leaf2 = mat('#57963a');
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + Math.random() * 0.3;
    const l = add(g, new THREE.SphereGeometry(0.5, 12, 8), i % 2 ? leaf : leaf2, [Math.cos(a) * 0.22, 0.95, Math.sin(a) * 0.22], { scale: [0.16, 0.8, 0.05] });
    l.rotation.set(Math.sin(a) * 0.5, -a, Math.cos(a) * -0.5);
  }
}

const speakers = [];
function buildSpeaker(x, z, ry) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; scene.add(g);
  add(g, rbox(1.5, 2.3, 1.1, 0.1), mat('#7b3e22'), [0.12, 1.15, -0.18]);
  add(g, rbox(1.35, 2.2, 0.9, 0.12), mat('#a7b6de'), [0, 1.12, 0]);
  const cones = [];
  [[0.6, 0.42], [1.55, 0.26]].forEach(([y, r]) => {
    add(g, new THREE.CylinderGeometry(r + 0.06, r + 0.06, 0.06, 32), mat('#6d7896'), [0, y, 0.46], { rot: [Math.PI / 2, 0, 0] });
    const c = add(g, new THREE.CylinderGeometry(r, r * 0.6, 0.08, 32), mat('#25262d'), [0, y, 0.5], { rot: [Math.PI / 2, 0, 0] });
    add(c, new THREE.SphereGeometry(r * 0.3, 16, 12), mat('#3a3c45'), [0, -0.03, 0]);
    cones.push(c);
  });
  return { g, cones };
}

// ---------- characters ----------
export const LOOKS = [
  { shirt: '#e02b2b', pants: '#2350d8', skin: '#ffc865', hair: null, style: 'bald' },
  { shirt: '#2f6fe0', pants: '#39468a', skin: '#f2c29a', hair: '#7a3f1d', style: 'cap' },
  { shirt: '#23a55a', pants: '#2b3a55', skin: '#c68652', hair: '#1c1412', style: 'spiky' },
  { shirt: '#9b4dff', pants: '#2c2250', skin: '#f5d0b0', hair: '#e8b24a', style: 'bun' },
  { shirt: '#ff8a1f', pants: '#403021', skin: '#8d5a3b', hair: '#111', style: 'cap' },
  { shirt: '#18b8c9', pants: '#1f3d4d', skin: '#ffd9b8', hair: '#c2412c', style: 'spiky' },
];

const DEFAULT_LOOK = { shirt: '#2f6fe0', pants: '#39468a', skin: '#f2c29a', hair: '#7a3f1d', style: 'cap' };
function buildChar(lk) {
  const look = { ...DEFAULT_LOOK, ...(lk || {}) };
  if (look.style === 'bald') look.hair = null;
  const g = new THREE.Group();
  const skin = mat(look.skin), shirt = mat(look.shirt), pants = mat(look.pants);
  const glove = mat('#f3f3f3', { roughness: 0.5 }), dark = mat('#1d1414'), white = mat('#ffffff', { roughness: 0.25 });
  const legs = [];
  [-1, 1].forEach((s) => {
    const leg = new THREE.Group(); leg.position.set(s * 0.18, 0.78, 0); g.add(leg);
    add(leg, new THREE.CapsuleGeometry(0.15, 0.5, 6, 12), pants, [0, -0.36, 0]);
    add(leg, new THREE.SphereGeometry(0.17, 16, 12), mat('#3b2a22'), [0, -0.7, 0.07], { scale: [1, 0.55, 1.45] });
    legs.push(leg);
  });
  const body = new THREE.Group(); g.add(body);
  add(body, new THREE.CylinderGeometry(0.34, 0.33, 0.24, 24), pants, [0, 0.8, 0], { scale: [1, 1, 0.8] });
  add(body, new THREE.CapsuleGeometry(0.36, 0.45, 8, 16), shirt, [0, 1.15, 0], { scale: [1, 1, 0.78] });
  const arms = [];
  [-1, 1].forEach((s) => {
    const p = new THREE.Group(); p.position.set(s * 0.43, 1.45, 0); p.rotation.z = s * 0.2; body.add(p);
    add(p, new THREE.CapsuleGeometry(0.11, 0.5, 6, 12), shirt, [0, -0.32, 0]);
    add(p, new THREE.SphereGeometry(0.15, 16, 12), glove, [0, -0.7, 0.02], { scale: [1, 1.1, 0.9] });
    arms.push(p);
  });
  const head = new THREE.Group(); head.position.set(0, 2.0, 0); body.add(head);
  add(head, new THREE.SphereGeometry(0.42, 32, 24), skin, [0, 0, 0], { scale: [1, 1.03, 0.95] });
  [-1, 1].forEach((s) => add(head, new THREE.SphereGeometry(0.09, 12, 10), skin, [s * 0.41, -0.02, 0], { scale: [0.6, 1, 1] }));
  const eyes = [], brows = [];
  [-1, 1].forEach((s) => {
    add(head, new THREE.SphereGeometry(0.1, 20, 14), white, [s * 0.14, 0.07, 0.34], { scale: [1, 1.15, 0.8] });
    eyes.push(add(head, new THREE.SphereGeometry(0.05, 14, 10), dark, [s * 0.14, 0.06, 0.42]));
    const b = add(head, new THREE.BoxGeometry(0.16, 0.04, 0.03), dark, [s * 0.14, 0.23, 0.38], { rot: [0, 0, -s * 0.15] });
    b.userData.side = s;
    brows.push(b);
  });
  add(head, new THREE.SphereGeometry(0.06, 12, 10), skin, [0, -0.03, 0.42]);
  const smile = add(head, new THREE.TorusGeometry(0.1, 0.022, 8, 20, Math.PI), dark, [0, -0.13, 0.39], { rot: [0, 0, Math.PI] });
  const mouth = add(head, new THREE.SphereGeometry(0.1, 16, 12), mat('#5a0f14'), [0, -0.17, 0.37], { scale: [1.1, 0.1, 0.45] });
  if (look.hair) {
    const hair = mat(look.hair);
    add(head, new THREE.SphereGeometry(0.445, 32, 16, 0, TAU, 0, Math.PI * 0.42), hair, [0, 0.03, -0.03], { rot: [-0.25, 0, 0] });
    if (look.style === 'spiky') for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI - Math.PI / 2;
      add(head, new THREE.ConeGeometry(0.1, 0.3, 8), hair, [Math.sin(a) * 0.25, 0.4, -0.05 + Math.cos(a) * 0.08], { rot: [-0.3, 0, -a * 0.6] });
    }
    if (look.style === 'bun') add(head, new THREE.SphereGeometry(0.17, 16, 12), hair, [0, 0.45, -0.18]);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { g, body, head, arms, legs, eyes, brows, smile, mouth };
}

const chars = [];
let arrow, micStand, wheel;

const MIC_SPOT = V(0, 0, 0.7);
let lastPlayersKey = '';
// list: [{ id, name, look }] - rebuilt only when names/looks/order change.
// lobby (optional): { n, seats } - seat index per player so the party stands in a row, you in the middle.
export function setPlayers(list, lobby = null) {
  const key = JSON.stringify([list.map((p) => [p.id, p.name, p.look]), lobby]);
  if (lobby) seatN = lobby.n;
  if (key === lastPlayersKey) return;
  lastPlayersKey = key;
  chars.forEach((c) => scene.remove(c.root));
  chars.length = 0;
  const n = list.length;
  const spacing = n <= 4 ? 2.3 : n <= 6 ? 1.75 : 1.4;
  list.forEach((p, i) => {
    const parts = buildChar(typeof p.look === 'number' ? LOOKS[p.look % LOOKS.length] : p.look);
    const root = new THREE.Group();
    root.add(parts.g);
    const x = lobby ? seatX(lobby.seats[i]) : (i - (n - 1) / 2) * spacing;
    root.position.set(x, 0, -0.9);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex(p.name), transparent: true, depthWrite: false }));
    label.position.set(0, 2.85, 0); label.scale.set(1.6, 0.4, 1);
    label.visible = !lobbyOn; // the lobby shows HTML name tags instead
    root.add(label);
    const spk = new THREE.Sprite(new THREE.SpriteMaterial({ map: speakerTex(), transparent: true, depthWrite: false }));
    spk.position.set(0, 3.5, 0); spk.scale.set(0.42, 0.42, 1); spk.visible = false;
    root.add(spk);
    root.traverse((o) => { if (o.isMesh) o.userData.charIdx = i; });
    scene.add(root);
    chars.push({ root, ...parts, x, home: V(x, 0, -0.9), target: null, walkT: 0, label, spk, speaking: false, expr: 'neutral', singing: false, hover: false, talk: 0, mood: 'idle', moodT: 0, moodDur: 0, phase: Math.random() * TAU, glitch: false });
  });
}

// ---------- lobby: the party stands in a row ----------
// Players line up side by side (you in the middle); name tags and mic/speaker buttons are HTML
// overlays that follow each character on screen.
export const SEATS = 8;
const SEAT_GAP = 1.5, CHAR_TOP = 2.75; // head top incl. hair
let seatN = SEATS; // characters in the row
const seatX = (s) => (s - (seatN - 1) / 2) * SEAT_GAP;
let lobbyOn = false, lobbyFrame = { l: 0.2, r: 0.8, top: 0.15, feet: 0.7 };
export function setLobby(on) {
  lobbyOn = on;
  chars.forEach((c) => { c.label.visible = !on; });
}
// free box for the row, as 0..1 fractions of the screen: left/right edges, head line, feet line
export function setLobbyFrame(l, r, top, feet) { lobbyFrame = { l, r, top, feet }; if (view.name === 'lobby') viewTarget(); }
// screen position of a seat: centre x, head top, feet line, seat width (CSS px)
const _v = new THREE.Vector3();
function toScreen(x, y, z) {
  _v.set(x, y, z).project(camera);
  return { x: (_v.x + 1) / 2 * window.innerWidth, y: (1 - _v.y) / 2 * window.innerHeight };
}
export function seatScreen(s) {
  const x = seatX(s);
  const top = toScreen(x, CHAR_TOP, -0.9), feet = toScreen(x, 0, -0.9);
  const l = toScreen(x - SEAT_GAP / 2, 0, -0.9), r = toScreen(x + SEAT_GAP / 2, 0, -0.9);
  return { x: feet.x, top: top.y, feet: feet.y, w: r.x - l.x };
}

// ---------- spinner wheel ----------
// vector mic item for the wheel (emoji render too small/flat on the texture)
function drawMicIcon(g, sg) {
  const ink = '#2b1a1a';
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (sg.kind === 'swap') {
    g.strokeStyle = '#d98a00'; g.lineWidth = 11;
    [[-2.7, -0.7], [0.44, 2.44]].forEach(([a0, a1]) => {
      g.beginPath(); g.arc(0, -6, 50, a0, a1); g.stroke();
      const ax = Math.cos(a1) * 50, ay = Math.sin(a1) * 50 - 6, t = a1 + Math.PI / 2;
      g.fillStyle = '#d98a00'; g.beginPath();
      g.moveTo(ax + Math.cos(t) * 16, ay + Math.sin(t) * 16);
      g.lineTo(ax + Math.cos(t + 2.3) * 14, ay + Math.sin(t + 2.3) * 14);
      g.lineTo(ax + Math.cos(t - 2.3) * 14, ay + Math.sin(t - 2.3) * 14);
      g.closePath(); g.fill();
    });
  }
  const col = sg.sab === 'disturb' ? ['#ffb0b0', '#d2283a'] : sg.sab === 'crap' ? ['#ffffff', '#8f949e'] : ['#fff3b0', '#e8a012'];
  const gr = g.createLinearGradient(-24, 0, 24, 0); gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]);
  g.fillStyle = gr; g.strokeStyle = ink; g.lineWidth = 6;
  g.beginPath(); g.roundRect(-22, -52, 44, 64, 22); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(43,26,26,.55)'; g.lineWidth = 4;
  for (let y = -40; y <= 2; y += 10) { g.beginPath(); g.moveTo(-14, y); g.lineTo(14, y); g.stroke(); }
  g.strokeStyle = ink; g.lineWidth = 7;
  g.beginPath(); g.arc(0, -8, 34, 0.12 * Math.PI, 0.88 * Math.PI); g.stroke();
  g.beginPath(); g.moveTo(0, 26); g.lineTo(0, 44); g.moveTo(-16, 46); g.lineTo(16, 46); g.stroke();
  if (sg.sab === 'disturb') {
    g.fillStyle = '#ffe14d'; g.strokeStyle = '#b3001b'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(26, -64); g.lineTo(6, -26); g.lineTo(22, -26); g.lineTo(8, 6); g.lineTo(44, -36); g.lineTo(28, -36); g.lineTo(40, -64); g.closePath(); g.fill(); g.stroke();
  } else if (sg.sab === 'crap') {
    g.strokeStyle = '#3a2412'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(-10, -50); g.lineTo(-2, -34); g.lineTo(-12, -20); g.lineTo(0, -4); g.stroke();
    g.strokeStyle = '#6fbf3a'; g.lineWidth = 5;
    [-30, 30].forEach((x) => { g.beginPath(); g.moveTo(x, -40); g.bezierCurveTo(x - 10, -50, x + 10, -58, x, -70); g.stroke(); });
  }
}
function wheelTex(segs) {
  return canvasTex(1024, 1024, (g, w) => {
    const c = w / 2, R = w / 2 - 4, seg = TAU / segs.length;
    segs.forEach((sg, i) => {
      const hue = (i / segs.length) * 360;
      const gr = g.createRadialGradient(c, c, 80, c, c, R);
      gr.addColorStop(0, `hsl(${hue},90%,72%)`); gr.addColorStop(1, `hsl(${hue},85%,55%)`);
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(c, c); g.arc(c, c, R, i * seg, (i + 1) * seg); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 6; g.stroke();
      g.save(); g.translate(c, c); g.rotate((i + 0.5) * seg);
      // glass bubble: a gold star for bonuses, a mic item for the 3 sabotages
      const bx = R * 0.64;
      const tint = sg.sab === 'disturb' ? 'rgba(255,90,110,.55)' : sg.sab === 'crap' ? 'rgba(200,205,215,.6)' : sg.kind === 'swap' ? 'rgba(255,205,70,.6)' : 'rgba(255,255,255,.35)';
      g.fillStyle = tint; g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 6;
      g.beginPath(); g.arc(bx, 0, 62, 0, TAU); g.fill(); g.stroke();
      if (sg.icon) { g.save(); g.translate(bx, 0); g.rotate(Math.PI / 2); drawMicIcon(g, sg); g.restore(); }
      g.save(); g.translate(bx, 0); g.rotate(Math.PI / 2);
      if (sg.icon) g.scale(0.001, 0.001); // no star on item slots
      g.fillStyle = '#ffc62e'; g.strokeStyle = '#b87400'; g.lineWidth = 5;
      g.beginPath();
      for (let k = 0; k < 10; k++) { const r = k % 2 ? 20 : 44, a = (k / 10) * TAU - Math.PI / 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      g.closePath(); g.fill(); g.stroke();
      g.restore();
      // label towards the hub
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.font = `${sg.label.length > 5 ? 34 : 64}px "Lilita One"`;
      g.save(); g.translate(R * 0.38, 0);
      g.strokeStyle = 'rgba(40,10,40,.85)'; g.lineWidth = 10; g.strokeText(sg.label, 0, 0);
      g.fillStyle = '#fff'; g.fillText(sg.label, 0, 0);
      g.restore();
      g.restore();
    });
  });
}
function buildWheel() {
  const grp = new THREE.Group(); grp.position.set(0, 2.55, 0.9); grp.visible = false; scene.add(grp);
  const gold = mat('#ffc933', { metalness: 0.55, roughness: 0.3 });
  add(grp, new THREE.CylinderGeometry(2.08, 2.08, 0.3, 64), mat('#c2185b'), [0, 0, -0.12], { rot: [Math.PI / 2, 0, 0] });
  add(grp, new THREE.TorusGeometry(2.0, 0.13, 14, 96), mat('#ff3d7f', { roughness: 0.4 }), [0, 0, 0.06]);
  const bulbs = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    bulbs.push(add(grp, new THREE.SphereGeometry(0.075, 12, 8), new THREE.MeshBasicMaterial({ color: '#fff3b0', toneMapped: false }), [Math.cos(a) * 2.0, Math.sin(a) * 2.0, 0.16], { cast: false }));
  }
  const spinner = new THREE.Group(); grp.add(spinner);
  const face = add(spinner, new THREE.CircleGeometry(1.88, 96), new THREE.MeshStandardMaterial({ roughness: 0.4 }), [0, 0, 0.05], { cast: false });
  const pegs = new THREE.Group(); spinner.add(pegs);
  add(spinner, new THREE.CylinderGeometry(0.34, 0.34, 0.18, 32), gold, [0, 0, 0.12], { rot: [Math.PI / 2, 0, 0] });
  const star = new THREE.Shape();
  for (let k = 0; k < 10; k++) { const r = k % 2 ? 0.12 : 0.27, a = (k / 10) * TAU + Math.PI / 2; k ? star.lineTo(Math.cos(a) * r, Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
  add(spinner, new THREE.ExtrudeGeometry(star, { depth: 0.06, bevelEnabled: false }), mat('#ff7a1a', { roughness: 0.4 }), [0, 0, 0.21]);
  // map-pin pointer on top
  const pointer = new THREE.Group(); pointer.position.set(0, 2.2, 0.3); grp.add(pointer);
  add(pointer, new THREE.SphereGeometry(0.2, 20, 16), mat('#ffcf2e', { roughness: 0.35 }), [0, 0.12, 0]);
  add(pointer, new THREE.ConeGeometry(0.17, 0.36, 20), mat('#ffcf2e', { roughness: 0.35 }), [0, -0.16, 0], { rot: [0, 0, Math.PI] });
  add(pointer, new THREE.SphereGeometry(0.08, 12, 10), mat('#c46a00'), [0, 0.14, 0.16]);
  const lamp = new THREE.PointLight('#ffe0a0', 10, 7, 1.5); lamp.position.set(0, 0, 2.5); grp.add(lamp);
  wheel = { grp, spinner, face, pegs, pointer, bulbs, segs: [], spinning: false, scale: 0, target: 0, flap: 0 };
}
export function setWheelSegments(segs) {
  wheel.segs = segs;
  if (wheel.face.material.map) wheel.face.material.map.dispose();
  wheel.face.material.map = wheelTex(segs);
  wheel.face.material.needsUpdate = true;
  wheel.pegs.clear();
  const seg = TAU / segs.length;
  segs.forEach((_, i) => add(wheel.pegs, new THREE.SphereGeometry(0.06, 12, 8), mat('#ffffff'), [Math.cos(-i * seg) * 1.8, Math.sin(-i * seg) * 1.8, 0.1]));
}
export function showWheel(on) {
  wheel.target = on ? 1 : 0;
  if (on) wheel.grp.visible = true;
}
export function spinWheel(index, onTick) {
  return new Promise((resolve) => {
    const n = wheel.segs.length, seg = TAU / n;
    const R0 = wheel.spinner.rotation.z;
    const jitter = (Math.random() - 0.5) * seg * 0.6;
    let R = Math.PI / 2 + (index + 0.5) * seg + jitter;
    R += Math.ceil((R0 - R) / TAU) * TAU + TAU * (5 + Math.floor(Math.random() * 2));
    const dur = 4.6, t0 = performance.now();
    let lastSeg = Math.floor(R0 / seg);
    wheel.spinning = true;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 1000 / dur);
      const e = 1 - (1 - t) ** 4;
      wheel.spinner.rotation.z = R0 + (R - R0) * e;
      const s = Math.floor(wheel.spinner.rotation.z / seg);
      if (s !== lastSeg) { lastSeg = s; wheel.flap = 1; onTick && onTick(); }
      if (t < 1) requestAnimationFrame(step);
      else { wheel.spinning = false; resolve(); }
    };
    step();
    // rAF pauses in hidden tabs - never leave the game waiting on it
    setTimeout(() => { wheel.spinner.rotation.z = R; wheel.spinning = false; resolve(); }, dur * 1000 + 80);
  });
}

// ---------- confetti ----------
let confettiMesh, confettiData = [];
function buildConfetti() {
  const count = 320;
  confettiMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.09, 0.16), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), count);
  const colors = ['#ff4f9a', '#ffcf3a', '#4aa3ff', '#46e0c3', '#9b5cff', '#ffffff'];
  for (let i = 0; i < count; i++) {
    confettiMesh.setColorAt(i, new THREE.Color(colors[i % colors.length]));
    confettiData.push({ p: V(0, -10, 0), v: V(0, 0, 0), r: V(Math.random() * 6, Math.random() * 6, 0), life: 0 });
  }
  confettiMesh.frustumCulled = false;
  scene.add(confettiMesh);
}
export function confetti(x = 0) {
  confettiData.forEach((c) => {
    c.p.set(x + (Math.random() - 0.5) * 2, 2.5 + Math.random(), -0.5 + Math.random());
    c.v.set((Math.random() - 0.5) * 7, 4 + Math.random() * 6, (Math.random() - 0.2) * 4);
    c.life = 3.5 + Math.random() * 1.5;
  });
}

// ---------- camera ----------
const cam = { pos: V(0, 4.5, 15), look: V(0, 2.6, -2), tPos: V(0, 4.5, 15), tLook: V(0, 2.6, -2), speed: 2.2 };
let view = { name: 'lobby', idx: 0 };
function viewTarget() {
  const aspect = window.innerWidth / window.innerHeight;
  const k = Math.min(2.3, Math.max(1, 1.55 / aspect));
  let pos, look;
  switch (view.name) {
    case 'player': {
      const c = chars[view.idx];
      const x = c ? c.root.position.x : 0;
      const side = x > 3 ? 1 : -1;
      pos = V(x + side * 1.2 * Math.min(k, 1.3), 2.4, 4.6 * Math.min(k, 1.5)); look = V(x - side * 0.25, 1.75, -0.9);
      if (aspect < 1) { pos = V(x, 2.7, 7.4); look = V(x, 0.7, -0.9); }
      break;
    }
    case 'result': {
      const x = chars[view.idx] ? chars[view.idx].root.position.x : 0;
      if (aspect < 1.2) { pos = V(x, 3.0, 7.6); look = V(x, 0.2, -0.9); }
      else { pos = V(x + 1.5, 2.3, 5.4); look = V(x + 2.1, 1.7, -0.9); }
      break;
    }
    case 'stage': pos = V(0, 2.45, 6.2); look = V(0, 1.55, 0.2); break;
    case 'self':
    case 'selfClose': {
      // countdown dolly: straight at your own character, pushing in while recording
      const x = chars[view.idx] ? chars[view.idx].home.x : 0;
      const near = view.name === 'selfClose';
      pos = V(x + (x > 0 ? -0.5 : 0.5), near ? 2.25 : 2.45, near ? 2.7 : 3.6); look = V(x, near ? 1.95 : 1.85, -0.9);
      break;
    }
    case 'punch': pos = V(0, 2.2, 4.3); look = V(0, 1.75, 0.5); break;
    case 'wheelZoom': pos = V(0, 1.85, 4.4); look = V(0, 1.55, 0.9); break;
    case 'profile': pos = V(1.2, 2.1, 5.2); look = V(-0.9, 1.35, -0.9); break;
    case 'wheel': pos = V(0, 3.4, 11.4); look = V(0, 2.5, -0.6); break;
    case 'finale': pos = V(0, 2.6, 7.2); look = V(0, 1.7, -0.5); break;
    case 'overview': pos = V(0, 3.6, 12.2); look = V(0, 2.3, -1.2); break;
    case 'lobby': {
      // frame the party row inside the free space between the lobby side panels
      // wide enough for the whole row, tall enough that heads stay under the title
      const f = lobbyFrame;
      // framed for at least 5 so a small party doesn't turn into giants
      const vis = Math.max((Math.max(5, seatN) * SEAT_GAP) / Math.max(0.2, f.r - f.l), ((CHAR_TOP + 0.2) / Math.max(0.2, f.feet - f.top)) * aspect);
      const d = vis / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect);
      const cx = -((f.l + f.r) / 2 - 0.5) * vis;
      const ly = (f.feet - 0.5) * (vis / aspect); // puts the feet on the feet line
      pos = V(cx, ly + 0.15, -0.9 + d); look = V(cx, ly, -0.9); // near-level so the framing maths holds
      break;
    }
    default: pos = V(0, 4.4, 14.5); look = V(0, 2.7, -2);
  }
  if (!['player', 'result', 'self', 'selfClose', 'punch', 'wheelZoom', 'lobby'].includes(view.name)) pos = look.clone().add(pos.clone().sub(look).multiplyScalar(k));
  cam.tPos.copy(pos); cam.tLook.copy(look);
}
export function setView(name, idx = 0) { view = { name, idx }; viewTarget(); }

// ---------- per-frame ----------
let mouse = { x: 0, y: 0 };
let activeIdx = -1, speakerLevel = 0, micTarget = 0;
export function setActive(i) {
  activeIdx = i;

}
export function setTalk(i, level) { if (chars[i]) chars[i].talk = level; }
export function setMood(i, mood, dur = 2) { const c = chars[i]; if (c) { c.mood = mood; c.moodT = 0; c.moodDur = dur; } }
export function setGlitch(i, on) { if (chars[i]) chars[i].glitch = on; }
export function setSpeaker(level) { speakerLevel = level; }
export const charX = (i) => (chars[i] ? chars[i].root.position.x : 0);
export function setSpeaking(i, on) { if (chars[i]) chars[i].speaking = on; }
export function setExpr(i, expr) { if (chars[i]) chars[i].expr = expr; }
export function setSinging(i, on) { if (chars[i]) chars[i].singing = on; }

// ---------- pick a character with the mouse (sabotage / swap targets) ----------
const ray = new THREE.Raycaster();
let pick = null;
function charAt(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera({ x: ((ev.clientX - r.left) / r.width) * 2 - 1, y: -((ev.clientY - r.top) / r.height) * 2 + 1 }, camera);
  const hits = ray.intersectObjects(chars.map((c) => c.root), true);
  const h = hits.find((x) => x.object.userData.charIdx !== undefined);
  return h ? h.object.userData.charIdx : -1;
}
export function startPick(allowed, onPick) {
  pick = { allowed: new Set(allowed), onPick };
}
export function stopPick() {
  pick = null;
  chars.forEach((c) => { c.hover = false; });
  renderer.domElement.style.cursor = '';
}

// ---------- dust puffs under walking feet ----------
const dust = [];
let dustMat = null;
function puff(pos) {
  if (!dustMat) dustMat = new THREE.SpriteMaterial({ map: dustTex(), transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(dustMat.clone());
  sp.position.set(pos.x + (Math.random() - 0.5) * 0.3, 0.12, pos.z + (Math.random() - 0.5) * 0.2);
  sp.scale.setScalar(0.3);
  scene.add(sp);
  dust.push({ sp, life: 0.7 });
}
let stepHook = null, hitHook = null;
export function setHooks({ onStep, onHit }) { stepHook = onStep; hitHook = onHit; }
export function walkToMic(i) { const c = chars[i]; if (c) c.target = MIC_SPOT.clone(); }
export function walkHome(i) { const c = chars[i]; if (c) c.target = c.home.clone(); }
export function allHome() { chars.forEach((c) => { c.root.position.copy(c.home); c.target = null; c.root.rotation.y = 0; }); }

// ---------- throwables ----------
const items = [];
function makeItem(kind) {
  const g = new THREE.Group();
  if (kind === 'bottle') {
    const glass = new THREE.MeshStandardMaterial({ color: '#8fdcff', transparent: true, opacity: 0.8, roughness: 0.1, metalness: 0.1 });
    add(g, new THREE.CylinderGeometry(0.08, 0.08, 0.3, 16), glass, [0, 0, 0]);
    add(g, new THREE.CylinderGeometry(0.04, 0.08, 0.08, 16), glass, [0, 0.19, 0]);
    add(g, new THREE.CylinderGeometry(0.042, 0.042, 0.05, 12), mat('#ffffff'), [0, 0.25, 0]);
    add(g, new THREE.CylinderGeometry(0.083, 0.083, 0.1, 16), mat('#1f7be0'), [0, -0.02, 0]);
  } else if (kind === 'shoe') {
    add(g, rbox(0.2, 0.14, 0.36, 0.06), mat('#e8413a'), [0, 0.02, 0]);
    add(g, rbox(0.18, 0.12, 0.16, 0.05), mat('#e8413a'), [0, 0.1, -0.08]);
    add(g, new THREE.BoxGeometry(0.22, 0.05, 0.4), mat('#fafafa'), [0, -0.07, 0]);
    for (let k = 0; k < 3; k++) add(g, new THREE.BoxGeometry(0.12, 0.015, 0.02), mat('#ffffff'), [0, 0.1, 0.02 + k * 0.05]);
  } else {
    const st = add(g, new THREE.DodecahedronGeometry(0.12, 0), new THREE.MeshStandardMaterial({ color: '#8d877f', roughness: 1, flatShading: true }));
    st.scale.set(1, 0.8, 1.1);
  }
  g.scale.setScalar(1.5);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}
export function throwItem(fromIdx, toIdx, kind) {
  const target = chars[toIdx];
  if (!target) return;
  const from = chars[fromIdx];
  let p0;
  if (from && from !== target) {
    p0 = from.root.position.clone().add(V(0.4, 1.9, 0.2));
    from.mood = 'throw'; from.moodT = 0; from.moodDur = 0.45;
  } else {
    p0 = V((Math.random() - 0.5) * 8, 1.2 + Math.random(), 7);
  }
  const g = makeItem(kind);
  g.position.copy(p0);
  scene.add(g);
  items.push({ g, kind, p0, p1: V(0, 0, 0), t: 0, dur: 0.5 + Math.random() * 0.15, arc: 1 + Math.random() * 0.6, target, state: 'fly', v: V(0, 0, 0), spin: V(Math.random() * 14, Math.random() * 14, Math.random() * 8), life: 7, off: (Math.random() - 0.5) * 0.3 });
}
function updateItems(dt) {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    it.g.rotation.x += it.spin.x * dt; it.g.rotation.y += it.spin.y * dt; it.g.rotation.z += it.spin.z * dt;
    if (it.state === 'fly') {
      it.t += dt / it.dur;
      const t = Math.min(1, it.t);
      it.p1.copy(it.target.root.position).add(V(it.off, 2.05, 0.1));
      it.g.position.lerpVectors(it.p0, it.p1, t);
      it.g.position.y += Math.sin(t * Math.PI) * it.arc;
      if (t >= 1) {
        it.state = 'fall';
        it.v.set((Math.random() - 0.5) * 3, 2.5 + Math.random() * 1.5, 1.5 + Math.random() * 2);
        it.spin.multiplyScalar(0.6);
        it.target.mood = 'hit'; it.target.moodT = 0; it.target.moodDur = 0.55;
        if (hitHook) hitHook(it.kind);
      }
    } else {
      it.life -= dt;
      if (it.g.position.y > 0.12 || it.v.y > 0) {
        it.v.y -= 12 * dt;
        it.g.position.addScaledVector(it.v, dt);
        if (it.g.position.y < 0.12) {
          it.g.position.y = 0.12;
          if (Math.abs(it.v.y) > 1.5) { it.v.y *= -0.35; it.v.x *= 0.6; it.v.z *= 0.6; }
          else { it.v.set(0, 0, 0); it.spin.set(0, 0, 0); }
        }
      }
      if (it.life < 1) it.g.scale.setScalar(1.5 * Math.max(0.01, it.life));
      if (it.life <= 0) { scene.remove(it.g); items.splice(k, 1); }
    }
  }
}

function update(dt, t) {
  cam.pos.lerp(cam.tPos, 1 - Math.exp(-dt * cam.speed));
  cam.look.lerp(cam.tLook, 1 - Math.exp(-dt * cam.speed));
  camera.position.copy(cam.pos).add(V(mouse.x * 0.25, mouse.y * 0.12, 0));
  camera.lookAt(cam.look);

  chars.forEach((c, i) => {
    const ph = c.phase;
    c.moodT += dt;
    // walking
    let walking = false;
    if (c.target) {
      const d = c.target.clone().sub(c.root.position); d.y = 0;
      const dist = d.length();
      if (dist > 0.03) {
        walking = true;
        c.root.position.addScaledVector(d.normalize(), Math.min(dist, 2.6 * dt));
        const want = Math.atan2(d.x, d.z);
        c.root.rotation.y += Math.atan2(Math.sin(want - c.root.rotation.y), Math.cos(want - c.root.rotation.y)) * Math.min(1, dt * 10);
        const prev = Math.sin(c.walkT * 10);
        c.walkT += dt;
        if (Math.sign(prev) !== Math.sign(Math.sin(c.walkT * 10))) { if (stepHook) stepHook(); puff(c.root.position); }
      } else {
        c.root.rotation.y *= Math.max(0, 1 - dt * 8);
        if (Math.abs(c.root.rotation.y) < 0.01) { c.root.rotation.y = 0; c.target = null; }
      }
    }
    const swing = walking ? Math.sin(c.walkT * 10) : 0;
    c.legs[0].rotation.x = lerp(c.legs[0].rotation.x, swing * 0.6, 0.3);
    c.legs[1].rotation.x = lerp(c.legs[1].rotation.x, -swing * 0.6, 0.3);
    if (c.mood !== 'idle' && c.mood !== 'win' && c.moodT > c.moodDur) c.mood = 'idle';
    let y = Math.sin(t * 2 + ph) * 0.012, armZ = 0.2, armX = Math.sin(t * 1.6 + ph) * 0.06, headX = 0, headZ = Math.sin(t * 1.3 + ph) * 0.05;
    const talk = c.talk;
    c.mouth.scale.y = lerp(c.mouth.scale.y, 0.1 + Math.min(1, talk * 1.2), 0.5);
    c.smile.visible = talk < 0.12;
    headX -= talk * 0.18;
    if (talk > 0.05) { y += Math.abs(Math.sin(t * 14)) * talk * 0.06; armX -= talk * 0.5; }
    if (c.mood === 'happy' || c.mood === 'win') {
      y = Math.abs(Math.sin(c.moodT * 8)) * 0.45; armZ = 2.5 + Math.sin(c.moodT * 16) * 0.2; headX = -0.15;
    } else if (c.mood === 'sad') {
      headX = 0.4; armZ = 0.05; y = -0.04; headZ = Math.sin(c.moodT * 3) * 0.2;
    } else if (c.mood === 'hit') {
      const k = 1 - c.moodT / c.moodDur;
      headX = -0.7 * k; headZ = Math.sin(c.moodT * 40) * 0.3 * k; armZ = 1.2 * k + 0.2; y = -0.05 * k;
    } else if (c.mood === 'throw') {
      c.arms[1].rotation.x = -2.6 + (c.moodT / c.moodDur) * 3.2;
    } else if (c.mood === 'wave') {
      c.arms[1].rotation.z = 2.6 + Math.sin(c.moodT * 10) * 0.35;
    }
    c.g.position.y = y + (walking ? Math.abs(swing) * 0.05 : 0);
    c.head.rotation.x = lerp(c.head.rotation.x, headX, 0.2);
    c.head.rotation.z = headZ;
    c.arms.forEach((a, k) => {
      const s = k === 0 ? -1 : 1;
      if ((c.mood === 'wave' || c.mood === 'throw' || c.singing) && k === 1) return;
      a.rotation.z = lerp(a.rotation.z, s * armZ, 0.2);
      a.rotation.x = walking ? (k ? -swing : swing) * 0.5 : armX;
    });
    // hand-to-mouth "singing" pose while their take plays at the mic
    if (c.singing) {
      c.arms[1].rotation.x = lerp(c.arms[1].rotation.x, -2.25, 0.25);
      c.arms[1].rotation.z = lerp(c.arms[1].rotation.z, -0.35, 0.25);
    }
    // eyebrows show the mood
    const ex = c.mood === 'happy' || c.mood === 'win' ? 'happy' : c.mood === 'sad' || c.mood === 'hit' ? 'sad' : c.expr;
    c.brows.forEach((b) => {
      const sd = b.userData.side;
      const rz = ex === 'angry' ? sd * 0.45 : ex === 'sad' ? -sd * 0.4 : ex === 'happy' ? -sd * 0.1 : -sd * 0.15;
      const by = ex === 'happy' ? 0.27 : ex === 'angry' ? 0.2 : 0.23;
      b.rotation.z = lerp(b.rotation.z, rz, 0.2);
      b.position.y = lerp(b.position.y, by, 0.2);
    });
    c.spk.visible = c.speaking;
    if (c.speaking) c.spk.scale.setScalar(0.42 + Math.sin(t * 12) * 0.03);
    const hs = c.hover ? 1.08 : 1;
    c.root.scale.setScalar(lerp(c.root.scale.x, hs, 0.25));
    c.g.position.x = c.glitch ? (Math.random() - 0.5) * 0.1 : 0;
    c.g.rotation.y = c.glitch ? (Math.random() - 0.5) * 0.3 : lerp(c.g.rotation.y, 0, 0.1);
    // eyes follow camera a bit
    const lookX = THREE.MathUtils.clamp((camera.position.x - c.root.position.x) * 0.01, -0.03, 0.03);
    c.eyes.forEach((e, k) => { e.position.x = (k ? 0.14 : -0.14) + lookX; });
    c.label.material.opacity = view.name === 'player' && i !== activeIdx ? 0.25 : 1;
  });

  if (activeIdx >= 0 && chars[activeIdx]) {
    arrow.visible = true;
    const ap = chars[activeIdx].root.position;
    arrow.position.set(ap.x, 3.12 + Math.sin(t * 5) * 0.06, ap.z);
    arrow.rotation.y = t * 2;
  } else arrow.visible = false;
  updateItems(dt);
  for (let k = dust.length - 1; k >= 0; k--) {
    const d = dust[k];
    d.life -= dt;
    d.sp.scale.setScalar(0.3 + (0.7 - d.life) * 1.2);
    d.sp.position.y += dt * 0.3;
    d.sp.material.opacity = Math.max(0, d.life / 0.7) * 0.8;
    if (d.life <= 0) { scene.remove(d.sp); dust.splice(k, 1); }
  }
  micStand.visible = wheel.scale < 0.3 && !lobbyOn; // the stand would poke through the wheel / stand in front of the party
  wheel.bulbs.forEach((b, k) => b.material.color.set((Math.floor(t * 6) + k) % 2 ? '#fff3b0' : '#ffb347'));

  const lv = Math.min(1, speakerLevel * 4);
  speakers.forEach((s) => s.cones.forEach((c, k) => c.scale.setScalar(1 + lv * (k ? 0.08 : 0.16) * (0.7 + Math.random() * 0.3))));

  wheel.scale = lerp(wheel.scale, wheel.target, 1 - Math.exp(-dt * 7));
  wheel.grp.scale.setScalar(Math.max(0.001, wheel.scale));
  wheel.grp.visible = wheel.scale > 0.01;
  if (!wheel.spinning && wheel.grp.visible) wheel.spinner.rotation.z += Math.sin(t * 1.5) * 0.0015;
  wheel.flap = Math.max(0, wheel.flap - dt * 8);
  wheel.pointer.rotation.z = wheel.flap * 0.35;

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = V(1, 1, 1);
  confettiData.forEach((c, i) => {
    if (c.life > 0) {
      c.life -= dt;
      c.v.y -= 9 * dt; c.v.multiplyScalar(0.985);
      c.p.addScaledVector(c.v, dt);
      if (c.p.y < 0.02) { c.p.y = 0.02; c.v.set(0, 0, 0); }
      c.r.x += dt * 8; c.r.y += dt * 5;
    }
    e.set(c.r.x, c.r.y, 0); q.setFromEuler(e);
    m4.compose(c.life > 0 ? c.p : V(0, -50, 0), q, one);
    confettiMesh.setMatrixAt(i, m4);
  });
  confettiMesh.instanceMatrix.needsUpdate = true;
}

export async function initScene(canvas) {
  await Promise.all([document.fonts.load('80px "Lilita One"'), document.fonts.load('600 40px "Fredoka"')]).catch(() => {});
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#2a1212');
  scene.fog = new THREE.Fog('#2a1212', 18, 34);
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

  scene.add(new THREE.HemisphereLight('#ffe0c4', '#3a1a12', 0.9));
  const key = new THREE.DirectionalLight('#fff0dd', 1.5);
  key.position.set(3, 9, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -11, right: 11, top: 8, bottom: -3, near: 1, far: 30 });
  key.shadow.bias = -0.0005;
  key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.PointLight('#ff9a6a', 20, 18, 1.5); fill.position.set(0, 3, 6); scene.add(fill);

  buildRoom();
  buildWheel();
  buildConfetti();
  arrow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.2, 4), new THREE.MeshBasicMaterial({ color: '#fff4dc' }));
  arrow.rotation.x = Math.PI;
  scene.add(arrow);

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 50 : 38;
    camera.updateProjectionMatrix();
    viewTarget();
  };
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (e) => {
    mouse.x = (e.clientX / window.innerWidth - 0.5) * 2;
    mouse.y = (e.clientY / window.innerHeight - 0.5) * -2;
    if (!pick) return;
    const i = charAt(e);
    chars.forEach((c, k) => { c.hover = k === i && pick.allowed.has(k); });
    renderer.domElement.style.cursor = i >= 0 && pick.allowed.has(i) ? 'pointer' : '';
  });
  canvas.addEventListener('click', (e) => {
    if (!pick) return;
    const i = charAt(e);
    if (i >= 0 && pick.allowed.has(i)) { const cb = pick.onPick; stopPick(); cb(i); }
  });
  resize();
  cam.pos.copy(cam.tPos); cam.look.copy(cam.tLook);

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    update(dt, clock.elapsedTime);
    renderer.render(scene, camera);
  });
}
