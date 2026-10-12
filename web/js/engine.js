// Retrieval + ranking. Everything runs in the browser: the catalog vectors are
// precomputed (scripts/build_dataset.py) and only the query is embedded here,
// with the same ONNX model, via transformers.js. No server, no API key, no cost.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import { AXES, buildIndex } from './nlu.js';

env.allowLocalModels = false;

export class Engine {
  // Staged loading so the app is useful long before the model arrives:
  //   'data'    core catalog (~1.3 MB): Home, rails, filters, parser-only "quick" search
  //   'details' plot text + vectors: lexical matching, "like X", taste, feed overviews
  //   'ready'   query model (~34 MB, cached after first visit): full semantic search
  // gate: optional promise to wait on before the heavy downloads (data-saver mode).
  async load(onProgress = () => {}, gate = null, modelGate = null) {
    // meta.json is always revalidated; its version busts the long-cached data files on each rebuild.
    const meta = await fetch('data/meta.json', { cache: 'no-cache' }).then((r) => r.json());
    const v = `?v=${meta.version || ''}`;
    this.meta = meta;
    this.dims = meta.dims;
    const [catalog, providers] = await Promise.all([
      fetch(`data/catalog.json${v}`).then((r) => r.json()),
      fetch(`data/providers.json${v}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    this.providers = providers;
    this.hasProviders = Object.keys(providers).length > 0;
    this.catalog = catalog;
    for (const m of catalog) { m.overview = ''; m.tagline = ''; m.keywords = []; }
    this.index = buildIndex(catalog);
    // Quality prior: Bayesian-average rating so a 9.0 from 300 votes doesn't beat
    // an 8.5 from 30k votes. Stored as z-scores so it mixes with the other signals.
    const C = catalog.reduce((s, m) => s + m.rating, 0) / catalog.length;
    const M = 1500;
    // pv = popularity votes normalized across markets (IMDb votes stand in where TMDB is thin).
    const bayes = catalog.map((m) => ((m.pv ?? m.votes) * m.rating + M * C) / ((m.pv ?? m.votes) + M));
    this.quality = zscore(bayes);
    this.fame = zscore(catalog.map((m) => Math.log10(Math.max(1, m.pv ?? m.votes))));
    this.yearZ = zscore(catalog.map((m) => m.year));
    // Quality within a language: a Malayalam classic with 2k votes is as "proven" in its market as
    // a Hollywood hit with 30k. Same Bayesian average, but the prior strength is that language's
    // median vote count and the z-score is taken within the language.
    const byLang = new Map();
    catalog.forEach((m, i) => { if (!byLang.has(m.lang)) byLang.set(m.lang, []); byLang.get(m.lang).push(i); });
    this.qualityInLang = new Float32Array(catalog.length);
    for (const ids of byLang.values()) {
      const pv = ids.map((i) => catalog[i].pv ?? catalog[i].votes).sort((a, b) => a - b);
      const ML = Math.max(20, pv[Math.floor(pv.length / 2)]);
      const CL = ids.reduce((s2, i) => s2 + catalog[i].rating, 0) / ids.length;
      const z = zscore(ids.map((i) => { const v = catalog[i].pv ?? catalog[i].votes; return (v * catalog[i].rating + ML * CL) / (v + ML); }));
      ids.forEach((i, j) => { this.qualityInLang[i] = z[j]; });
    }
    onProgress({ stage: 'data' });

    if (gate) { onProgress({ stage: 'gated' }); await gate; }

    const [details, buf] = await Promise.all([
      fetch(`data/details.json${v}`).then((r) => r.json()),
      fetch(`data/embeddings.bin${v}`).then((r) => r.arrayBuffer()),
    ]);
    details.forEach(([overview, tagline, keywords], i) => Object.assign(catalog[i], { overview, tagline, keywords }));
    // Normalized text per title for lexical matching (keywords weigh most, so they lead).
    this.text = catalog.map((m) => ` ${[...m.keywords, m.title, m.tagline, m.overview].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `);
    this.vecs = new Int8Array(buf);
    // Words used as keywords on 3+ titles are topics ("heist", "space"), not titles. The parser
    // uses this to tell "Kantara" (a film) from "heist" (a subject) in bare one-word queries.
    const kw = new Map();
    for (const m of catalog) for (const k of m.keywords) for (const w of k.toLowerCase().split(/[^a-z0-9]+/)) if (w) kw.set(w, (kw.get(w) || 0) + 1);
    this.index.topicWords = new Set([...kw].filter(([, n]) => n >= 3).map(([w]) => w));
    onProgress({ stage: 'details' });

    // Lite mode: everything above works without the model; it loads only when the viewer opts in.
    if (modelGate) { onProgress({ stage: 'lite' }); await modelGate; }
    const files = {};
    this.embedder = await pipeline('feature-extraction', meta.model, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          files[p.file] = [p.loaded, p.total];
          const [l, t] = Object.values(files).reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
          onProgress({ stage: 'model', loaded: l, total: t });
        }
      },
    });

    // Attribute axes: project every title onto (positive pole - negative pole).
    const axes = {};
    for (const [name, def] of Object.entries(AXES)) {
      const [pos, neg] = await Promise.all([this.embed(def.pos, false), this.embed(def.neg, false)]);
      const dir = normalize(pos.map((x, i) => x - neg[i]));
      axes[name] = { dir, proj: zscore(this.projectAll(dir)) };
    }
    this.axes = axes;
    onProgress({ stage: 'ready' });
  }

  get semanticReady() { return !!(this.embedder && this.axes); }

  async embed(text, isQuery = true) {
    const out = await this.embedder((isQuery ? this.meta.query_prefix : '') + text, { pooling: 'cls', normalize: true });
    return Float32Array.from(out.data);
  }

  vec(i) {
    const s = this.meta.scale, d = this.dims, v = new Float32Array(d);
    for (let k = 0; k < d; k++) v[k] = this.vecs[i * d + k] / s;
    return v;
  }

  projectAll(q) {
    const n = this.catalog.length, d = this.dims, out = new Float32Array(n), V = this.vecs;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const o = i * d;
      for (let k = 0; k < d; k++) s += V[o + k] * q[k];
      out[i] = s / this.meta.scale;
    }
    return out;
  }

  passes(m, f, intent, relaxed) {
    if (f.maxRuntime && m.runtime > f.maxRuntime && !relaxed.has('runtime')) return false;
    if (f.minRuntime && m.runtime < f.minRuntime && !relaxed.has('runtime')) return false;
    if (f.yearMin && m.year < f.yearMin && !relaxed.has('year')) return false;
    if (f.yearMax && m.year > f.yearMax && !relaxed.has('year')) return false;
    if (f.minRating && m.rating < f.minRating && !relaxed.has('rating')) return false;
    if (f.langs && !f.langs.includes(m.lang) && !relaxed.has('lang')) return false;
    if (f.excludeLangs && f.excludeLangs.includes(m.lang) && !relaxed.has('lang')) return false;
    if (f.type && m.type !== f.type) return false;
    if (intent.excludeGenres.some((g) => m.genres.includes(g))) return false;
    if (intent.genres.length && !relaxed.has('genres')) {
      const hits = intent.genres.filter((g) => m.genres.includes(g)).length;
      if (relaxed.has('genres-all') ? hits === 0 : hits < intent.genres.length) return false;
    }
    if (intent.people.length && !relaxed.has('people')) {
      const crew = [...m.cast, ...m.directors];
      if (!intent.people.every((p) => crew.includes(p))) return false;
    }
    // Thin filmography: once the person filter is loosened, stay in their cinema, not global hits.
    if (relaxed.has('people') && intent.peopleLang && m.lang !== intent.peopleLang) return false;
    return true;
  }

  // Builds the query vector from the parsed intent.
  async queryVector(intent) {
    const text = [intent.semantic, ...intent.expansions].filter(Boolean).join('. ');
    const parts = [];
    if (!this.vecs) return null;
    if (!this.semanticReady) {
      // Quick mode: no query model yet, but reference titles still work from their stored vectors.
      if (!intent.anchors.length) return null;
      const a = new Float32Array(this.dims);
      for (const i of intent.anchors) this.vec(i).forEach((x, k) => (a[k] += x));
      return { q: normalize(a), text: '' };
    }
    if (intent.anchors.length) {
      const a = new Float32Array(this.dims);
      for (const i of intent.anchors) this.vec(i).forEach((v, k) => (a[k] += v));
      parts.push([normalize(a), text ? 0.62 : 1]);
    }
    if (text) parts.push([await this.embed(text), intent.anchors.length ? 0.38 : 1]);
    // No descriptive text: genres are already hard filters, so rank by quality rather than by how
    // often a plot summary happens to contain the word "thriller".
    if (!parts.length) return null;
    const q = new Float32Array(this.dims);
    for (const [v, w] of parts) v.forEach((x, k) => (q[k] += w * x));
    return { q: normalize(q), text };
  }

  // ctx: { prefs: [lang], taste: Taste, subs: [provider-name keys], onlyMine: bool }
  async search(intent, k = 12, ctx = {}) {
    const prefs = ctx.prefs || [];
    this._ctx = ctx;
    const taste = ctx.taste?.z ? ctx.taste : null;
    const hidden = new Set(ctx.taste ? ctx.taste.disliked() : []);
    const t0 = performance.now();
    const qv = await this.queryVector(intent);
    const t1 = performance.now();
    const n = this.catalog.length;
    const sims = qv ? this.projectAll(qv.q) : null;
    const semZ = sims ? zscore(sims) : null;

    // Keyword mode with a topic or mood to go on: let those words lead, not all-time popularity.
    const topical = !qv && (intent.lex?.length || intent.expansions.length || intent.softGenres.length);
    const wQuality = { high: 0.9, hidden: 0.7, popular: 0.2 }[intent.quality] ?? (qv || topical ? 0.3 : 1.0);
    const wFame = { hidden: -0.8, popular: 0.9 }[intent.quality] ?? (qv ? 0.25 : topical ? 0.2 : 0.5);
    const steer = Object.entries(intent.steer);
    const anchorSet = new Set([...(intent.anchors || []), ...(intent.exclude || [])]);

    // Progressive relaxation: if hard constraints leave too few titles, loosen the
    // least essential one and say so, instead of returning an empty page.
    // A named language is part of the viewer's identity, so it's loosened after genre, not before.
    const relaxOrder = ['genres-all', 'year', 'runtime', 'rating', 'mine', 'genres', 'lang', 'provider', 'people'];
    const relaxed = new Set();
    let pool = [];
    let exact = null; // titles that met every constraint, kept on top even after relaxing
    for (let step = 0; step <= relaxOrder.length; step++) {
      pool = [];
      for (let i = 0; i < n; i++) {
        if (anchorSet.has(i) || hidden.has(i)) continue;
        if (!this.passes(this.catalog[i], intent.filters, intent, relaxed)) continue;
        if (ctx.onlyMine && ctx.subs?.length && !relaxed.has('mine') && !this.onMyApps(this.catalog[i], ctx.subs)) continue;
        if (intent.filters.providers && !relaxed.has('provider') && !this.onMyApps(this.catalog[i], intent.filters.providers)) continue;
        pool.push(i);
      }
      if (step === 0) exact = new Set(pool);
      if (pool.length >= (intent.people.length ? 3 : Math.min(k, 6)) || step === relaxOrder.length) break;
      const next = relaxOrder.find((r) => !relaxed.has(r) && this.relaxable(r, intent));
      if (!next) break;
      relaxed.add(next);
    }

    const EXP_STOP = new Set(['about', 'story', 'film', 'films', 'movie', 'with', 'their', 'there', 'where', 'which', 'while', 'young', 'people', 'world', 'every', 'everyone', 'leaves', 'smiling']);
    const expLex = qv ? [] : [...new Set(intent.expansions.join(' ').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5 && !EXP_STOP.has(w)).map((w) => w.replace(/(?:ing|ed|s)$/, '')))].slice(0, 10);
    const scored = pool.map((i) => {
      const m = this.catalog[i];
      const parts = {};
      parts.semantic = semZ ? semZ[i] : 0;
      // One named language: judge quality against that language's own films.
      parts.quality = wQuality * (intent.filters.langs?.length === 1 ? this.qualityInLang[i] : this.quality[i]);
      parts.fame = wFame * this.fame[i];
      const soft = intent.softGenres.filter((g) => m.genres.includes(g)).length;
      parts.genre = 0.45 * Math.min(soft, 2);
      // Viewer's preferred languages (like a streaming profile's language setting): a soft lift,
      // only when the query itself didn't name a language.
      if (prefs.length && !intent.filters.langs) parts.lang = prefs.includes(m.lang) ? 0.9 : 0;
      // Culture-specific moods ("masala", "family entertainer") lean toward Indian cinema.
      if (intent.langBoost && !intent.filters.langs) parts.lang = (parts.lang || 0) + (intent.langBoost.includes(m.lang) ? (intent.langBoostWeight || 1.5) : 0);
      // Personal taste: how close this title sits to the viewer's like/dislike vector.
      // Lighter when the query names a reference title (the user's ask wins).
      if (taste) parts.taste = (intent.anchors.length ? 0.25 : 0.45) * taste.z[i];
      if (ctx.subs?.length && (!ctx.onlyMine || relaxed.has('mine')) && this.onMyApps(m, ctx.subs)) parts.access = 0.8;
      // Lexical half of hybrid scoring: whole-word (prefix) hits on content words; a phrase hit counts double.
      if (this.text && (intent.lex?.length || expLex.length)) {
        const t = this.text[i];
        let hits = (intent.lex || []).reduce((a, w) => a + (t.includes(` ${w}`) ? 1 : 0), 0);
        if (intent.lexPhrase && t.includes(` ${intent.lexPhrase}`)) hits += 1;
        // Keyword mode (no model): descriptive words from moods/shows ("village", "heartwarming")
        // stand in for the semantic match they'd normally feed.
        const soft = expLex.reduce((a, w) => a + (t.includes(` ${w}`) ? 1 : 0), 0);
        if (hits || soft) parts.lexical = (qv ? 0.55 : 1.5) * Math.min(hits, 2) + (qv ? 0.35 : 0.6) * Math.min(soft, 3);
      }
      if (intent.recent) parts.recency = 0.8 * intent.recent * this.yearZ[i];
      // A reference film's language is part of its feel: "like 3 Idiots" should lean Hindi.
      if (intent.anchors.length && !intent.filters.langs) {
        const al = intent.anchors.map((a) => this.catalog[a].lang);
        const indian = (l) => ['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa'].includes(l);
        parts.anchorLang = al.includes(m.lang) ? 0.7 : al.some(indian) && indian(m.lang) ? 0.35 : 0;
      }
      parts.avoid = intent.avoidGenres.some((g) => m.genres.includes(g)) ? -1.2 : 0;
      // With a reference title, steering is a nudge around it, not a new destination.
      const wSteer = intent.anchors.length ? 0.45 : 0.55;
      parts.steer = this.axes ? steer.reduce((s, [ax, w]) => s + wSteer * w * this.axes[ax].proj[i], 0) : 0;
      // Anchor-based queries: reward genre overlap with the reference (Jaccard) to stay on-topic.
      if (intent.anchors.length) {
        const ag = new Set(intent.anchors.flatMap((a) => this.catalog[a].genres));
        const inter = m.genres.filter((g) => ag.has(g)).length;
        const jac = inter / (new Set([...ag, ...m.genres]).size || 1);
        parts.genre += 1.2 * jac - 0.35;
      }
      const score = Object.values(parts).reduce((a, b) => a + b, 0);
      return { i, score, parts, sim: sims ? sims[i] : null };
    }).sort((a, b) => b.score - a.score);

    // Diversity re-rank needs vectors; before they arrive, keep score order.
    const pick = (list, n) => (this.vecs ? mmr(list.slice(0, 80), n, (a, b) => this.similarity(a, b), 0.78) : list.slice(0, Math.max(0, n)));
    let results;
    if (relaxed.size && exact.size) {
      // Exact matches first ("only 2 Thai horror films"), then the best close matches.
      const head = pick(scored.filter((x) => exact.has(x.i)), k);
      const tail = pick(scored.filter((x) => !exact.has(x.i)), k - head.length);
      head.forEach((x) => (x.exact = true));
      results = [...head, ...tail];
    } else {
      results = pick(scored, k);
    }
    // Confidence: when free text is the only signal and nothing stands out from the crowd
    // (top-1 vs 50th-best similarity), the query probably wasn't understood.
    let lowConfidence = false;
    if (sims && !intent.anchors.length && !intent.genres.length && !intent.moods.length && !intent.people.length
        && !Object.keys(intent.filters).length && !Object.keys(intent.steer).length && !intent.lex?.some((w) => this.text?.some((t) => t.includes(` ${w}`)))) {
      const top = Float32Array.from(sims).sort().reverse();
      lowConfidence = top[0] - top[50] < 0.08;
    }
    if (intent.titleHit != null && !hidden.has(intent.titleHit)) {
      const t = intent.titleHit;
      results = [{ i: t, score: Infinity, parts: { title: 1 }, sim: 1, exact: true }, ...results.filter((x) => x.i !== t)].slice(0, k);
    }
    return {
      quick: !this.semanticReady,
      lowConfidence, exactCount: relaxed.size ? exact.size : null,
      results, poolSize: pool.length, relaxed: [...relaxed], semanticText: qv?.text || '',
      timing: { embed: t1 - t0, rank: performance.now() - t1 },
    };
  }

  // Editorial-style rails for the home screen: top titles for a filter, by quality + fame.
  rail(filter, k = 18, sortBy = 'score') {
    const out = [];
    for (let i = 0; i < this.catalog.length; i++) if (filter(this.catalog[i])) out.push(i);
    const key = sortBy === 'recent'
      ? (i) => this.catalog[i].year * 10 + this.fame[i] * 2 + this.quality[i]
      : (i) => this.quality[i] + 0.8 * this.fame[i];
    return out.sort((a, b) => key(b) - key(a)).slice(0, k);
  }

  // Where-to-watch: subscription/free availability in India, matched by provider name keys.
  providersOf(m, kind = 's') {
    return (m.wp?.[kind] || []).map((id) => this.providers?.[id]).filter(Boolean);
  }
  onMyApps(m, keys) {
    return this.providersOf(m).some((p) => keys.some((k) => p.n.toLowerCase().includes(k)));
  }
  zscoreOf(arr) { return zscore(arr); }

  relaxable(r, intent, ctx = this._ctx || {}) {
    if (r === 'mine') return !!(ctx.onlyMine && ctx.subs?.length);
    const f = intent.filters;
    return {
      'genres-all': intent.genres.length > 1, genres: intent.genres.length > 0, year: f.yearMin || f.yearMax,
      runtime: f.maxRuntime || f.minRuntime, rating: f.minRating, provider: f.providers, lang: f.langs || f.excludeLangs, people: intent.people.length > 0,
    }[r];
  }

  similarity(a, b) {
    const d = this.dims, V = this.vecs, s2 = this.meta.scale ** 2;
    let s = 0;
    for (let k = 0; k < d; k++) s += V[a * d + k] * V[b * d + k];
    return s / s2;
  }
}

// Maximal Marginal Relevance: trade a little relevance for variety so one query
// doesn't return five entries from the same franchise.
function mmr(cands, k, sim, lambda) {
  if (!cands.length || k <= 0) return [];
  const chosen = [cands[0]];
  const rest = cands.slice(1);
  const top = cands[0].score, bottom = cands[cands.length - 1].score;
  const range = Math.max(1e-6, top - bottom);
  while (chosen.length < k && rest.length) {
    let best = 0, bestVal = -Infinity;
    rest.forEach((c, j) => {
      const rel = (c.score - bottom) / range;
      const red = Math.max(...chosen.map((x) => sim(c.i, x.i)));
      const v = lambda * rel - (1 - lambda) * Math.max(0, (red - 0.6) / 0.4) * 2;
      if (v > bestVal) { bestVal = v; best = j; }
    });
    chosen.push(rest.splice(best, 1)[0]);
  }
  return chosen;
}

function zscore(arr) {
  const n = arr.length;
  let mean = 0;
  for (const x of arr) mean += x;
  mean /= n;
  let v = 0;
  for (const x of arr) v += (x - mean) ** 2;
  const sd = Math.sqrt(v / n) || 1;
  return Float32Array.from(arr, (x) => (x - mean) / sd);
}

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / s);
}
