// On-device taste profile. Every 👍/👎 (and, softer, how long you watch a preview)
// moves a single preference vector in the same embedding space as the catalog.
// Nothing leaves the browser: personalisation without collecting user data.

const KEY = 'pp.taste.v1';

export class Taste {
  constructor(engine) {
    this.engine = engine;
    this.byId = new Map(engine.catalog.map((m, i) => [`${m.type}:${m.id}`, i]));
    this.signals = load(); // "movie:123" -> weight in [-1, 1]
    this.listeners = new Set();
    this.recompute();
  }

  key(i) { const m = this.engine.catalog[i]; return `${m.type}:${m.id}`; }
  weight(i) { return this.signals[this.key(i)] || 0; }
  liked() { return this.entries().filter(([, w]) => w >= 0.5).map(([i]) => i); }
  disliked() { return this.entries().filter(([, w]) => w <= -0.5).map(([i]) => i); }
  entries() {
    return Object.entries(this.signals).map(([k, w]) => [this.byId.get(k), w]).filter(([i]) => i != null);
  }
  get size() { return this.liked().length; }

  // Explicit feedback replaces; implicit (dwell / skip) nudges and never overrides an explicit vote.
  set(i, w) { this.signals[this.key(i)] = w; this.commit(); }
  toggle(i, w) { this.weight(i) === w ? this.clear(i) : this.set(i, w); }
  clear(i) { delete this.signals[this.key(i)]; this.commit(); }
  reset() { this.signals = {}; this.commit(); }
  nudge(i, delta) {
    const k = this.key(i), cur = this.signals[k] || 0;
    if (Math.abs(cur) >= 1) return;
    this.signals[k] = Math.max(-0.45, Math.min(0.45, cur + delta));
    this.commit();
  }

  commit() { save(this.signals); this.recompute(); this.listeners.forEach((fn) => fn()); }
  onChange(fn) { this.listeners.add(fn); }

  // Profile = weighted mean of liked vectors minus half the weighted mean of disliked ones.
  recompute() {
    const e = this.engine, d = e.dims;
    const pos = new Float32Array(d), neg = new Float32Array(d);
    let wp = 0, wn = 0;
    for (const [i, w] of this.entries()) {
      const v = e.vec(i);
      if (w > 0) { for (let k = 0; k < d; k++) pos[k] += w * v[k]; wp += w; }
      else { for (let k = 0; k < d; k++) neg[k] += -w * v[k]; wn += -w; }
    }
    if (wp < 0.9) { this.vector = null; this.z = null; return; } // need roughly one real like first
    const q = new Float32Array(d);
    for (let k = 0; k < d; k++) q[k] = pos[k] / wp - (wn ? (0.5 * neg[k]) / wn : 0);
    let n = 0;
    for (const x of q) n += x * x;
    n = Math.sqrt(n) || 1;
    this.vector = q.map((x) => x / n);
    this.z = e.zscoreOf(e.projectAll(this.vector));
  }

  // Most-recent strong like, for "Because you liked X".
  lastLiked() {
    const keys = Object.keys(this.signals).filter((k) => this.signals[k] >= 0.5);
    const k = keys.at(-1);
    return k ? this.byId.get(k) : null;
  }
}

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } }
