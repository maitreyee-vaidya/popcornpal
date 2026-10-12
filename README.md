# PopcornPal: conversational movie discovery

Type or say what you're in the mood for, like *"a feel good comedy under two hours"* or *"something like Inception but less confusing"*. Then refine it the way you would with a friend: *"shorter"*, *"no romance"*, *"more like the second one"*.

Everything runs in the browser. No backend, no paid APIs and no API keys are needed to run it.

## Indian cinema, first-class

- **Catalog of 12,424 films**, including 1,697 Hindi, 586 Tamil, 583 Malayalam, 399 Telugu, 115 Bengali and 47 Kannada titles.
- **Per-language inclusion floors.** TMDB votes skew heavily Western; RRR, the most-voted Telugu film, has about 1k votes. A single global cutoff therefore drops nearly all Indian films, so Indian languages use their own lower floors.
- **IMDb India enrichment.** Lead cast, directors and IMDb votes are matched in by title and year. IMDb votes act as a cross-market popularity signal (`pv`).
- **Indian query understanding:**
  - film industries: Tollywood, Kollywood, Mollywood, Sandalwood and Bollywood
  - groups: "south Indian", "Indian", "regional"
  - moods: "masala", "mass entertainer", "family entertainer", "patriotic", "pan-India", "cricket"
- **Language preferences**, as in a streaming profile. They order the home rails and add a soft lift in ranking, while a language named in the query always wins.
- **Voice** defaults to the English (India) accent model.

## UI

The UI is a dark streaming-app layout: left nav rail, spotlight hero, Top 10 and language rails, gradient call-to-action and a detail sheet. It's an independent concept, not affiliated with or endorsed by any streaming service, and it uses no third-party logos or trademarks. The themed home rails ("Masala entertainers", "Because you liked RRR") are saved natural-language queries run through the same NLU and ranker as chat.

## Personalisation, previews, where to watch

- **Taste learning, on-device.** 👍/👎 on any poster, in the detail sheet or in Previews moves a single preference vector in the same embedding space as the catalog.
  - It feeds a `taste` term into ranking, lighter when you name a reference title.
  - It powers the "Picked for you" and "Because you liked X" rails.
  - "Pick favourites" bootstraps it in one sheet.
  - Nothing leaves the browser (`localStorage`).
- **Previews feed.** A vertical swipe feed (Douyin / Reels style) that autoplays muted trailers as each card snaps into view, mounting only one player at a time. It learns implicitly:
  - watching for more than 8s is a soft like
  - flicking past in under 1.5s is a soft "nope"

  Candidates are scored by taste + quality + language + your apps, with Gumbel noise so the feed explores rather than collapsing into one genre. "▶ Preview these" turns any chat answer into a feed.
  - Trailers come from MovieLens' free YouTube trailer list: 3,836 verified live and embeddable via oEmbed, mostly Hollywood. `fetch_tmdb.py enrich` adds TMDB's official trailers, including Indian-language ones.
- **Where to watch (India).** The detail sheet shows the stream / rent / buy providers from TMDB (JustWatch data).
  - "My streaming apps" gives a ranking lift to titles on your apps.
  - "Only show what I can watch", "on Netflix" and "something I can watch tonight" filter to them.
  - This needs a TMDB sync (below).

## What makes it more than a search bar

```
"something like Inception but less confusing, under 2 hours"
        │
        ▼
  ┌──────────────── query understanding (js/nlu.js) ────────────────┐
  │ reference title  → "Inception" (fuzzy title resolution)          │
  │ relative modifier→ complexity axis, direction −1 ("less confusing")│
  │ hard constraint  → runtime ≤ 120                                  │
  │ leftover text    → "" (nothing else to embed)                     │
  └──────────────────────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────── retrieval + ranking (js/engine.js) ─────────────┐
  │ query vector = Inception's embedding (+ embedded leftover text)  │
  │ hard filters, with progressive relaxation if too few survive     │
  │ score = semantic z-score                                         │
  │       + Bayesian quality prior + popularity                       │
  │       + genre priors (from moods / reference title)               │
  │       + attribute steering (projection on "complex ↔ simple")     │
  │ MMR re-rank for variety (no five-sequel pages)                    │
  └──────────────────────────────────────────────────────────────────┘
```

- **Semantic search with embeddings.** `bge-small-en-v1.5` embeds every title's text (title, genres, tagline, plot and TMDB keywords) offline. The same ONNX model embeds the query in the browser through transformers.js, so both sides share one vector space.
- **Query decomposition.** Embedding a raw query blurs constraints and description together; for example, "feel good" matches *Feel the Beat* lexically. The parser pulls out the following:
  - runtime ("under two hours", "an hour and a half", "not too long")
  - era ("90s", "before 2000", "recent")
  - rating ("highly rated", "hidden gems")
  - language ("korean", "foreign")
  - people ("Tom Hanks", "Nolan movies")
  - genres, including negation ("no horror")
  - moods, which expand into descriptive text ("feel-good" becomes "uplifting, heartwarming…")
  - reference titles ("like X", "funnier than X")

  Only what's left over is embedded.
