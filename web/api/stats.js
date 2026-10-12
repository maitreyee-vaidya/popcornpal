// GET /api/stats — aggregate product metrics for the insights page (last 30 days).
// Query text is only shown when at least 2 different sessions asked it (k-anonymity).
import { sql, ensureSchema } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  if (!sql) return res.status(200).json({ connected: false });
  try {
    await ensureSchema();
    const [totals] = await sql`
      select
        count(distinct sid)::int as sessions,
        count(*) filter (where type = 'search')::int as searches,
        count(*) filter (where type = 'search' and props->>'mode' = 'voice')::int as voice_searches,
        count(*) filter (where type = 'search' and (props->>'low')::boolean)::int as low_conf,
        count(*) filter (where type = 'search' and (props->>'n')::int = 0)::int as zero_results,
        count(*) filter (where type = 'search' and (props->>'quick')::boolean)::int as quick_searches,
        count(*) filter (where type = 'search' and (props->>'followUp')::boolean)::int as follow_ups,
        count(*) filter (where type = 'click')::int as clicks,
        count(*) filter (where type = 'rate' and (props->>'w')::float > 0)::int as likes,
        count(*) filter (where type = 'rate' and (props->>'w')::float < 0)::int as dislikes,
        count(distinct sid) filter (where type = 'search')::int as searching_sessions,
        count(distinct sid) filter (where type = 'click')::int as clicking_sessions
      from pp_events where ts > now() - interval '30 days'`;
    const top = await sql`
      select q, count(*)::int as n, count(distinct sid)::int as people
      from pp_events where type = 'search' and q is not null and q <> '' and ts > now() - interval '30 days'
      group by q having count(distinct sid) >= 2 order by n desc limit 25`;
    const misses = await sql`
      select q, count(*)::int as n from pp_events
      where type = 'search' and q is not null and ((props->>'low')::boolean or (props->>'n')::int = 0) and ts > now() - interval '30 days'
      group by q having count(distinct sid) >= 2 order by n desc limit 15`;
    const ranks = await sql`
      select (props->>'rank')::int as rank, count(*)::int as n from pp_events
      where type = 'click' and props ? 'rank' and ts > now() - interval '30 days'
      group by 1 order by 1 limit 12`;
    const langs = await sql`
      select l as lang, count(*)::int as n from pp_events,
        jsonb_array_elements_text(coalesce(props->'langs', '[]'::jsonb)) as l
      where type = 'search' and ts > now() - interval '30 days' group by l order by n desc limit 12`;
    const voiceLangs = await sql`
      select props->>'voiceLang' as lang, count(*)::int as n from pp_events
      where type = 'search' and props->>'mode' = 'voice' and ts > now() - interval '30 days' group by 1 order by n desc`;
    const feed = await sql`
      select props->>'action' as action, count(*)::int as n, round(avg((props->>'dwell')::float)::numeric, 1)::float as avg_dwell
      from pp_events where type = 'feed' and ts > now() - interval '30 days' group by 1 order by n desc`;
    const daily = await sql`
      select to_char(date_trunc('day', ts), 'YYYY-MM-DD') as day, count(*) filter (where type = 'search')::int as searches,
        count(distinct sid)::int as sessions
      from pp_events where ts > now() - interval '30 days' group by 1 order by 1`;
    return res.status(200).json({ connected: true, totals, top, misses, ranks, langs, voiceLangs, feed, daily });
  } catch (err) {
    console.error('stats failed', err);
    return res.status(500).json({ connected: true, error: 'query failed' });
  }
}
