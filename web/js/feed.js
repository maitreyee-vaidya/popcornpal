// Vertical, swipeable preview feed: trailers autoplay (muted) as each card snaps into view.
// It learns while you swipe: watching past ~8s is a soft "like", flicking past in under
// ~1.5s is a soft "not for me". Explicit 👍/👎 always outrank these implicit signals.

const IMG = 'https://image.tmdb.org/t/p/';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtRuntime = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);

export class Feed {
  constructor({ root, engine, taste, ctx, langName, onMoreLike, onDetail, onClose, onEvent = () => {} }) {
    Object.assign(this, { root, engine, taste, ctx, langName, onMoreLike, onDetail, onClose, onEvent });
    this.muted = true;
    this.seen = new Set();
    this.queue = [];
    this.active = null;
    this.enteredAt = 0;
    this.root.innerHTML = `
      <div class="feed-top">
        <button type="button" class="feed-back" aria-label="Back">‹</button>
        <div class="feed-title"><b>Previews</b><span id="feed-sub">Swipe up for the next one</span></div>
        <button type="button" class="feed-mute" aria-label="Unmute">🔇</button>
      </div>
      <div class="feed-track" tabindex="0"></div>
      <div class="feed-hint">↑ ↓ to browse · L like · D not for me · M sound</div>`;
    this.track = root.querySelector('.feed-track');
    root.querySelector('.feed-back').onclick = () => this.onClose();
    this.muteBtn = root.querySelector('.feed-mute');
    this.muteBtn.onclick = () => this.setMuted(!this.muted);

    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.6) this.activate(e.target);
    }, { root: this.track, threshold: [0.6] });

    this.track.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('keydown', (e) => this.onKey(e));
  }

  // seed: optional list of catalog indices (e.g. "Preview these" from a chat answer)
  open(seed, label) {
    this.leave();
    this.track.innerHTML = '';
    this.seen.clear();
    this.queue = seed?.length ? [...seed] : [];
    this.seedMode = !!seed?.length;
    this.root.querySelector('#feed-sub').textContent = label || (this.taste.vector ? 'Tuned to your taste · swipe up' : 'Swipe up · 👍/👎 teach it your taste');
    this.append(8);
    this.track.scrollTop = 0;
    this.track.focus({ preventScroll: true });
  }

  // Candidate generation for the open feed: taste + quality + language preference, with a
  // little exploration noise so it doesn't collapse into one genre, favouring titles with trailers.
  nextBatch(n) {
    if (this.queue.length) return this.queue.splice(0, n).filter((i) => !this.seen.has(i));
    const e = this.engine, c = e.catalog, ctx = this.ctx();
    const prefs = ctx.prefs || [];
    const tz = this.taste.z;
    const disliked = new Set(this.taste.disliked());
    const scored = [];
    for (let i = 0; i < c.length; i++) {
      const m = c[i];
      if (this.seen.has(i) || disliked.has(i) || this.taste.weight(i) >= 0.5 || (!m.yt && !m.backdrop)) continue;
      if (ctx.onlyMine && ctx.subs?.length && !e.onMyApps(m, ctx.subs)) continue; // "Only on JioHotstar" applies here too
      let s = 0.6 * e.quality[i] + 0.4 * e.fame[i] + (m.yt ? 0.8 : 0) + (prefs.includes(m.lang) ? 0.7 : 0);
      if (tz) s += 0.9 * tz[i];
      if (ctx.subs?.length && e.onMyApps(m, ctx.subs)) s += 0.5;
      s += -Math.log(-Math.log(Math.random() + 1e-9)) * 0.55; // Gumbel noise = sampling, not argmax
      scored.push([s, i]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, n).map(([, i]) => i);
  }

  append(n) {
    const ids = this.nextBatch(n);
    for (const i of ids) {
      this.seen.add(i);
      const card = document.createElement('section');
      card.className = 'fcard';
      card.dataset.i = i;
      card.innerHTML = this.cardHTML(i);
      this.track.append(card);
      this.io.observe(card);
    }
    if (!ids.length && !this.track.querySelector('.fend')) {
      const end = document.createElement('section');
      end.className = 'fcard fend';
      end.innerHTML = '<div class="fend-body"><h3>That’s the lot</h3><p>Ask for something specific, or open Previews from Home for an endless mix.</p></div>';
      this.track.append(end);
    }
  }

  cardHTML(i) {
    const m = this.engine.catalog[i];
    const bg = m.backdrop ? `${IMG}w1280${m.backdrop}` : m.poster ? `${IMG}w780${m.poster}` : '';
    const prov = this.engine.providersOf(m).slice(0, 3);
    const w = this.taste.weight(i);
    return `
      <div class="fmedia" style="background-image:url('${bg}')"></div>
      <div class="fshade"></div>
      <div class="finfo">
        ${m.yt ? '' : '<span class="fnote">No trailer yet · still image</span>'}
        <h3>${esc(m.title)}</h3>
        <p class="fmeta">${m.year} · ${fmtRuntime(m.runtime)} · ${esc(this.langName(m.lang))} · ★ ${m.rating.toFixed(1)}</p>
        <p class="fgen">${m.genres.slice(0, 3).map(esc).join(' · ')}</p>
        <p class="fov">${esc(m.overview)}</p>
        ${prov.length ? `<p class="fprov">Watch on ${prov.map((p) => esc(p.n)).join(', ')}</p>` : ''}
      </div>
      <div class="facts">
        <button type="button" data-f="like" class="${w >= 0.5 ? 'on' : ''}" aria-label="I like this"><span>👍</span><small>Like</small></button>
        <button type="button" data-f="nope" class="${w <= -0.5 ? 'on' : ''}" aria-label="Not for me"><span>👎</span><small>Nope</small></button>
        <button type="button" data-f="more" aria-label="More like this"><span>✨</span><small>More</small></button>
        <button type="button" data-f="info" aria-label="Details"><span>ⓘ</span><small>Info</small></button>
      </div>`;
  }

  activate(card) {
    if (card === this.active || card.classList.contains('fend')) return;
    this.leave();
    this.active = card;
    this.enteredAt = performance.now();
    const m = this.engine.catalog[+card.dataset.i];
    if (m.yt) {
      // Mount the player only for the visible card; unmount on leave (keeps memory flat).
      const src = `https://www.youtube-nocookie.com/embed/${m.yt}?autoplay=1&mute=${this.muted ? 1 : 0}&controls=0&playsinline=1&rel=0&modestbranding=1&loop=1&playlist=${m.yt}&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
      const f = document.createElement('iframe');
      f.className = 'fplayer';
      f.src = src;
      f.allow = 'autoplay; encrypted-media; picture-in-picture';
      f.title = `${m.title} trailer`;
      f.setAttribute('frameborder', '0');
      f.referrerPolicy = 'strict-origin-when-cross-origin'; // YouTube refuses embeds with no referrer (error 153)
      card.querySelector('.fmedia').append(f);
    } else {
      card.querySelector('.fmedia').classList.add('kenburns');
    }
    const cards = [...this.track.querySelectorAll('.fcard')];
    if (cards.length - cards.indexOf(card) < 4) this.append(6);
  }

  // Implicit feedback from dwell time on the card being left.
  leave() {
    const card = this.active;
    if (!card) return;
    const i = +card.dataset.i, dwell = (performance.now() - this.enteredAt) / 1000;
    this.onEvent('view', { id: this.engine.catalog[i].id, dwell: Math.round(dwell * 10) / 10, trailer: !!this.engine.catalog[i].yt });
    if (Math.abs(this.taste.weight(i)) < 0.5) {
      if (dwell > 8) this.taste.nudge(i, 0.2);
      else if (dwell < 1.5) this.taste.nudge(i, -0.1);
    }
    card.querySelector('.fplayer')?.remove();
    card.querySelector('.fmedia')?.classList.remove('kenburns');
    this.active = null;
  }

  setMuted(m) {
    this.muted = m;
    this.muteBtn.textContent = m ? '🔇' : '🔊';
    this.muteBtn.setAttribute('aria-label', m ? 'Unmute' : 'Mute');
    const f = this.active?.querySelector('.fplayer');
    f?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: m ? 'mute' : 'unMute', args: [] }), '*');
  }

  onClick(e) {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    const card = b.closest('.fcard'), i = +card.dataset.i;
    const act = b.dataset.f;
    this.onEvent(act, { id: this.engine.catalog[i].id });
    if (act === 'like') { this.taste.toggle(i, 1); this.refreshButtons(card); if (this.taste.weight(i) > 0) this.next(); }
    if (act === 'nope') { this.taste.toggle(i, -1); this.refreshButtons(card); if (this.taste.weight(i) < 0) this.next(); }
    if (act === 'more') this.onMoreLike(i);
    if (act === 'info') this.onDetail(i);
  }

  refreshButtons(card) {
    const w = this.taste.weight(+card.dataset.i);
    card.querySelector('[data-f=like]').classList.toggle('on', w >= 0.5);
    card.querySelector('[data-f=nope]').classList.toggle('on', w <= -0.5);
  }

  next(dir = 1) {
    const cards = [...this.track.querySelectorAll('.fcard')];
    const k = Math.max(0, cards.indexOf(this.active));
    cards[Math.min(cards.length - 1, Math.max(0, k + dir))]?.scrollIntoView({ behavior: 'smooth' });
  }

  onKey(e) {
    if (e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowdown' || k === 'j') { e.preventDefault(); this.next(1); }
    if (k === 'arrowup' || k === 'k') { e.preventDefault(); this.next(-1); }
    if (k === 'l' && this.active) this.active.querySelector('[data-f=like]').click();
    if (k === 'd' && this.active) this.active.querySelector('[data-f=nope]').click();
    if (k === 'm') this.setMuted(!this.muted);
    if (k === 'escape') this.onClose();
  }

  close() { this.leave(); this.track.innerHTML = ''; }
}