- **Attribute steering.** "Less confusing", "darker", "funnier" and "slower" use five semantic axes (complexity, darkness, humor, intensity, pace). Each axis is the difference between two embedded pole descriptions, and every title is projected onto it. That lets "like Inception but simpler" move along one dimension while staying close to Inception.
- **Conversation state.** Follow-ups are detected and merged into the previous intent. Relative refinements ("shorter", "newer") are computed from the current results. Ordinal references ("more like the second one") work too.
- **Transparency.** Each answer shows *Understood as* chips; click a chip to remove that constraint and re-rank. Results show why they matched, and *How this was ranked* exposes the embedded text, the candidate count and the latency. Expanding a card shows its full score breakdown.

## Voice

- **Speech to text:** two engines, chosen in the *Voice* menu.
  - **Browser:** Web Speech API (Chrome, Edge, Safari). It shows a live transcript and needs no download. In Chrome the audio goes to Google's speech service, which is free.
  - **On-device:** Whisper `tiny.en` via transformers.js. It downloads about 40 MB once, the audio never leaves the device, and it works in Firefox. Recording stops automatically after a pause.
- **Text to speech:** replies are read aloud with the browser's built-in `speechSynthesis`, e.g. *"My top pick is Up, from 2009, followed by…"*.
- **Hands-free mode:** after each spoken reply the app listens again, so you can keep refining by voice.
- **Shortcut:** `⌘/Ctrl + Space` toggles the mic.

## Case study

`/case-study.html` is the product write-up: problem, users, North-Star (search-to-play), guardrails, an A/B plan (~8,400 searching users per arm for +2 pp at α 0.05 / power 0.8), measured evidence, trade-offs and roadmap.

## Quality and performance

- **Three eval sets** (`/eval.html`):
  - **Blind v2**, 20 queries, never tuned against: **16/20**. This is the number to quote.
  - **Field**, 20 queries from a hands-on user test: 7 → 20/20 after fixes.
  - **Blind v1**: 14 → 18/20 across the fix round, then retired.
  - **Dev**: 58/58.
- **Graceful failure:**
  - Thin or unknown filmographies fall back to the star's language and say so.
  - Bare titles go first, and a missing sequel is called out ("Pushpa 2 isn't in my catalog yet").
  - Live sports, TV shows, awards and dub requests get an honest note plus the nearest useful films.
  - Everyday phrasing is understood ("cheer me up", "with my wife", "rainy day").
- **Data fix:** title+year IMDb joins that grabbed a different same-named film (Malayalam "The Don" → Hindi "Don") are rejected when the popularity is wildly inconsistent.
- **Lite mode** (Settings → Search mode, or automatic on slow or data-saver connections): keyword matching plus small data files only. The 34 MB model is an opt-in button.
- **"Only on JioHotstar"** toggle filters every answer and rail to titles streaming on JioHotstar. It switches on once the TMDB where-to-watch sync has run (`scripts/sync_and_deploy.sh`).
- **Dev set details:** 58 queries plus a 6-turn conversation, each with an automatic check on the top 10. It covers constraints, reference titles, Indian cinema, people, topics, languages, Hinglish/Devanagari and robustness. 40 queries plus a 6-turn conversation, each with an automatic check on the top 10. It covers constraints, reference titles, Indian cinema, people, topics, languages, Hinglish/Devanagari and robustness. Latency p50 ≈ 27 ms, p95 < 85 ms on-device.
- **Hybrid retrieval:** embedding similarity plus a lexical term for exact topical words ("cricket", "zombie") that embeddings blur.
- **Graceful relaxation:** if few titles match everything, exact matches are shown first ("Only 2 matched…") and the rest are close matches. A named language is loosened after genre.
- **Low-confidence detection:** when the top match barely beats the 50th, the reply says it didn't understand, rather than pretending.
- **Staged loading:** Home renders from a 1.3 MB core catalog in ~0.5 s and quick search (parser + filters + keywords) answers in ~1 s. Plot text and vectors stream next; the 34 MB model arrives last and silently upgrades the current answer.
- **Data saver:** on 2G/3G or Save-Data connections (or with `?lite`), the 34 MB model loads only when you start searching. Home and rails render from the catalog alone.

## Indian languages

- **Typed:** Hindi, Telugu, Tamil, Malayalam, Kannada, Bengali or Marathi script, or Hinglish.
  - A script lexicon covers genres, moods and filler words, and the query leans toward the language it's written in.
  - Native-script original titles ("పోకిరి లాంటి సినిమా", "a movie like Pokiri") resolve "like X".
  - Cross-script titles ("பாகுபலి மாதிரி படம்", "a film like Baahubali" in Tamil) are matched by romanizing the shared Indic layout and comparing sound-alike keys.
  - Where Chrome's on-device Translator API exists, the full sentence is translated in the background and the answer refines. It never blocks: if the translator doesn't respond, the lexicon answer stands.
