import { Engine } from './engine.js';
import { parse, isFollowUp, mergeIntent, AXES, INDIAN_LANGS, PROVIDERS, scriptLang } from './nlu.js';
import { Voice, browserSTTAvailable } from './voice.js';
import { Taste } from './taste.js';
import { Feed } from './feed.js';
import { track, analyticsEnabled, analyticsBlockedByBrowser, setAnalytics } from './telemetry.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtRuntime = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
const langName = (c) => { try { return LANG_NAMES.of(c === 'cn' ? 'yue' : c); } catch { return c; } };
const IMG = 'https://image.tmdb.org/t/p/';

const LANG_CHOICES = [
  ['hi', 'Hindi', 'हिन्दी'], ['te', 'Telugu', 'తెలుగు'], ['ta', 'Tamil', 'தமிழ்'], ['ml', 'Malayalam', 'മലയാളം'],
  ['kn', 'Kannada', 'ಕನ್ನಡ'], ['bn', 'Bengali', 'বাংলা'], ['mr', 'Marathi', 'मराठी'], ['pa', 'Punjabi', 'ਪੰਜਾਬੀ'],
  ['en', 'English', 'English'], ['ko', 'Korean', '한국어'], ['ja', 'Japanese', '日本語'],
];

const TRY = [
  'a feel good family entertainer under two and a half hours',
  'Telugu thriller like Drishyam',
  'something like Inception but less confusing',
  'mass masala action in Tamil',
  'underrated Malayalam movies',
  'Shah Rukh Khan romance from the 90s',
  'a patriotic film based on a true story',
  'Kollywood movies like Vikram Vedha',
];

const engine = new Engine();
const turns = [];
let ready = false;
let pending = null;
let pendingShell = null;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
let prefs = store.get('pp.langs', ['hi', 'te', 'ta', 'ml', 'en']);
let subs = store.get('pp.subs', []);
let onlyMine = store.get('pp.onlyMine', false);
let taste = null;
let feed = null;
// Everything the ranker should know about this viewer.
let hotstarOnly = store.get('pp.hsOnly', true); // on by default: recommend what JioHotstar can actually play
const ctx = (intent) => hotstarOnly && engine.hasProviders
  ? { prefs, taste, subs: ['hotstar'], onlyMine: true }
  : { prefs, taste, subs, onlyMine: onlyMine || !!intent?.mine };

const els = {
  home: $('#home'), chat: $('#chat'), thread: $('#thread'), input: $('#q'), form: $('#composer'), mic: $('#mic'),
  status: $('#status'), statusText: $('#status-text'), bar: $('#status-bar'), voiceNote: $('#voice-note'),
  speak: $('#opt-speak'), handsfree: $('#opt-handsfree'), engineSel: $('#opt-engine'), voiceLang: $('#opt-voice-lang'),
  hero: $('#hero'), rails: $('#rails'), detail: $('#detail'), langs: $('#langs'), settings: $('#settings'),
  feed: $('#feed'), tasteSheet: $('#taste'),
};

// ---------- boot ----------
$('#try').innerHTML = TRY.map((t) => `<button type="button">${esc(t)}</button>`).join('');
$('#try').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) submit(b.textContent, false); });
renderLangSheet();

// On slow or data-saver connections, don't spend 34 MB until the viewer shows intent to search.
const conn = navigator.connection;
const saveData = new URLSearchParams(location.search).has('lite') || !!(conn && (conn.saveData || /(^|-)2g|3g/.test(conn.effectiveType || '')));
// Smart search mode: 'auto' (lite on slow/data-saver connections), 'on', or 'lite'.
let smartMode = store.get('pp.smart', 'auto');
const liteMode = () => smartMode === 'lite' || (smartMode === 'auto' && saveData);
let releaseModel = () => {};
const modelGate = liteMode() ? new Promise((resolve) => { releaseModel = () => { resolve(); releaseModel = () => {}; }; }) : null;
let releaseGate = () => {};
const gate = saveData ? new Promise((resolve) => {
  const go = releaseGate = () => { resolve(); ['focus', 'pointerdown'].forEach((ev) => els.input.removeEventListener(ev, go)); els.mic.removeEventListener('pointerdown', go); };
  els.input.addEventListener('focus', go); els.input.addEventListener('pointerdown', go); els.mic.addEventListener('pointerdown', go);
  document.addEventListener('click', (e) => { if (e.target.closest('#try button, [data-nav=search], [data-nav=voice], [data-like]')) go(); });
}) : null;

engine.load((p) => {
  if (p.stage === 'data') {
    // Core catalog is in: Home renders and quick (parser + filters) search works immediately.
    ready = true;
    setStatus('Quick search ready · loading smarter matching…', 0.08);
    track('session', { lite: saveData, mobile: matchMedia('(max-width: 760px)').matches, prefs, translator: 'Translator' in self, stt: browserSTTAvailable });
    renderSubs();
    paintHotstarToggle();
    renderHome();
    if (pending) { const q = pending; pending = null; run(q.text, q.voice); }
  }
  if (p.stage === 'gated') setStatus('Data saver on · plot details (≈5 MB) load when you start searching', 0.08);
  if (p.stage === 'details') {
    taste = new Taste(engine);
    feed = new Feed({
      root: els.feed, engine, taste, ctx, langName,
      onMoreLike: (i) => submit(`more like ${engine.catalog[i].title}`, false),
      onDetail: (i) => openDetail(i),
      onClose: () => show(turns.length ? 'chat' : 'home'),
      onEvent: (action, props) => track('feed', { action, ...props }),
    });
    let t = null;
    taste.onChange(() => { clearTimeout(t); t = setTimeout(() => { if (els.feed.hidden) refreshHome(); }, 400); });
    renderPersonalRails();
    renderHero(heroIds); // now with plot summaries
    setStatus('Quick search ready · loading the language model (one-time, ~34 MB)…', 0.15);
  }
  if (p.stage === 'lite') setStatus('Lite mode · keyword search (saves ≈34 MB)', 0.3);
  if (p.stage === 'model') setStatus(`Quick search ready · language model ${Math.round((100 * p.loaded) / p.total)}%`, 0.15 + 0.85 * (p.loaded / p.total));
  if (p.stage === 'ready') {
    setStatus(`${engine.catalog.length.toLocaleString()} titles · semantic search ready`, 1, true);
    renderPersonalRails();
    renderThemedRails();
    upgradeQuickTurn();
  }
}, gate, modelGate).catch((err) => setStatus(`Couldn’t load: ${err.message}`, 0, false, true));

function setStatus(text, frac, done = false, error = false) {
  els.statusText.textContent = text;
  els.bar.style.width = `${Math.round(frac * 100)}%`;
  els.status.classList.toggle('done', done);
  els.status.classList.toggle('error', error);
}

// ---------- navigation ----------
function show(view) {
  if (view !== 'feed' && !els.feed.hidden) feed?.close();
  els.home.hidden = view !== 'home';
  els.chat.hidden = view !== 'chat';
  els.feed.hidden = view !== 'feed';
  document.body.classList.toggle('in-feed', view === 'feed');
  const navKey = { home: 'home', chat: 'search', feed: 'feed' }[view];
  document.querySelectorAll('.rail [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === navKey));
  if (view === 'home') window.scrollTo({ top: 0 });
}
function openFeed(seed, label) {
  if (!feed) { releaseGate(); toast('Previews are loading, try again in a moment.'); return; }
  show('feed');
  feed.open(seed, label);
}
document.addEventListener('click', (e) => {
  const n = e.target.closest('[data-nav]');
  if (!n) return;
  e.preventDefault();
  const v = n.dataset.nav;
  if (v === 'home') show('home');
  if (v === 'search') { if (turns.length) show('chat'); els.input.focus(); }
  if (v === 'voice') voice.toggle();
  if (v === 'langs') els.langs.showModal();
  if (v === 'settings') els.settings.showModal();
  if (v === 'feed') openFeed();
  if (v === 'taste') openTasteSheet();
});

// ---------- languages ----------
function renderLangSheet() {
  $('#lang-grid').innerHTML = LANG_CHOICES.map(([code, name, native]) =>
    `<label><input type="checkbox" value="${code}" ${prefs.includes(code) ? 'checked' : ''}><b>${native}</b><span>${name}</span></label>`).join('');
}
els.langs.addEventListener('close', () => {
  const next = [...els.langs.querySelectorAll('input:checked')].map((i) => i.value);
  if (next.join() === prefs.join()) return;
  prefs = next;
  store.set('pp.langs', prefs);
  track('lang', { prefs });
  if (engine.catalog) { renderHome(); if (ready) renderThemedRails(); }
});

// ---------- voice ----------
const voice = new Voice({
  onInterim: (t) => { els.input.value = t; autosize(); },
  onFinal: (t) => submit(t, true),
  onState: (on) => {
    els.mic.classList.toggle('on', on); els.mic.setAttribute('aria-pressed', on);
    document.querySelector('.rail [data-nav=voice]')?.classList.toggle('listening', on);
    els.input.placeholder = on ? 'Listening…' : placeholder;
  },
  onStatus: (t) => { els.voiceNote.textContent = t; els.voiceNote.hidden = !t; },
});
if (matchMedia('(max-width: 760px)').matches) els.input.placeholder = 'Ask for a movie…';
const placeholder = els.input.placeholder;
voice.lang = store.get('pp.voiceLang', 'en-IN');
els.voiceLang.value = voice.lang;
const micLang = $('#mic-lang');
micLang.value = voice.lang;
const setVoiceLang = (v) => {
  voice.lang = v; els.voiceLang.value = v; micLang.value = v; store.set('pp.voiceLang', v);
  if (!v.startsWith('en')) toast(`Speak in ${els.voiceLang.selectedOptions[0].textContent.split('·').pop().trim()}. I’ll translate for search.`);
};
els.voiceLang.addEventListener('change', () => setVoiceLang(els.voiceLang.value));
micLang.addEventListener('change', () => setVoiceLang(micLang.value));
if (!browserSTTAvailable) {
  els.engineSel.value = 'local';
  els.engineSel.querySelector('[value=browser]').disabled = true;
}
els.engineSel.addEventListener('change', () => { voice.engine = els.engineSel.value; });
els.mic.addEventListener('click', () => voice.toggle());
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); voice.toggle(); }
});

// ---------- composer ----------
function autosize() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`; }
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); }
});
els.form.addEventListener('submit', (e) => { e.preventDefault(); submit(els.input.value, false); });

function submit(text, fromVoice) {
  text = text.trim();
  if (!text) return;
  els.input.value = ''; autosize();
  releaseGate();
  show('chat');
  if (!ready) {
    pending = { text, voice: fromVoice };
    addUserBubble(text, fromVoice);
    pendingShell = addTurnShell();
    pendingShell.innerHTML = '<p class="reply muted">One moment, still loading the model…</p>';
    return;
  }
  run(text, fromVoice);
}

// ---------- the conversational loop ----------
async function run(text, fromVoice) {
  const prev = turns.at(-1);
  let intent = understand(text);
  const followUp = isFollowUp(intent, prev?.intent);
  if (followUp) intent = mergeIntent(prev.intent, intent, prev.out.results.map((r) => r.i), engine.catalog);

  if (!pendingShell) addUserBubble(text, fromVoice);
  const el = pendingShell || addTurnShell();
  pendingShell = null;
  el.innerHTML = '<p class="reply muted">Thinking…</p>';

  const t0 = performance.now();
  const out = await engine.search(intent, 12, ctx(intent));
  const turn = { id: turns.length, user: text, intent, out, el, followUp };
  track('search', {
    mode: fromVoice ? 'voice' : 'text', voiceLang: fromVoice ? voice.lang : undefined, followUp, n: out.results.length,
    quick: out.quick, low: out.lowConfidence, relaxed: out.relaxed, langs: intent.filters.langs || intent.langBoost || [],
    anchors: intent.anchors.length, translated: !!intent.translated, script: !!scriptLang(text), ms: Math.round(performance.now() - t0),
  }, text);
  turns.push(turn);
  renderTurn(turn);
  refineWithTranslation(turn);

  const reply = replyText(turn);
  if (els.speak.checked && (fromVoice || els.handsfree.checked)) {
    voice.speak(reply.spoken, () => { if (els.handsfree.checked && fromVoice) setTimeout(() => voice.start(), 250); });
  }
}

// ---------- Indian-language understanding ----------
// Native-script text is parsed directly (script lexicon + native titles). Where the browser ships an
// on-device translator (Chrome's Translator API), whole sentences are also translated to English
// first, so free-form asks like "నాకు నవ్వించే ఫ్యామిలీ సినిమా కావాలి" work, not just keywords.
const translators = {};
let translatorDead = !('Translator' in self);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function translateToEnglish(text, lang) {
  if (translatorDead) return null;
  try {
    const avail = await withTimeout(self.Translator.availability({ sourceLanguage: lang, targetLanguage: 'en' }), 2500);
    if (avail === 'unavailable') return null;
    translators[lang] ??= self.Translator.create({ sourceLanguage: lang, targetLanguage: 'en' });
    const tr = await withTimeout(translators[lang], 20000);
    return await withTimeout(tr.translate(text), 5000);
  } catch (err) {
    if (err.message === 'timeout') translatorDead = true; // don't keep paying for a translator that never answers
    delete translators[lang];
    return null;
  }
}

// Answer instantly from the script lexicon + native titles; if an on-device translator is
// available, refine the same turn in the background with the full-sentence translation.
function understand(text) { return parse(text, engine.index); }

async function refineWithTranslation(turn) {
  const lang = scriptLang(turn.user);
  if (!lang || translatorDead) return;
  const english = await translateToEnglish(turn.user, lang);
  if (!english || turns.at(-1) !== turn) return;
  const t = parse(english, engine.index);
  const orig = turn.intent;
  // Keep what only the original script could tell us: native-title anchors and the language lean.
  if (!t.anchors.length && orig.anchors.length) t.anchors = orig.anchors;
  if (!t.filters.langs && orig.filters.langs) t.filters.langs = orig.filters.langs;
  t.langBoost = t.langBoost || orig.langBoost;
  t.raw = turn.user;
  t.translated = english;
  turn.intent = t;
  turn.out = await engine.search(t, 12, ctx(t));
  renderTurn(turn);
}

// A turn answered in quick mode is silently re-ranked once semantic search is ready.
async function upgradeQuickTurn() {
  const turn = turns.at(-1);
  if (!turn?.out.quick) return;
  turn.out = await engine.search(turn.intent, 12, ctx(turn.intent));
  renderTurn(turn);
  turn.el.querySelector('.reply')?.insertAdjacentHTML('beforeend', ' <span class="upgraded">✨ Refined with semantic search</span>');
}

function addUserBubble(text, fromVoice) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.innerHTML = `<div class="bubble">${fromVoice ? '🎙 ' : ''}${esc(text)}</div>`;
  els.thread.append(d);
}
function addTurnShell() {
  const d = document.createElement('section');
  d.className = 'msg bot';
  els.thread.append(d);
  els.thread.lastElementChild.previousElementSibling?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return d;
}

// ---------- natural-language reply ----------
const langList = (codes) => {
  const key = [...codes].sort().join();
  if (key === [...INDIAN_LANGS].sort().join()) return 'Indian';
  if (key === 'kn,ml,ta,te') return 'South Indian';
  return codes.map(langName).join(' / ');
};

function describe(intent) {
  const f = intent.filters, c = engine.catalog;
  const bits = [];
  const q = { high: 'highly rated', hidden: 'under-the-radar', popular: 'popular' }[intent.quality];
  if (q) bits.push(q);
  if (intent.moods.length) bits.push(intent.moods.join(', '));
  if (f.langs) bits.push(langList(f.langs));
  let noun = intent.genres.length ? `${intent.genres.map((g) => g.toLowerCase()).join(' ')} films` : 'films';
  if (intent.genres.join() === 'Comedy') noun = 'comedies';
  if (intent.genres.join() === 'Romance,Comedy') noun = 'romantic comedies';
  if (intent.sports) noun = /cricket/.test(intent.notes.join(' ')) ? 'cricket films' : 'sports films';
  if (f.type === 'tv' || intent.wantsTV) noun = noun.replace(/films$|comedies$/, (w) => (w === 'films' ? 'shows' : 'comedy shows'));
  bits.push(noun);
  if (intent.anchors.length) bits.push(`like ${intent.anchors.map((a) => c[a].title).join(' and ')}`);
  for (const [ax, w] of Object.entries(intent.steer)) {
    if (Math.abs(w) >= 0.75 && intent.anchors.length) bits.push(`but ${AXES[ax].labels[w > 0 ? 1 : 0]}`);
  }
  if (intent.semantic) bits.push(`about “${intent.semantic}”`);
  if (intent.people.length) bits.push(`with ${intent.people.join(' & ')}`);
  if (f.maxRuntime && f.minRuntime) bits.push(`around ${fmtRuntime(Math.round((f.maxRuntime + f.minRuntime) / 2))}`);
  else if (f.maxRuntime) bits.push(`under ${fmtRuntime(f.maxRuntime)}`);
  else if (f.minRuntime) bits.push(`over ${fmtRuntime(f.minRuntime)}`);
  if (f.yearMin && f.yearMax && f.yearMin === f.yearMax) bits.push(`from ${f.yearMin}`);
  else if (f.yearMin && f.yearMax && f.yearMax - f.yearMin === 9 && f.yearMin % 10 === 0) bits.push(`from the ${f.yearMin}s`);
  else if (f.yearMin && f.yearMax) bits.push(`from ${f.yearMin}–${f.yearMax}`);
  else if (f.yearMin) bits.push(`from ${f.yearMin} on`);
  else if (f.yearMax) bits.push(`from before ${f.yearMax + 1}`);
  if (f.excludeLangs) bits.push(`(not in ${langList(f.excludeLangs)})`);
  if (hotstarOnly && engine.hasProviders && !lastRelaxedMine) bits.push('on JioHotstar');
  if (intent.excludeGenres.length) bits.push(`(no ${intent.excludeGenres.map((g) => g.toLowerCase()).join(' or ')})`);
  return bits.join(' ');
}

const RELAX_LABEL = { mine: 'the JioHotstar-only filter', 'genres-all': 'match every genre', year: 'the year range', runtime: 'the runtime limit', rating: 'the rating minimum', lang: 'the language', genres: 'the genre', people: 'the cast/crew filter' };

let lastRelaxedMine = false;
function replyText(turn) {
  const { intent, out } = turn;
  lastRelaxedMine = out.relaxed.includes('mine');
  const c = engine.catalog;
  const top = out.results.slice(0, 3).map((r) => c[r.i]);
  if (!top.length) {
    const t = 'I couldn’t find anything for that. Try describing it differently?';
    return { html: t, spoken: t };
  }
  if (out.lowConfidence) {
    const t = 'I’m not sure I understood that, so here are some crowd favourites instead. Try a mood (“feel-good”), a film it should feel like (“like Drishyam”), a language, or how long you’ve got.';
    return { html: esc(t), spoken: 'I’m not sure I understood that. Try a mood, a film it should feel like, or a language.' };
  }
  const what = describe(intent);
  const lead = turn.followUp ? (intent.refine.more ? 'Here are some more' : 'Got it, updated. Here are') : 'Here are';
  let html = `${lead} ${esc(what)}.`;
  let spoken = `${lead} ${what.replace(/[“”()]/g, '')}.`;
  if (intent.titleHit != null && !turn.followUp) {
    const t = c[intent.titleHit];
    html = `Here’s <b>${esc(t.title)}</b> (${t.year}), plus films like it.`;
    spoken = `Here’s ${t.title}, plus films like it.`;
  }
  if (out.relaxed.length && !(out.relaxed.includes('people') && intent.peopleLang)) {
    const r = out.relaxed.map((x) => RELAX_LABEL[x]).join(' and ');
    const n = out.exactCount;
    const lead2 = n ? `Only ${n} title${n === 1 ? '' : 's'} matched everything (shown first); the rest are close matches with` : 'Not many titles matched everything, so I loosened';
    html += ` <span class="warn">${lead2} ${esc(n ? `${r} loosened` : r)}.</span>`;
    spoken += n ? ` Only ${n} matched everything, so I added close matches.` : ` I had to loosen ${r} to find enough.`;
  }
  spoken += ` My top pick is ${top[0].title}, from ${top[0].year}`;
  spoken += top.length > 2 ? `, followed by ${top[1].title} and ${top[2].title}.` : '.';
  spoken += ' Want me to narrow it down?';
  for (const n of intent.notes || []) html += ` <span class="warn">${esc(n)}</span>`;
  if (intent.translated) html += ` <span class="warn">(understood as “${esc(intent.translated)}”)</span>`;
  if (out.quick && liteMode() && !engine.embedder) html += ' <span class="warn">Lite mode: keyword matching to save data.</span> <button type="button" class="btn-ghost small smart-on">✨ Turn on smart matching (≈34 MB, once)</button>';
  else if (out.quick) html += ' <span class="warn">Quick results while smarter matching loads; they’ll refine automatically.</span>';
  return { html, spoken };
}

// ---------- interpretation chips (each one removable) ----------
function chips(intent) {
  const f = intent.filters, c = engine.catalog, out = [];
  const add = (label, kind, key) => out.push({ label, kind, key });
  for (const a of intent.anchors) add(`like ${c[a].title} (${c[a].year})`, 'anchor', ['anchor', a]);
  for (const [ax, w] of Object.entries(intent.steer)) if (Math.abs(w) >= 0.75 || !intent.moods.length) add(`${AXES[ax].labels[w > 0 ? 1 : 0]}${Math.abs(w) < 0.75 ? ' (slightly)' : ''}`, 'steer', ['steer', ax]);
  for (const m of intent.moods) add(m, 'mood', ['mood', m]);
  if (f.langs) add(langList(f.langs), 'lang', ['lang']);
  if (f.excludeLangs) add(`not ${langList(f.excludeLangs)}`, 'neg', ['lang']);
  for (const g of intent.genres) add(g, 'genre', ['genre', g]);
  for (const g of intent.softGenres) add(`~${g}`, 'soft', ['soft', g]);
  for (const g of intent.excludeGenres) add(`no ${g}`, 'neg', ['exclude', g]);
  for (const p of intent.people) add(p, 'person', ['person', p]);
  if (f.maxRuntime && f.minRuntime) add(`${fmtRuntime(f.minRuntime)}–${fmtRuntime(f.maxRuntime)}`, 'filter', ['runtime']);
  else if (f.maxRuntime) add(`≤ ${fmtRuntime(f.maxRuntime)}`, 'filter', ['runtime']);
  else if (f.minRuntime) add(`≥ ${fmtRuntime(f.minRuntime)}`, 'filter', ['runtime']);
  if (f.yearMin || f.yearMax) add(f.yearMin === f.yearMax ? `${f.yearMin}` : `${f.yearMin ?? '…'}–${f.yearMax ?? 'now'}`, 'filter', ['year']);
  if (f.minRating) add(`★ ≥ ${f.minRating}`, 'filter', ['rating']);
  if (intent.quality) add({ high: 'highly rated', hidden: 'hidden gems', popular: 'popular' }[intent.quality], 'filter', ['quality']);
  if (intent.semantic) add(`“${intent.semantic}”`, 'semantic', ['semantic']);
  if (hotstarOnly && engine.hasProviders) add('on JioHotstar', 'lang', ['hotstar']);
  return out;
}

function removeConstraint(intent, key) {
  const it = structuredClone(intent);
  const [k, v] = key;
  if (k === 'anchor') it.anchors = it.anchors.filter((a) => a !== v);
  if (k === 'steer') delete it.steer[v];
  if (k === 'mood') { it.moods = it.moods.filter((m) => m !== v); it.expansions = []; it.softGenres = []; it.avoidGenres = []; }
  if (k === 'genre') it.genres = it.genres.filter((g) => g !== v);
  if (k === 'soft') it.softGenres = it.softGenres.filter((g) => g !== v);
  if (k === 'exclude') it.excludeGenres = it.excludeGenres.filter((g) => g !== v);
  if (k === 'person') it.people = it.people.filter((p) => p !== v);
  if (k === 'runtime') { delete it.filters.maxRuntime; delete it.filters.minRuntime; }
  if (k === 'year') { delete it.filters.yearMin; delete it.filters.yearMax; }
  if (k === 'rating') delete it.filters.minRating;
  if (k === 'lang') { delete it.filters.langs; delete it.filters.excludeLangs; }
  if (k === 'quality') it.quality = null;
  if (k === 'semantic') it.semantic = '';
  return it;
}

// ---------- tiles ----------
function tile(i, { rank, badge, cap, why } = {}) {
  const m = engine.catalog[i];
  const img = m.poster ? `<img src="${IMG}w342${m.poster}" alt="" loading="lazy" onerror="this.remove()">` : '';
  const sub = `${m.year} · ${langName(m.lang)} · ★ ${m.rating.toFixed(1)}`;
  const w = taste ? taste.weight(i) : 0;
  const t = `<div class="tile" role="button" tabindex="0" data-i="${i}" aria-label="${esc(m.title)}">
    <span class="ph">${esc(m.title)}</span>${img}
    ${badge ? '<span class="badge">TOP<b>10</b></span>' : ''}
    ${rank != null ? `<span class="rk">${rank}</span>` : ''}
    ${m.yt ? '<span class="has-trailer" title="Trailer available">▶</span>' : ''}
    ${engine.hasProviders && engine.onMyApps(m, ['hotstar']) ? '<span class="on-hs" title="Streaming on JioHotstar">JioHotstar</span>' : ''}
    <span class="over"><strong>${esc(m.title)}</strong><span>${sub}</span>
      <span class="thumbs"><button type="button" data-t="1" class="${w >= 0.5 ? 'on' : ''}" aria-label="I like this">👍</button><button type="button" data-t="-1" class="${w <= -0.5 ? 'on' : ''}" aria-label="Not for me">👎</button></span>
    </span>
  </div>`;
  if (!cap) return t;
  return `<div class="cell">${t}<div class="cap"><strong>${esc(m.title)}</strong><span>${m.year} · ${fmtRuntime(m.runtime)} · ${esc(langName(m.lang))}</span>${why?.length ? `<em>${why.map(esc).join(' · ')}</em>` : ''}</div></div>`;
}

function railHTML(title, ids, { sub, top10, ask } = {}) {
  if (!ids.length) return '';
  const items = top10
    ? ids.slice(0, 10).map((i, n) => `<div class="tile-wrap"><span class="num" aria-hidden="true">${n + 1}</span>${tile(i)}</div>`).join('')
    : ids.map((i, n) => tile(i, { badge: n < 3 && !ask })).join('');
  return `<section class="railrow ${top10 ? 'top10' : ''}">
    <h3>${esc(title)}${sub ? ` <small>${esc(sub)}</small>` : ''}</h3>
    <div class="scroller"><button class="nav l" type="button" aria-label="Scroll left">‹</button>
      <div class="track-x">${items}</div>
      <button class="nav r" type="button" aria-label="Scroll right">›</button></div>
  </section>`;
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.scroller .nav');
  if (nav) {
    const tr = nav.parentElement.querySelector('.track-x');
    tr.scrollBy({ left: (nav.classList.contains('r') ? 1 : -1) * tr.clientWidth * 0.85, behavior: 'smooth' });
    return;
  }
  const th = e.target.closest('.tile [data-t]');
  if (th) { rate(+th.closest('.tile').dataset.i, +th.dataset.t); return; }
  const t = e.target.closest('.tile');
  if (t) openDetail(+t.dataset.i);
});
document.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('.tile');
  if (t && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) { e.preventDefault(); openDetail(+t.dataset.i); }
});

// Explicit feedback from anywhere (tiles, detail sheet). Updates every visible copy of the title.
function rate(i, w) {
  if (!taste) { toast('One moment, still loading…'); return; }
  taste.toggle(i, w);
  const cur = taste.weight(i);
  track('rate', { id: engine.catalog[i].id, lang: engine.catalog[i].lang, w: cur });
  document.querySelectorAll(`.tile[data-i="${i}"]`).forEach((el) => {
    el.querySelector('[data-t="1"]')?.classList.toggle('on', cur >= 0.5);
    el.querySelector('[data-t="-1"]')?.classList.toggle('on', cur <= -0.5);
  });
  toast(cur >= 0.5 ? `Noted, you like ${engine.catalog[i].title}. Tuning your picks.` : cur <= -0.5 ? 'Got it, fewer like that.' : 'Removed from your taste.');
}

let toastTimer = null;
function toast(text) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}

// ---------- home ----------
let heroTimer = null;
let heroIds = [];
function renderHome() {
  const c = engine.catalog;
  const indianPrefs = prefs.filter((l) => INDIAN_LANGS.includes(l));
  const homeLangs = indianPrefs.length ? indianPrefs : INDIAN_LANGS;
  const onHS = (m) => !(hotstarOnly && engine.hasProviders) || engine.onMyApps(m, ['hotstar']);
  const rail = (f, k, sort) => engine.rail((m) => onHS(m) && m.type === 'movie' && f(m), k, sort);
  const tvRail = (f, k, sort) => engine.rail((m) => onHS(m) && m.type === 'tv' && f(m), k, sort);
  const top = rail((m) => homeLangs.includes(m.lang) && m.year >= 2015 && m.backdrop, 10);
  heroIds = top.slice(0, 5);
  renderHero(heroIds);

  let html = railHTML(`Top 10 in India${homeLangs.length > 3 ? '' : ` · ${homeLangs.map(langName).join(', ')}`}`, top, { top10: true });
  html += '<div id="personal"></div>';
  for (const l of prefs) {
    const name = langName(l);
    if (INDIAN_LANGS.includes(l)) {
      html += railHTML(`Popular in ${name}`, rail((m) => m.lang === l, 20));
      html += railHTML(`New ${name} releases`, rail((m) => m.lang === l && m.year >= 2019, 20, 'recent'));
    } else {
      html += railHTML(l === 'en' ? 'Hollywood blockbusters' : `Popular in ${name}`, rail((m) => m.lang === l, 20));
    }
  }
  html += railHTML('Popular series', tvRail((m) => prefs.includes(m.lang) || m.lang === 'en', 20));
  html += '<div id="themed"></div>';
  els.rails.innerHTML = html;
  void c;
}

function renderHero(ids) {
  clearInterval(heroTimer);
  if (!ids.length) { els.hero.hidden = true; return; }
  const c = engine.catalog;
  let k = 0;
  const paint = () => {
    const m = c[ids[k]];
    els.hero.innerHTML = `
      <div class="bg" style="background-image:url('${IMG}w1280${m.backdrop}')"></div>
      <div class="hero-body">
        <div class="hero-kicker"><span class="tag-top">TOP 10</span> #${k + 1} · All-time favourites in ${esc(langName(m.lang))}</div>
        <h2>${esc(m.title)}</h2>
        <p class="meta"><b>${m.year}</b> · ${fmtRuntime(m.runtime)} · ${esc(langName(m.lang))} · ${m.genres.slice(0, 3).map(esc).join(', ')} · <b>★ ${m.rating.toFixed(1)}</b></p>
        <p class="ov">${esc(m.overview || m.tagline || '')}</p>
        <div class="hero-actions">
          <button type="button" class="btn-grad" data-like="${ids[k]}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 9.2 8.6 2 9.3l5.5 4.8L5.8 21 12 17.3 18.2 21l-1.7-6.9L22 9.3l-7.2-.7z"/></svg>
            Find more like this</button>
          <button type="button" class="btn-ghost" data-open="${ids[k]}">Details</button>
        </div>
      </div>
      <div class="hero-thumbs">${ids.map((i, j) => `<button type="button" data-hk="${j}" class="${j === k ? 'on' : ''}" style="background-image:url('${IMG}w300${c[i].backdrop}')" aria-label="${esc(c[i].title)}"></button>`).join('')}</div>`;
  };
  paint();
  els.hero.onclick = (e) => {
    const t = e.target.closest('[data-hk],[data-like],[data-open]');
    if (!t) return;
    if (t.dataset.hk) { k = +t.dataset.hk; paint(); restart(); }
    if (t.dataset.like) submit(`more like ${c[+t.dataset.like].title}`, false);
    if (t.dataset.open) openDetail(+t.dataset.open);
  };
  const restart = () => { clearInterval(heroTimer); heroTimer = setInterval(() => { k = (k + 1) % ids.length; paint(); }, 7000); };
  restart();
}

// Personal rails: "Picked for you" ranks by closeness to the taste vector; "Because you liked X"
// is the same anchor query chat uses. Before any likes, a prompt to tune instead.
async function renderPersonalRails() {
  const el = $('#personal');
  if (!el || !taste) return;
  if (!taste.vector) {
    el.innerHTML = `<section class="tune">
      <div><h3>Make Home yours</h3><p>Tap 👍 on a few films (or pick favourites) and PopcornPal learns your taste, on this device only.</p></div>
      <button type="button" class="btn-grad" data-nav="taste">Pick favourites</button></section>`;
    return;
  }
  const c = engine.catalog, rated = new Set(taste.entries().map(([i]) => i));
  const picked = engine.rail((m) => true, 400)
    .filter((i) => !rated.has(i))
    .map((i) => [taste.z[i] + 0.35 * engine.quality[i] + 0.2 * engine.fame[i] + (prefs.includes(c[i].lang) ? 0.5 : 0) + (subs.length && engine.onMyApps(c[i], subs) ? 0.4 : 0), i])
    .sort((a, b) => b[0] - a[0]).slice(0, 18).map(([, i]) => i);
  let html = railHTML('Picked for you', picked, { sub: `based on ${taste.size} like${taste.size === 1 ? '' : 's'}`, ask: true });
  const last = taste.lastLiked();
  if (ready && last != null) {
    const out = await engine.search(parse(`more like ${c[last].title}`, engine.index), 18, ctx());
    html += railHTML(`Because you liked ${c[last].title}`, out.results.map((r) => r.i).filter((i) => !rated.has(i)), { ask: true });
  }
  el.innerHTML = html;
}
function refreshHome() { renderPersonalRails(); }

// ---------- taste onboarding ----------
function openTasteSheet() {
  if (!taste) { releaseGate(); toast('One moment, still loading…'); return; }
  const c = engine.catalog;
  const langs = prefs.length ? prefs : ['hi', 'en'];
  const per = Math.max(4, Math.ceil(24 / langs.length));
  const ids = [...new Set(langs.flatMap((l) => engine.rail((m) => m.lang === l && m.poster, per)))];
  const grid = $('#taste-grid');
  const paint = () => {
    grid.innerHTML = ids.map((i) => `<button type="button" class="tpick ${taste.weight(i) >= 0.5 ? 'on' : ''}" data-i="${i}">
      <img src="${IMG}w185${c[i].poster}" alt="" loading="lazy"><span>${esc(c[i].title)}</span></button>`).join('');
  };
  paint();
  grid.onclick = (e) => { const b = e.target.closest('.tpick'); if (b) { taste.toggle(+b.dataset.i, 1); b.classList.toggle('on', taste.weight(+b.dataset.i) >= 0.5); } };
  $('#taste-reset').onclick = () => { taste.reset(); paint(); };
  els.tasteSheet.showModal();
}

// ---------- "Only on JioHotstar" ----------
// Recommending only what the platform can actually play is the difference between a discovery
// demo and a discovery feature. Needs where-to-watch data (TMDB sync); until then it explains why.
const hsToggle = $('#hs-only');
function paintHotstarToggle() {
  const ready = engine.catalog && engine.hasProviders;
  hsToggle.classList.toggle('on', hotstarOnly && ready);
  hsToggle.setAttribute('aria-pressed', String(hotstarOnly && ready));
  hsToggle.classList.toggle('unavailable', !ready);
  hsToggle.title = ready ? 'Show only titles streaming on JioHotstar in India' : 'Needs where-to-watch data: available after the TMDB data sync';
}
hsToggle.addEventListener('click', async () => {
  if (!engine.hasProviders) { toast('“Only on JioHotstar” needs where-to-watch data, which arrives with the TMDB sync.'); return; }
  hotstarOnly = !hotstarOnly;
  store.set('pp.hsOnly', hotstarOnly);
  track('subs', { hotstarOnly });
  paintHotstarToggle();
  const turn = turns.at(-1);
  if (turn && !els.chat.hidden) { turn.out = await engine.search(turn.intent, 12, ctx(turn.intent)); renderTurn(turn); }
  else { renderHome(); renderPersonalRails(); if (engine.semanticReady) renderThemedRails(); }
});

// ---------- my streaming apps ----------
function renderSubs() {
  $('#subs-grid').innerHTML = PROVIDERS.map(([key, name]) =>
    `<label><input type="checkbox" value="${key}" ${subs.includes(key) ? 'checked' : ''}><b>${esc(name)}</b></label>`).join('');
  $('#opt-only-mine').checked = onlyMine;
  $('#opt-smart').value = smartMode;
  $('#opt-analytics').checked = analyticsEnabled();
  $('#opt-analytics').disabled = analyticsBlockedByBrowser();
  if (analyticsBlockedByBrowser()) $('#analytics-note').textContent = 'Off: your browser asks sites not to track (Global Privacy Control / Do Not Track).';
  if (!engine.hasProviders) $('#subs-note').textContent = 'Where-to-watch data appears after the TMDB sync. Your choices are saved and will apply then.';
}
els.settings.addEventListener('close', () => {
  subs = [...$('#subs-grid').querySelectorAll('input:checked')].map((i) => i.value);
  onlyMine = $('#opt-only-mine').checked;
  store.set('pp.subs', subs);
  store.set('pp.onlyMine', onlyMine);
  track('subs', { subs, onlyMine });
  const nextSmart = $('#opt-smart').value;
  if (nextSmart !== smartMode) {
    smartMode = nextSmart; store.set('pp.smart', smartMode);
    if (!liteMode()) releaseModel();
    else if (engine.embedder) toast('Lite mode applies from your next visit (the model is already downloaded).');
  }
  setAnalytics($('#opt-analytics').checked);
  refreshHome();
});

// Themed rails are just saved queries run through the same NLU + ranker.
async function renderThemedRails() {
  const themed = [
    ['Masala entertainers', 'mass masala action entertainer'],
    ['If you liked RRR', 'more like RRR'],
    ['Edge-of-your-seat South Indian thrillers', 'gripping south indian crime thriller with twists'],
    ['Feel-good family entertainers', 'feel good family entertainer'],
    ['Mind-bending picks', 'mind-bending psychological thriller with a twist'],
    ['Based on true stories', 'inspiring true story biopic'],
  ];
  let html = '';
  for (const [title, q] of themed) {
    // Home rails lean into the viewer's Indian languages (English is everywhere already).
    const railPrefs = prefs.filter((l) => INDIAN_LANGS.includes(l));
    const out = await engine.search(parse(q, engine.index), 18, { ...ctx(), prefs: railPrefs.length ? railPrefs : prefs });
    html += railHTML(title, out.results.map((r) => r.i), { sub: `“${q}”`, ask: true });
  }
  const el = $('#themed');
  if (el) el.innerHTML = html;
}

// ---------- chat rendering ----------
function renderTurn(turn) {
  const { intent, out, el } = turn;
  const c = engine.catalog;
  const reply = replyText(turn);
  const ch = chips(intent);
  el.innerHTML = `
    <div class="reply-row"><p class="reply">${reply.html}</p>
      ${out.results.length ? '<button type="button" class="btn-ghost small preview-these">▶ Preview these</button>' : ''}</div>
    <div class="chips" aria-label="How I understood your request">
      <span class="chips-label">Understood as</span>
      ${ch.map((x, j) => `<button type="button" class="chip ${x.kind}" data-j="${j}" title="Remove this and re-rank">${esc(x.label)}<span aria-hidden="true">×</span></button>`).join('')}
    </div>
    <div class="results"><div class="track-x">${out.results.map((r, n) => tile(r.i, { rank: n + 1, cap: true, why: why(c[r.i], r, intent) })).join('')}</div></div>
    <details class="debug">
      <summary>How this was ranked</summary>
      <dl>
        <dt>Embedded text</dt><dd>${out.semanticText ? `<code>${esc(out.semanticText)}</code>` : '<em>none: ranked by quality + filters</em>'}${intent.anchors.length ? ` + vector of ${intent.anchors.map((a) => `<b>${esc(c[a].title)}</b>`).join(', ')}` : ''}</dd>
        <dt>Candidates</dt><dd>${out.poolSize.toLocaleString()} of ${c.length.toLocaleString()} passed hard filters${out.relaxed.length ? ` (relaxed: ${out.relaxed.join(', ')})` : ''}</dd>
        <dt>Score</dt><dd>semantic z-score + quality prior + popularity + genre priors + attribute steering${prefs.length ? ` + language preference (${prefs.map(langName).join(', ')})` : ''}${taste?.vector ? ` + your taste (${taste.size} likes)` : ''}${subs.length ? ' + on your apps' : ''}, then MMR for variety</dd>
        <dt>Latency</dt><dd>${out.timing.embed.toFixed(0)} ms embed · ${out.timing.rank.toFixed(0)} ms rank (on your device)</dd>
      </dl>
    </details>`;
  turn.scores = new Map(out.results.map((r) => [r.i, r]));
  el.querySelector('.smart-on')?.addEventListener('click', (e) => { e.target.disabled = true; e.target.textContent = 'Loading smart matching…'; releaseModel(); });
  el.querySelector('.preview-these')?.addEventListener('click', () => track('preview', { from: 'chat', n: out.results.length }) || openFeed(out.results.map((r) => r.i), `Previewing: ${describe(intent)}`));
  el.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', async () => {
    if (ch[+b.dataset.j].key[0] === 'hotstar') { hsToggle.click(); return; } // same as flipping the toggle off
    turn.intent = removeConstraint(intent, ch[+b.dataset.j].key);
    turn.out = await engine.search(turn.intent, 12, ctx(turn.intent));
    renderTurn(turn);
  }));
}

function why(m, r, intent) {
  const out = [];
  const p = r.parts;
  if (intent.anchors.length && r.sim != null) out.push(`${Math.round(r.sim * 100)}% similar`);
  else if (r.sim != null && p.semantic > 2) out.push('strong match');
  const g = [...intent.genres, ...intent.softGenres].filter((x) => m.genres.includes(x));
  if (g.length) out.push(g.slice(0, 2).join(' + '));
  for (const [ax, w] of Object.entries(intent.steer)) {
    if (!engine.axes) continue; // steering labels need the model (not loaded in Lite mode)
    const z = engine.axes[ax].proj[r.i];
    if (Math.sign(z) === Math.sign(w) && Math.abs(z) > 0.4) out.push(AXES[ax].labels[w > 0 ? 1 : 0]);
  }
  if (intent.quality === 'hidden' && m.votes < 3000) out.push('under the radar');
  if (intent.quality === 'high' && m.rating >= 7.5) out.push(`★ ${m.rating}`);
  if (p.taste > 0.6) out.unshift('for you');
  if (p.access) out.push(engine.providersOf(m).find((x) => subs.some((k) => x.n.toLowerCase().includes(k)))?.n || 'on your apps');
  return out.slice(0, 2);
}

// ---------- where to watch ----------
function watchHTML(m) {
  if (!engine.hasProviders) return '';
  const link = `https://www.themoviedb.org/${m.type}/${m.id}/watch?locale=IN`;
  const groups = [['s', 'Stream'], ['r', 'Rent'], ['b', 'Buy']]
    .map(([k, label]) => [label, engine.providersOf(m, k)]).filter(([, ps]) => ps.length);
  if (!groups.length) return '<p class="watch none">Not streaming in India right now (per TMDB / JustWatch).</p>';
  return `<div class="watch">${groups.map(([label, ps]) => `<div><span>${label}</span>${ps.slice(0, 5).map((p) =>
    `<a href="${link}" target="_blank" rel="noopener" title="${esc(p.n)}" class="${subs.some((k) => p.n.toLowerCase().includes(k)) ? 'mine' : ''}">${p.l ? `<img src="${IMG}w92${p.l}" alt="${esc(p.n)}">` : esc(p.n)}</a>`).join('')}</div>`).join('')}
    <small>Availability via JustWatch</small></div>`;
}

// ---------- detail sheet ----------
function openDetail(i) {
  const m = engine.catalog[i];
  const turn = [...turns].reverse().find((t) => t.scores?.has(i));
  const r = turn?.scores.get(i);
  const rank = turn ? turn.out.results.findIndex((x) => x.i === i) + 1 : 0;
  track('click', { id: m.id, lang: m.lang, rank: rank || undefined, from: turn ? 'search' : 'home' });
  const w = r ? why(m, r, turn.intent) : [];
  const breakdown = r ? Object.entries(r.parts).filter(([, v]) => Math.abs(v) > 0.01).map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(' · ') + ` = ${r.score.toFixed(2)}` : '';
  els.detail.innerHTML = `
    <div class="dbg" style="background-image:url('${m.backdrop ? IMG + 'w1280' + m.backdrop : m.poster ? IMG + 'w780' + m.poster : ''}')"></div>
    <button class="x" type="button" aria-label="Close">×</button>
    <div class="dbody">
      <div class="dposter">${m.poster ? `<img src="${IMG}w342${m.poster}" alt="">` : ''}</div>
      <div>
        <h2>${esc(m.title)}</h2>
        <p class="meta">${m.year} · ${fmtRuntime(m.runtime)} · ${esc(langName(m.lang))} · <span class="star">★</span> ${m.rating.toFixed(1)}</p>
        <p class="meta">${m.genres.map(esc).join(' | ')}</p>
        <p class="ov">${esc(m.overview)}</p>
        ${m.directors.length ? `<p class="crew"><b>Director</b> ${m.directors.map(esc).join(', ')}</p>` : ''}
        ${m.cast.length ? `<p class="crew"><b>Starring</b> ${m.cast.slice(0, 5).map(esc).join(', ')}</p>` : ''}
        ${watchHTML(m)}
        ${w.length ? `<div class="why">${w.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        ${breakdown ? `<p class="score" title="Score components (z-score units)">${esc(breakdown)}</p>` : ''}
        <div class="acts">
          ${m.yt ? '<button type="button" class="btn-grad" data-act="trailer">▶ Trailer</button>' : ''}
          <button type="button" class="${m.yt ? 'btn-ghost' : 'btn-grad'}" data-act="like">More like this</button>
          <button type="button" class="btn-ghost thumb ${taste?.weight(i) >= 0.5 ? 'on' : ''}" data-act="up" aria-label="I like this">👍</button>
          <button type="button" class="btn-ghost thumb ${taste?.weight(i) <= -0.5 ? 'on' : ''}" data-act="down" aria-label="Not for me">👎</button>
          <a class="btn-ghost" href="https://www.themoviedb.org/${m.type}/${m.id}" target="_blank" rel="noopener">TMDB ↗</a>
        </div>
      </div>
    </div>`;
  els.detail.onclick = (e) => {
    if (e.target === els.detail || e.target.closest('.x')) return els.detail.close();
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'up' || a.dataset.act === 'down') {
      rate(i, a.dataset.act === 'up' ? 1 : -1);
      els.detail.querySelector('[data-act=up]').classList.toggle('on', taste.weight(i) >= 0.5);
      els.detail.querySelector('[data-act=down]').classList.toggle('on', taste.weight(i) <= -0.5);
      return;
    }
    els.detail.close();
    if (a.dataset.act === 'trailer') openFeed([i], m.title);
    if (a.dataset.act === 'like') submit(`more like ${m.title}`, false);
    if (a.dataset.act === 'hide' && turn) {
      turn.intent.exclude = [...(turn.intent.exclude || []), i];
      engine.search(turn.intent, 12, ctx(turn.intent)).then((o) => { turn.out = o; renderTurn(turn); });
    }
  };
  els.detail.showModal();
}
