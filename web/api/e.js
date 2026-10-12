// POST /api/e  — anonymous product events, batched by the client (navigator.sendBeacon).
import { sql, ensureSchema } from './_db.js';

const TYPES = new Set(['session', 'search', 'click', 'rate', 'feed', 'preview', 'voice', 'lang', 'subs']);
const MAX_EVENTS = 40;

// Belt and braces: the client scrubs too, but never store anything that looks like contact details.
const scrub = (s) => String(s ?? '').toLowerCase()
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
  .slice(0, 120);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!sql) return res.status(204).end(); // analytics not connected yet
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { return res.status(400).end(); }
  const sid = String(body?.sid || '').slice(0, 40);
  const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : [];
  if (!/^[a-z0-9]{8,40}$/i.test(sid) || !events.length) return res.status(400).end();

  const rows = events
    .filter((e) => TYPES.has(e?.type))
    .map((e) => {
      const props = e.props && typeof e.props === 'object' ? e.props : {};
      const json = JSON.stringify(props);
      return { sid, type: e.type, q: e.q ? scrub(e.q) : null, props: json.length <= 1500 ? props : {} };
    });
  if (!rows.length) return res.status(204).end();

  try {
    await ensureSchema();
    await sql`insert into pp_events (sid, type, q, props)
      select x->>'sid', x->>'type', x->>'q', coalesce(x->'props', '{}'::jsonb)
      from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) as x`;
  } catch (err) {
    console.error('event insert failed', err);
    return res.status(500).end();
  }
  return res.status(204).end();
}
