// The rose window. Every passage gets its own: the outer ring has one pane per
// verse, the glass is coloured for the part of the Bible the passage comes
// from, and the tracery inside is drawn from a seed taken from the reference.

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2;
const LEAD = '#04050c';

export const GENRES = {
  law: { place: 'the Law', glass: ['#e8b04a', '#d4613a', '#8f2f3a', '#f4e4b4', '#3f5f8c'] },
  history: { place: 'the histories', glass: ['#35a876', '#cf9a33', '#2466a0', '#ecdfb6', '#8a4634'] },
  wisdom: { place: 'the wisdom books', glass: ['#4d86ea', '#86cdf5', '#f1d384', '#3443ad', '#c0cbef'] },
  prophets: { place: 'the Prophets', glass: ['#d23a4c', '#f08f3f', '#6a3396', '#f3d8a2', '#2d4d7c'] },
  gospels: { place: 'the Gospels', glass: ['#f0c24f', '#fdf0cc', '#3d7bdc', '#c9404e', '#31a388'] },
  letters: { place: 'the Letters', glass: ['#25b0a6', '#e8a63e', '#3a5db2', '#f1e5c4', '#994676'] },
  apocalyptic: { place: 'Revelation', glass: ['#9a5ce0', '#de3350', '#f2c84c', '#3136a0', '#e7dfff'] },
};

// Ring radii, as fractions of the window's radius.
const R = {
  rim: 0.975,
  verseOuter: 0.955,
  verseSplit: 0.872,
  verseInner: 0.76,
  petalOuter: 0.735,
  petalInner: 0.3,
  hubOuter: 0.285,
  hubInner: 0.155,
  centre: 0.14,
  core: 0.062,
};

const BAND = { low: 0, mid: 1, high: 2 };
const RESTING_PANES = 24; // outer panes of the window shown before any passage is open

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const polar = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function sector(r0, r1, a0, a1) {
  const path = new Path2D();
  path.arc(0, 0, r1, a0, a1);
  path.arc(0, 0, r0, a1, a0, true);
  path.closePath();
  return path;
}

function ring(r0, r1) {
  const path = new Path2D();
  path.arc(0, 0, r1, 0, TAU);
  path.moveTo(r0, 0);
  path.arc(0, 0, r0, TAU, 0, true);
  return path;
}

function disc(x, y, r) {
  const path = new Path2D();
  path.arc(x, y, r, 0, TAU);
  return path;
}

// A pointed petal standing on the circle r0 and reaching to r1.
function petal(r0, r1, angle, halfWidth) {
  const bulge = r0 + (r1 - r0) * 0.86;
  const path = new Path2D();
  path.moveTo(...polar(r0, angle - halfWidth));
  path.quadraticCurveTo(...polar(bulge, angle - halfWidth * 0.86), ...polar(r1, angle));
  path.quadraticCurveTo(...polar(bulge, angle + halfWidth * 0.86), ...polar(r0, angle + halfWidth));
  path.arc(0, 0, r0, angle + halfWidth, angle - halfWidth, true);
  path.closePath();
  return path;
}

