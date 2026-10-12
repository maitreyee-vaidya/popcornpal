// Anonymous product analytics. A random id per browser tab session (sessionStorage, not a
// cookie, gone when the tab closes), no account or device identifiers, query text scrubbed of
// anything that looks like contact details. Off when the browser sends Global Privacy Control /
// Do Not Track, or when the viewer opts out in Settings.
const KEY = 'pp.analytics';
const queue = [];
let timer = null;

const optedOut = () => { try { return localStorage.getItem(KEY) === 'off'; } catch { return false; } };
const browserSaysNo = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
export const analyticsEnabled = () => !optedOut() && !browserSaysNo();
export const analyticsBlockedByBrowser = browserSaysNo;
export function setAnalytics(on) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ } }

function sessionId() {
  try {
    let id = sessionStorage.getItem('pp.sid');
    if (!id) { id = crypto.randomUUID().replace(/-/g, '').slice(0, 20); sessionStorage.setItem('pp.sid', id); }
    return id;
  } catch { return (window.__ppSid ??= Math.random().toString(36).slice(2, 14) + Date.now().toString(36)); }
}

const scrub = (s) => String(s ?? '').toLowerCase()
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
  .slice(0, 120);

export function track(type, props = {}, q) {
  const local = /^(localhost|127\.)/.test(location.hostname);
  if (!analyticsEnabled() || (local && !window.__ppAnalyticsDebug)) return;
  queue.push({ type, props, ...(q ? { q: scrub(q) } : {}) });
  clearTimeout(timer);
  timer = setTimeout(flush, queue.length >= 20 ? 0 : 4000);
}

function flush() {
  if (!queue.length) return;
  const body = JSON.stringify({ sid: sessionId(), events: queue.splice(0, 40) });
  const blob = new Blob([body], { type: 'application/json' });
  if (!(navigator.sendBeacon && navigator.sendBeacon('/api/e', blob))) {
    fetch('/api/e', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {});
  }
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
addEventListener('pagehide', flush);
