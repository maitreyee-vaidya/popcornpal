"""Pull fresh data from the TMDB API (free key). Standard library only.

The key is read from $TMDB_API_KEY, or from a KEY=VALUE file (default ~/popcornpal-tmdb.env),
so it never needs to be typed into a shell history or shipped with the site.

    python scripts/fetch_tmdb.py all          # enrich + recent + tv (what you usually want)
    python scripts/fetch_tmdb.py enrich       # trailers, India where-to-watch, cast for every catalog title
    python scripts/fetch_tmdb.py recent       # 2023+ releases: each Indian language + global hits
    python scripts/fetch_tmdb.py tv --tv 1500 # popular TV shows
    python scripts/build_dataset.py           # then rebuild the catalog + embeddings

Writes raw/tmdb_enrich.jsonl (per-title extras) and raw/tmdb_api.jsonl (new titles).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
API = "https://api.themoviedb.org/3"
REGION = "IN"
INDIAN_LANGS = ["hi", "te", "ta", "ml", "kn", "bn", "mr", "pa", "gu"]
VIDEO_LANGS = "en," + ",".join(INDIAN_LANGS) + ",null"

# TV genres are coarser than movie genres; map them onto the movie vocabulary the app uses.
TV_GENRES = {
    "Action & Adventure": ["Action", "Adventure"], "Sci-Fi & Fantasy": ["Science Fiction", "Fantasy"],
    "War & Politics": ["War"], "Kids": ["Family"], "Soap": ["Drama"], "Reality": ["Documentary"],
    "Talk": [], "News": [],
}


def load_key(env_file):
    key = os.environ.get("TMDB_API_KEY", "").strip()
    if key:
        return key
    path = os.path.expanduser(env_file)
    if os.path.exists(path):
        for line in open(path):
            k, _, v = line.strip().partition("=")
            if k.strip() == "TMDB_API_KEY":
                return v.strip().strip("'\"")
    sys.exit(f"No TMDB key found. Set TMDB_API_KEY or put TMDB_API_KEY=... in {path} "
             "(free at https://www.themoviedb.org/settings/api).")


KEY = ""


def get(path, **params):
    headers = {"Accept": "application/json"}
    if KEY.startswith("ey"):  # v4 "API Read Access Token"
        headers["Authorization"] = f"Bearer {KEY}"
    else:  # v3 API key
        params["api_key"] = KEY
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(1.5 * 2 ** attempt)
                continue
            if e.code == 404:
                return None
            if e.code == 401:
                sys.exit("TMDB rejected the key (401). Check the value in your env file.")
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1.5 * 2 ** attempt)
    return None


def pick_trailer(videos, lang):
    """Prefer official YouTube trailers in the film's own language, then English, then teasers."""
    vids = [v for v in (videos or {}).get("results", []) if v.get("site") == "YouTube"]

    def rank(v):
        return (
            {"Trailer": 0, "Teaser": 1}.get(v.get("type"), 2),
            0 if v.get("official") else 1,
            {lang: 0, "en": 1}.get(v.get("iso_639_1"), 2),
            -(v.get("size") or 0),
        )
    vids.sort(key=rank)
    return vids[0]["key"] if vids and rank(vids[0])[0] < 2 else None


def pick_providers(wp):
    """India watch options -> compact {s: subscription/free, r: rent, b: buy} + id->name/logo."""
    region = ((wp or {}).get("results") or {}).get(REGION)
    if not region:
        return None, {}
    names, out = {}, {}
    for kind, key in (("flatrate", "s"), ("free", "s"), ("ads", "s"), ("rent", "r"), ("buy", "b")):
        for p in region.get(kind, []):
            out.setdefault(key, [])
            if p["provider_id"] not in out[key]:
                out[key].append(p["provider_id"])
            names[str(p["provider_id"])] = {"n": p["provider_name"], "l": p.get("logo_path")}
    return (out or None), names


def details(kind, tmdb_id):
    return get(f"/{kind}/{tmdb_id}", append_to_response="videos,watch/providers,credits,keywords",
               include_video_language=VIDEO_LANGS)


def extras(kind, d):
    lang = d.get("original_language", "en")
    providers, names = pick_providers(d.get("watch/providers"))
    cast = sorted(d.get("credits", {}).get("cast", []), key=lambda c: c.get("order", 99))[:6]
    if kind == "movie":
        directors = [c["name"] for c in d.get("credits", {}).get("crew", []) if c.get("job") == "Director"]
    else:
        directors = [c["name"] for c in d.get("created_by", [])]
    return {
        "type": kind, "id": d["id"], "trailer": pick_trailer(d.get("videos"), lang),
        "providers": providers, "provider_names": names,
        "cast": [c["name"] for c in cast], "directors": directors[:2],
        "poster": d.get("poster_path"), "backdrop": d.get("backdrop_path"),
    }