function buildPanes({ verses, seed, glass }) {
  const rng = mulberry32(seed);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const [g0, g1, g2, g3, g4] = glass;
  const panes = [];

  const add = (path, hex, ring, band, order, extra = {}) => {
    const tone = 0.9 + rng() * 0.2; // hand-made glass is never one even colour
    panes.push({
      path,
      rgb: hexRgb(hex).map((c) => Math.min(255, c * tone)),
      ring,
      band,
      order,
      angle: 0,
      lit: 0,
      phase: rng() * TAU,
      speed: 0.25 + rng() * 0.5,
      ...extra,
    });
  };

  // Outer ring: one pane per verse, clockwise from the top, each in two pieces.
  const count = verses.length;
  const step = TAU / count;
  const caps = count % 2 === 0 ? [g3, g1] : [g3];
  verses.forEach((verse, i) => {
    const a0 = TOP + i * step;
    const a1 = a0 + step;
    const extra = { verse, angle: a0 + step / 2 };
    add(sector(R.verseInner, R.verseSplit, a0, a1), g0, 'verse', BAND.high, 0, extra);
    add(sector(R.verseSplit, R.verseOuter, a0, a1), caps[i % caps.length], 'verse', BAND.high, 0, extra);
  });

  // The rose itself.
  const petals = pick([6, 8, 8, 10, 12, 12]);
  const half = Math.PI / petals;
  const turn = TOP + (rng() < 0.5 ? 0 : half);
  const [petalA, petalB] = pick([[g1, g2], [g2, g4], [g1, g4], [g2, g1]]);
  const fill = pick([g4, g3, g2].filter((c) => c !== petalA && c !== petalB));
  const second = rng() < 0.6;
  const roundels = rng() < 0.7;

  add(ring(R.petalInner, R.petalOuter), fill, 'rose', BAND.mid, 0.72);
  for (let i = 0; i < petals; i++) {
    const angle = turn + i * 2 * half;
    add(petal(R.petalInner, R.petalOuter, angle, half), i % 2 ? petalB : petalA, 'rose', BAND.mid, 0.38 + (i / petals) * 0.2, { angle });
  }
  if (second) {
    for (let i = 0; i < petals; i++) {
      const angle = turn + half + i * 2 * half;
      add(petal(R.petalInner, 0.54, angle, half), i % 2 ? g3 : g0, 'rose', BAND.mid, 0.3 + (i / petals) * 0.2, { angle });
    }
  }
  if (roundels) {
    const at = 0.585;
    const radius = Math.min(0.06, at * Math.sin(half) * 0.46);
    for (let i = 0; i < petals; i++) {
      const angle = turn + i * 2 * half;
      const [x, y] = polar(at, angle);
      add(disc(x, y, radius), g3, 'rose', BAND.mid, 0.62 + (i / petals) * 0.2, { angle });
    }
  }

  // Hub and centre.
  for (let i = 0; i < petals; i++) {
    const a0 = turn + half + i * 2 * half;
    add(sector(R.hubInner, R.hubOuter, a0, a0 + 2 * half), i % 2 ? g1 : g3, 'rose', BAND.low, 0.16 + (i / petals) * 0.12, { angle: a0 + half });
  }
  add(disc(0, 0, R.centre), g3, 'centre', BAND.low, 0);
  add(disc(0, 0, R.core), g0, 'centre', BAND.low, 0.04);

  return panes;
}

// 0 is glass at night, 1 is glass with the sun behind it, above 1 it flares.
function shade([r, g, b], level) {
  if (level <= 1) {
    const k = 0.09 + 0.91 * Math.max(0, level);
    return `rgb(${(r * k) | 0},${(g * k) | 0},${(b * k) | 0})`;
  }
  const w = Math.min(1, (level - 1) * 0.85);
  return `rgb(${(r + (255 - r) * w) | 0},${(g + (255 - g) * w) | 0},${(b + (255 - b) * w) | 0})`;
}

const angleBetween = (a, b) => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);

export class RoseWindow {
  constructor(canvas, bloom, { levels, voiceLevel, onHover, onPick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bloom = bloom;
    this.bloomCtx = bloom.getContext('2d');
    bloom.width = bloom.height = 128;
    this.levels = levels ?? (() => [0, 0, 0]);
    this.voiceLevel = voiceLevel ?? (() => 0);
    this.onHover = onHover ?? (() => {});
    this.onPick = onPick ?? (() => {});
    this.still = matchMedia('(prefers-reduced-motion: reduce)');

    this.verses = [];
    this.panes = buildPanes({
      verses: Array.from({ length: RESTING_PANES }, (_, i) => i + 1),
      seed: hashString('Selah'),
      glass: GENRES.wisdom.glass,
    });
    this.mode = 'idle'; // idle | waiting | revealed
    this.read = new Set();
    this.flare = new Set();
    this.current = null;
    this.hover = null;
    this.veil = 1;
    this.next = null;
    this.revealedAt = 0;
    this.last = performance.now();

    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
    canvas.addEventListener('pointermove', (e) => this.#point(e));
    canvas.addEventListener('pointerleave', () => this.#setHover(null));
    canvas.addEventListener('click', (e) => {
      const verse = this.#verseAt(e);
      if (verse != null) this.onPick(verse);
    });
    requestAnimationFrame((t) => this.#frame(t));
  }

  setPassage(passage) {
    const verses = passage.verses.map((v) => v.n);
    this.next = {
      verses,
      panes: buildPanes({
        verses,
        seed: hashString(`${passage.b}:${passage.c}:${passage.from}-${passage.to}`),
        glass: GENRES[passage.genre].glass,
      }),
    };
    if (this.still.matches) this.#swap();
  }

  setWaiting(waiting) {
    if (waiting) this.mode = 'waiting';
    else if (this.mode === 'waiting') this.mode = 'idle';
  }

  reveal() {
    this.mode = 'revealed';
    this.revealedAt = performance.now();
  }

  setCurrent(verse) {
    this.current = verse;
    if (verse != null) this.read.add(verse);
  }

  // Makes the resting window's own outer panes lightable and returns their
  // numbers. The sign-in page uses this: it has no passage to draw.
  wake() {
    this.verses = Array.from({ length: RESTING_PANES }, (_, i) => i + 1);
    return [...this.verses];
  }

  // Lights exactly these outer panes and no others.
  light(verses) {
    this.read = new Set(verses);
    this.current = null;
  }

  setFlare(verses) {
    this.flare = new Set(verses ?? []);
  }

  #swap() {
    this.verses = this.next.verses;
    this.panes = this.next.panes;
    this.next = null;
    this.read = new Set();
    this.flare = new Set();
    this.current = null;
    this.mode = 'waiting';
  }

  #resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
  }

  #verseAt(event) {
    if (!this.verses.length) return null;
    const box = this.canvas.getBoundingClientRect();
    const half = box.width / 2;
    const x = (event.clientX - box.left - half) / (half * R.rim);
    const y = (event.clientY - box.top - half) / (half * R.rim);
    const radius = Math.hypot(x, y);
    if (radius < R.verseInner || radius > R.verseOuter) return null;
    const turn = ((Math.atan2(y, x) - TOP) % TAU + TAU) % TAU;
    return this.verses[Math.floor((turn / TAU) * this.verses.length)] ?? null;
  }

  #point(event) {
    this.#setHover(this.#verseAt(event));
  }