- **Spoken:** pick a language next to the mic.
  - The browser engine uses `hi-IN`, `te-IN`, `ta-IN`, etc.
  - On-device mode uses multilingual Whisper (`whisper-base`) in *transcribe* mode. In tests with synthesized Hindi and Tamil speech, translate mode garbled the words, while transcribe got them right in the native script. (Hindi comes back in Urdu script, a known Whisper quirk; the lexicon covers it.)
  - Tested end to end: an Indian-English clip, two Hindi clips (Lekha voice) and a Tamil clip (Vani voice) each returned on-target results in about 3 s.
- **Star names:** spelling variants ("Shahrukh"), fan nicknames (SRK, Thalaivar, Big B, Jr NTR) and one-word names (Prabhas, Rajinikanth, Kajol) resolve to the credited actor.
  - Replies are read back in an Indian-English voice when available.

## Analytics (anonymous, opt-out)

- **Collected:** searches (scrubbed text plus mode, language and result stats), result clicks with rank, 👍/👎, and preview views with dwell time.
- **Not collected:** accounts, cookies or device IDs. Each visit gets a random per-tab ID.
- **Off** for Global Privacy Control or Do Not Track, and via a toggle in Settings.
- **Pipeline:** `navigator.sendBeacon` sends to `/api/e` (a Vercel function) into Neon Postgres (`pp_events`). `/api/stats` and `/insights.html` show aggregates; query text appears only when 2+ sessions asked it.
- **Connect (free):** Vercel → popcornpal → Storage → Create Database → Neon → connect, then redeploy. Without a database the endpoint returns 204 and drops events.

## Cost: all free

| Piece | What it uses | Cost |
|---|---|---|
| Movie data | TMDB snapshot hosted on Hugging Face, plus IMDb India and Telugu IMDb lists (12,424 films) | Free, no key |
| Posters | `image.tmdb.org` CDN | Free, no key |
| Embeddings | `bge-small-en-v1.5`, run in Python at build time and in the browser at query time | Free, runs locally |
| Model hosting | Hugging Face Hub CDN (the browser caches it after the first load) | Free |
| Voice | Web Speech API / on-device Whisper / `speechSynthesis` | Free |
| Hosting | Static files only: Vercel Hobby, Netlify or GitHub Pages | Free tier |

No server and no database, so there's nothing that can bill per request.

## Run it locally

```bash
python3 scripts/serve.py 8000      # then open http://localhost:8000
```

`web/` is fully self-contained: the built catalog and embeddings are already in `web/data/`.

## Rebuild the dataset

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
mkdir -p raw
curl -L -o raw/recommovie.csv https://huggingface.co/datasets/kinjalrk2k/Recommovie-TMDB-Dataset/resolve/main/db_exported.csv
curl -L -o raw/imdb_india.csv "https://huggingface.co/datasets/jason1966/adrianmcmahon_imdb-india-movies/resolve/main/IMDb%20Movies%20India.csv"
curl -L -o raw/telugu.csv https://huggingface.co/datasets/rohitvaddepalli/TeluguMovies/resolve/main/TeluguMovies_dataset.csv
curl -L -o raw/tmdb_5000_credits.csv https://huggingface.co/datasets/maximus007411/tmdb-5000-movie-data/resolve/main/tmdb_5000_credits.csv
.venv/bin/python scripts/build_dataset.py        # MIN_VOTES=300 by default
```

### TMDB sync: where-to-watch, trailers, 2023–25 releases, TV (free key)

1. Get a free key at <https://www.themoviedb.org/settings/api>.
2. Put it in a file outside the repo so it's never committed or deployed:

```bash
echo 'TMDB_API_KEY=your_read_access_token' > ~/popcornpal-tmdb.env
```

3. Run the sync and rebuild:

```bash
.venv/bin/python scripts/fetch_tmdb.py all      # ~15 min: enrich every title + recent releases + TV
.venv/bin/python scripts/build_dataset.py
```

`enrich` adds India watch providers, official trailers (preferring the film's own language), missing cast/crew and fresh posters. `recent` adds 2023+ releases for each Indian language plus global hits. `tv` adds popular shows. Re-run weekly to keep availability current.

## Deploy (free)

`web/` is a static site.

- **Vercel:** `cd web && npx vercel --prod`, or import the repo and set the root directory to `web`, with no build command.
- **Netlify or GitHub Pages:** publish the `web/` folder as-is.

## Files

```
scripts/build_dataset.py   clean data, build doc text, embed, int8-quantize
scripts/fetch_tmdb.py      optional TMDB API fetcher (movies + TV)
scripts/serve.py           no-cache local dev server
web/js/nlu.js              query understanding: constraints, moods, anchors, steering, follow-ups
web/js/engine.js           embedding, scoring, relaxation, MMR
web/js/voice.js            speech in (Web Speech / Whisper) and out (speechSynthesis)
web/js/app.js              conversation UI, home rails, detail sheet
web/js/taste.js            on-device taste profile (likes/dislikes -> preference vector)
web/js/feed.js             swipeable trailer feed with implicit feedback
web/js/eval.js, eval.html  search-quality regression suite
web/js/telemetry.js        anonymous, consent-aware event batching
web/api/e.js, stats.js     Vercel functions: event ingest + aggregate stats (Neon)
web/insights.html          product metrics dashboard
```

This product uses the TMDB API but is not endorsed or certified by TMDB.