def to_item(kind, d):
    if not d or not d.get("overview"):
        return None
    if kind == "movie":
        date_s, runtime = d.get("release_date") or "", d.get("runtime") or 0
        title, kws = d["title"], d.get("keywords", {}).get("keywords", [])
        genres = [g["name"] for g in d.get("genres", [])]
    else:
        date_s = d.get("first_air_date") or ""
        runtime = (d.get("episode_run_time") or [0])[0] or 45
        title, kws = d["name"], d.get("keywords", {}).get("results", [])
        genres = []
        for g in d.get("genres", []):
            genres += TV_GENRES.get(g["name"], [g["name"]])
    if not date_s[:4].isdigit() or date_s > date.today().isoformat() or not runtime:
        return None
    ex = extras(kind, d)
    item = {
        "id": d["id"], "type": kind, "title": title, "year": int(date_s[:4]), "runtime": int(runtime),
        "genres": list(dict.fromkeys(genres)), "keywords": [k["name"] for k in kws][:12],
        "rating": round(float(d.get("vote_average", 0)), 1), "votes": int(d.get("vote_count", 0)),
        "popularity": round(float(d.get("popularity", 0)), 1), "lang": d.get("original_language", "en"),
        "poster": d.get("poster_path"), "backdrop": d.get("backdrop_path"),
        "tagline": d.get("tagline") or "", "overview": d["overview"],
        "cast": ex["cast"], "directors": ex["directors"],
    }
    original = d.get("original_title") or d.get("original_name")
    if original and original != title and any(ord(ch) > 0x24F for ch in original):
        item["ot"] = original
    if kind == "tv":
        item["seasons"] = d.get("number_of_seasons")
    return item, ex


def discover(kind, n, **filters):
    ids, page = [], 1
    while len(ids) < n and page <= 500:
        data = get(f"/discover/{kind}", page=page, include_adult="false", **filters)
        if not data or not data.get("results"):
            break
        ids += [r["id"] for r in data["results"]]
        if page >= data.get("total_pages", 1):
            break
        page += 1
    return list(dict.fromkeys(ids))[:n]


def run_pool(fn, items, label):
    out = []
    with ThreadPoolExecutor(8) as pool:
        for n, res in enumerate(pool.map(fn, items), 1):
            if res:
                out.append(res)
            if n % 200 == 0 or n == len(items):
                print(f"\r{label}: {n}/{len(items)}", end="", file=sys.stderr)
    print(file=sys.stderr)
    return out


def cmd_enrich(args):
    catalog = json.load(open(os.path.join(ROOT, "web", "data", "catalog.json")))
    path = os.path.join(RAW, "tmdb_enrich.jsonl")
    done = set()
    if os.path.exists(path) and not args.refresh:
        with open(path) as f:
            done = {(e["type"], e["id"]) for e in map(json.loads, f)}
    todo = [(m["type"], m["id"]) for m in catalog if (m["type"], m["id"]) not in done]
    print(f"enrich: {len(todo)} titles to fetch ({len(done)} already cached)", file=sys.stderr)

    def one(t):
        d = details(*t)
        return extras(t[0], d) if d else None

    rows = run_pool(one, todo, "enrich")
    with open(path, "w" if args.refresh else "a") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def append_items(kind, ids, label):
    path = os.path.join(RAW, "tmdb_api.jsonl")
    existing = {}
    if os.path.exists(path):
        with open(path) as f:
            existing = {(i["type"], i["id"]): i for i in map(json.loads, f)}
    res = run_pool(lambda i: to_item(kind, details(kind, i)), ids, label)
    enrich_path = os.path.join(RAW, "tmdb_enrich.jsonl")
    with open(enrich_path, "a") as ef:
        for item, ex in res:
            existing[(kind, item["id"])] = item
            ef.write(json.dumps(ex, ensure_ascii=False) + "\n")
    with open(path, "w") as f:
        for it in existing.values():
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    print(f"{label}: {len(res)} titles written", file=sys.stderr)


def cmd_recent(args):
    since = args.since
    ids = []
    for lang in INDIAN_LANGS:
        ids += discover("movie", args.per_lang, with_original_language=lang, sort_by="popularity.desc",
                        **{"primary_release_date.gte": since, "vote_count.gte": 5})
    ids += discover("movie", args.global_n, sort_by="vote_count.desc",
                    **{"primary_release_date.gte": since, "vote_count.gte": 200})
    append_items("movie", list(dict.fromkeys(ids)), "recent")


def cmd_tv(args):
    ids = discover("tv", args.tv, sort_by="vote_count.desc", **{"vote_count.gte": 200})
    for lang in INDIAN_LANGS[:5]:
        ids += discover("tv", 80, with_original_language=lang, sort_by="popularity.desc", **{"vote_count.gte": 5})
    append_items("tv", list(dict.fromkeys(ids)), "tv")


def main():
    global KEY
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["all", "enrich", "recent", "tv"])
    ap.add_argument("--env-file", default="~/popcornpal-tmdb.env")
    ap.add_argument("--refresh", action="store_true", help="re-fetch enrichment for every title")
    ap.add_argument("--since", default="2023-01-01")
    ap.add_argument("--per-lang", type=int, default=120)
    ap.add_argument("--global-n", type=int, default=600)
    ap.add_argument("--tv", type=int, default=1200)
    args = ap.parse_args()
    KEY = load_key(args.env_file)
    os.makedirs(RAW, exist_ok=True)
    if args.command in ("enrich", "all"):
        cmd_enrich(args)
    if args.command in ("recent", "all"):
        cmd_recent(args)
    if args.command in ("tv", "all"):
        cmd_tv(args)


if __name__ == "__main__":
    main()