  #setHover(verse) {
    if (verse === this.hover) return;
    this.hover = verse;
    this.canvas.style.cursor = verse == null ? '' : 'pointer';
    this.onHover(verse);
  }

  #target(pane, t, still) {
    if (pane.ring === 'verse') {
      if (!this.verses.length) return 0.2;
      if (pane.verse === this.current) return 1.3;
      if (this.flare.has(pane.verse) || pane.verse === this.hover) return 1.18;
      return this.read.has(pane.verse) ? 0.8 : 0.3;
    }
    if (this.mode === 'revealed') {
      const since = (performance.now() - this.revealedAt) / 1000;
      return still || since > pane.order * 2.4 ? 0.9 : 0.26;
    }
    if (this.mode === 'waiting' && !still) {
      // a slow hand of light going round while the reflection is written
      const sweep = TOP + t * 0.9;
      const near = pane.ring === 'centre' ? 0.5 + 0.5 * Math.sin(t * 1.3) : Math.exp(-((angleBetween(pane.angle, sweep) / 0.75) ** 2));
      return 0.24 + 0.5 * near;
    }
    return 0.24;
  }

  #frame(now) {
    requestAnimationFrame((t) => this.#frame(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    const still = this.still.matches;

    // Fade the old window out before swapping in the next one.
    if (this.next) {
      this.veil = Math.max(0, this.veil - dt / 0.3);
      if (this.veil === 0) this.#swap();
    } else {
      this.veil = still ? 1 : Math.min(1, this.veil + dt / 1.1);
    }

    const bands = this.levels();
    // The centre of the rose brightens with the reading voice.
    const voice = still ? 0 : Math.min(0.75, this.voiceLevel() * 1.5);
    const ease = still ? 1 : 1 - Math.exp(-dt / 0.32);

    const { ctx, canvas } = this;
    const size = canvas.width;
    const scale = (size / 2) * R.rim;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.setTransform(scale, 0, 0, scale, size / 2, size / 2);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = LEAD;
    ctx.lineWidth = 0.011;

    for (const pane of this.panes) {
      pane.lit += (this.#target(pane, t, still) - pane.lit) * ease;
      let level = pane.lit;
      if (!still) {
        level *= 1 + 0.07 * Math.sin(t * pane.speed + pane.phase) + 0.38 * bands[pane.band];
        if (pane.ring === 'centre') level += voice;
        else if (pane.verse != null && pane.verse === this.current) level += voice * 0.4;
      }
      ctx.fillStyle = shade(pane.rgb, level * this.veil);
      ctx.fill(pane.path);
      ctx.stroke(pane.path);
    }

    // Heavier leads between the rings, and the stone rim.
    ctx.lineWidth = 0.02;
    for (const radius of [R.verseInner - 0.012, R.hubOuter + 0.008, R.centre + 0.008]) {
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TAU);
      ctx.stroke();
    }
    ctx.lineWidth = 0.042;
    ctx.beginPath();
    ctx.arc(0, 0, R.verseOuter + 0.021, 0, TAU);
    ctx.stroke();

    this.bloomCtx.clearRect(0, 0, 128, 128);
    this.bloomCtx.drawImage(canvas, 0, 0, 128, 128);
  }
}
