// Data shared by the browser client and the Node server (no DOM / audio code here).

export const ROUNDS = 10;
export const MAX_PLAYERS = 8;

// seconds of recording a player gets for a demo of `dur` seconds
// the take is exactly as long as the demo: the playhead stops at the end of the demo wave
export const recDurFor = (dur) => Math.min(8, Math.max(0.6, dur));
export const GAP_AFTER_DEMO = 3.0; // 3-2-1 countdown between the demo and the recording

// 10 wheel slots: 7 bonus stars + the 3 sabotage items (like the reference wheel)
export const SEG = {
  p1: { label: '+1', kind: 'add', value: 1, title: '+1 BONUS', desc: '1 point added to your next imitation. Wow.' },
  p5: { label: '+5', kind: 'add', value: 5, title: '+5 BONUS', desc: '5 points added to your next imitation.' },
  p10: { label: '+10', kind: 'add', value: 10, title: 'BONUS', desc: '10 points added to your next imitation.' },
  p20: { label: '+20', kind: 'add', value: 20, title: 'BIG BONUS', desc: '20 points added to your next imitation.' },
  x15: { label: '×1.5', kind: 'mult', value: 1.5, title: '×1.5', desc: 'Your next imitation score is multiplied by 1.5.' },
  swap: { label: 'SWAP', kind: 'swap', icon: '🔄', title: 'SWAP', desc: 'Pick a player: you trade next takes, scores included.' },
  disturb: { label: 'DISTURB', kind: 'sabotage', sab: 'disturb', icon: '⚡', title: 'MIC DISTURB', desc: 'Pick someone to sabotage: static + cut-outs on their next take.' },
  crap: { label: 'CRAP MIC', kind: 'sabotage', sab: 'crap', icon: '💩', title: 'CRAP MIC', desc: 'Pick someone to sabotage: their next take sounds like a cheap, broken mic.' },
};
export const SEGMENTS = [SEG.p1, SEG.disturb, SEG.p10, SEG.crap, SEG.p5, SEG.swap, SEG.p20, SEG.x15, SEG.p5, SEG.p10];
export const segmentsFor = () => SEGMENTS; // solo games still show the sabotage slots (they turn into +5)
export const ROUND_OPTIONS = [5, 7, 10];

export const LOOK_OPTIONS = {
  skin: ['#ffd9b8', '#f5c79a', '#e0a878', '#c68652', '#8d5a3b', '#5e3b26', '#ffc865'],
  shirt: ['#e02b2b', '#2f6fe0', '#23a55a', '#9b4dff', '#ff8a1f', '#18b8c9', '#ff5fa2', '#f2d024', '#333842'],
  pants: ['#2350d8', '#39468a', '#2b3a55', '#2c2250', '#403021', '#1f3d4d', '#5a5f6b'],
  hair: ['#1c1412', '#7a3f1d', '#e8b24a', '#c2412c', '#8e8e98', '#ff5fa2', '#3fa7ff'],
  style: ['cap', 'spiky', 'bun', 'bald'],
};
export function randomLook() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return { skin: pick(LOOK_OPTIONS.skin), shirt: pick(LOOK_OPTIONS.shirt), pants: pick(LOOK_OPTIONS.pants), hair: pick(LOOK_OPTIONS.hair), style: pick(LOOK_OPTIONS.style) };
}

export const THROWABLES = [
  { kind: 'bottle', icon: '🍾', label: 'Water bottle' },
  { kind: 'shoe', icon: '👟', label: 'Shoe' },
  { kind: 'stone', icon: '🪨', label: 'Stone' },
];
// how many items the crowd auto-throws at a bad mimic
export function autoVolley(pct) {
  if (pct >= 50) return [];
  if (pct >= 30) return ['bottle', 'bottle'];
  if (pct >= 15) return ['bottle', 'shoe', 'bottle', 'shoe'];
  return ['stone', 'shoe', 'bottle', 'stone', 'shoe', 'stone'];
}
