// Shared Neon connection. DATABASE_URL is injected by Vercel's Neon integration; without it
// the analytics endpoints no-op, so the site works the same with or without a database.
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const sql = url ? neon(url) : null;

let ready = null;
export function ensureSchema() {
  ready ??= (async () => {
    await sql`create table if not exists pp_events (
      id bigserial primary key,
      ts timestamptz not null default now(),
      sid text not null,
      type text not null,
      q text,
      props jsonb not null default '{}'::jsonb
    )`;
    await sql`create index if not exists pp_events_ts on pp_events (ts)`;
    await sql`create index if not exists pp_events_type_ts on pp_events (type, ts)`;
  })();
  return ready;
}
