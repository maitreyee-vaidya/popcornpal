"""Build the search corpus + precomputed embeddings for the web app.

Inputs (free, no API key needed; see README for download commands):
  raw/recommovie.csv          TMDB export with posters/keywords (HF: kinjalrk2k/Recommovie-TMDB-Dataset)
  raw/tmdb_5000_credits.csv   cast + crew for ~4.8k films (HF: maximus007411/tmdb-5000-movie-data)
  raw/imdb_india.csv          IMDb India: cast/director/votes for Indian films (HF: jason1966/adrianmcmahon_imdb-india-movies)
  raw/telugu.csv              Telugu IMDb ratings (HF: rohitvaddepalli/TeluguMovies)
  raw/tmdb_api.jsonl          optional, produced by fetch_tmdb.py (adds TV shows + fresh titles)

Outputs:
  web/data/catalog.json       compact metadata used for filtering/display
  web/data/embeddings.bin     int8 matrix [N x 384], row-aligned with catalog.json
  web/data/meta.json          model name, dims, scale

The embedding model is the exact ONNX file transformers.js loads in the browser,
so document vectors (built here) and query vectors (built client-side) share a space.
"""
import hashlib
import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import numpy as np
import onnxruntime as ort
import pandas as pd
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "web", "data")
MODEL_ID = "Xenova/bge-small-en-v1.5"
MIN_VOTES = int(os.environ.get("MIN_VOTES", 300))


def split_list(s):
    if not isinstance(s, str) or not s.strip():
        return []
    return [x.strip() for x in s.split(",") if x.strip()]


def load_credits():
    path = os.path.join(RAW, "tmdb_5000_credits.csv")
    if not os.path.exists(path):
        return {}
    cr = pd.read_csv(path)
    out = {}
    for row in cr.itertuples():
        cast = sorted(json.loads(row.cast), key=lambda c: c["order"])[:6]
        directors = [c["name"] for c in json.loads(row.crew) if c["job"] == "Director"]
        out[int(row.movie_id)] = ([c["name"] for c in cast], directors[:2])
    return out


# Indian-language films get far fewer TMDB votes than Hollywood titles (RRR, the most-voted
# Telugu film, has ~1k; an average Hollywood hit has 10k+), so a single global cutoff drops
# nearly all of them. Use per-language floors, and let IMDb votes vouch for a title too.
INDIAN_LANGS = {"hi", "te", "ta", "ml", "kn", "bn", "mr", "pa", "gu", "or", "as"}
INDIAN_MIN_VOTES = int(os.environ.get("INDIAN_MIN_VOTES", 8))
IMDB_MIN_VOTES = 500
TODAY = date.today().isoformat()


def title_key(title, year):
    t = unicodedata.normalize("NFKD", str(title)).encode("ascii", "ignore").decode().lower()
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    t = re.sub(r"^(the|a|an) ", "", t)
    return t, int(year)


def load_imdb_india():
    """IMDb India (Kaggle mirror): director, lead actors, IMDb rating/votes for ~15k Indian films.
    Plus a Telugu IMDb list for extra rating/vote coverage. Keyed by (normalized title, year)."""
    out = {}
    path = os.path.join(RAW, "imdb_india.csv")
    if os.path.exists(path):
        df = pd.read_csv(path, encoding="latin-1")
        for r in df.itertuples():
            y = re.search(r"(\d{4})", str(r.Year))
            if not y or not isinstance(r.Name, str):
                continue
            votes = int(str(r.Votes).replace(",", "")) if str(r.Votes).replace(",", "").isdigit() else 0
            cast = [a for a in (r._8, r._9, r._10) if isinstance(a, str)]
            out[title_key(r.Name, y.group(1))] = {
                "cast": cast, "directors": [r.Director] if isinstance(r.Director, str) else [],
                "irating": float(r.Rating) if pd.notna(r.Rating) else None, "ivotes": votes,
            }
    path = os.path.join(RAW, "telugu.csv")
    if os.path.exists(path):
        df = pd.read_csv(path)
        for r in df.itertuples():
            if pd.isna(r.Year) or not isinstance(r.Movie, str):
                continue
            k = title_key(r.Movie, int(r.Year))
            votes = int(r._9) if pd.notna(r._9) else 0
            cur = out.setdefault(k, {"cast": [], "directors": [], "irating": None, "ivotes": 0})
            if votes > cur["ivotes"]:
                cur["ivotes"], cur["irating"] = votes, float(r.Rating) if pd.notna(r.Rating) else None
    return out


def imdb_lookup(imdb, title, year):
    for dy in (0, -1, 1):
        hit = imdb.get(title_key(title, year + dy))
        if hit:
            return hit
    return None


def native_title(original, title):
    """Keep the original title only when it's in an Indic/other script ("పోకిరి"), so native-script
    queries can resolve reference titles. Latin-script originals add nothing."""
    if isinstance(original, str) and original != title and re.search(r"[^\x00-\u024f]", original):
        return {"ot": original}
    return {}


def load_movies():
    cols = ["id", "title", "original_title", "vote_average", "vote_count", "status", "release_date", "runtime",
            "adult", "original_language", "overview", "popularity", "poster_path", "backdrop_path", "tagline",
            "genres", "keywords"]
    df = pd.read_csv(os.path.join(RAW, "recommovie.csv"), usecols=cols, low_memory=False)
    df = df[(df.status == "Released") & (df.adult != True) & (df.release_date <= TODAY)]
    df = df[df.overview.notna() & (df.runtime > 0) & df.release_date.notna()]
    indian = df.original_language.isin(INDIAN_LANGS)
    df = df[(df.vote_count >= MIN_VOTES) | (indian & (df.vote_count >= 3) & df.poster_path.notna())]
    df = df.drop_duplicates("id")
    credits = load_credits()
    imdb = load_imdb_india()
    items = []
    for r in df.itertuples():
        year = int(str(r.release_date)[:4])
        cast, directors = credits.get(int(r.id), ([], []))
        ivotes, irating = 0, None
        if r.original_language in INDIAN_LANGS:
            hit = imdb_lookup(imdb, r.title, year) or imdb_lookup(imdb, r.original_title, year)
            # Title+year joins can grab a different film with the same name (Malayalam "The Don"
            # 2006 -> Hindi "Don" 2006). Reject matches whose popularity is wildly out of line.
            if hit and r.vote_count < 50 and hit["ivotes"] > max(2000, 400 * max(1, r.vote_count)):
                hit = None
            if hit:
                cast, directors = cast or hit["cast"], directors or hit["directors"]
                ivotes, irating = hit["ivotes"], hit["irating"]
            if r.vote_count < INDIAN_MIN_VOTES and ivotes < IMDB_MIN_VOTES:
                continue
        rating = float(r.vote_average)
        if r.vote_count < 50 and irating:  # too few TMDB votes to trust; IMDb's is steadier
            rating = irating
        items.append({
            "id": int(r.id), "type": "movie", "title": r.title,
            "year": year, "runtime": int(r.runtime),
            "genres": split_list(r.genres), "keywords": split_list(r.keywords)[:12],
            "rating": round(rating, 1), "votes": int(r.vote_count),
            # Popularity proxy comparable across markets: IMDb votes run ~10-15x TMDB's.
            "pv": max(int(r.vote_count), ivotes // 12),
            "popularity": round(float(r.popularity), 1), "lang": r.original_language,
            "poster": r.poster_path if isinstance(r.poster_path, str) else None,
            "backdrop": r.backdrop_path if isinstance(r.backdrop_path, str) else None,
            "tagline": r.tagline if isinstance(r.tagline, str) else "",
            "overview": r.overview, "cast": cast, "directors": directors,
            **native_title(r.original_title, r.title),
        })
    return items


def load_trailers():
    """YouTube trailer IDs. MovieLens' free ml-youtube list (keyed by title + year) is the
    no-key baseline; raw/tmdb_enrich.jsonl (fetch_tmdb.py --enrich) overrides it."""
    out = {}
    path = os.path.join(RAW, "ml-youtube.csv")
    if os.path.exists(path):
        for r in pd.read_csv(path).itertuples():
            m = re.match(r"(.*) \((\d{4})\)\s*$", str(r.title))
            if m:
                t = re.sub(r"^(.*), (The|A|An)$", r"\2 \1", m.group(1))
                out.setdefault(title_key(t, m.group(2)), r.youtubeId)
    return out


def check_youtube(ids):
    """Keep only videos that still exist and allow embedding (YouTube oEmbed, no key).
    Results are cached in raw/yt_ok.json so rebuilds don't re-check."""
    cache_path = os.path.join(RAW, "yt_ok.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    todo = [i for i in set(ids) if i not in cache]

    def ok(vid):
        url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}")
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                return vid, r.status == 200
        except urllib.error.HTTPError:
            return vid, False
        except Exception:
            return vid, None  # network hiccup: don't cache

    with ThreadPoolExecutor(16) as pool:
        for n, (vid, good) in enumerate(pool.map(ok, todo), 1):
            if good is not None:
                cache[vid] = good
            if n % 250 == 0:
                print(f"\rchecked {n}/{len(todo)} trailers", end="", file=sys.stderr)
    if todo:
        print(file=sys.stderr)
    json.dump(cache, open(cache_path, "w"))
    return {i for i, good in cache.items() if good}


def load_enrichment():
    path = os.path.join(RAW, "tmdb_enrich.jsonl")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return {(e["type"], e["id"]): e for e in map(json.loads, f) if e}


def attach_extras(items):
    """Trailers + where-to-watch (India) onto catalog items."""
    trailers = load_trailers()
    enrich = load_enrichment()
    for m in items:
        e = enrich.get((m["type"], m["id"]))
        yt = (e or {}).get("trailer")
        if not yt and m["type"] == "movie":
            yt = trailers.get(title_key(m["title"], m["year"])) or trailers.get(title_key(m["title"], m["year"] - 1))
        if yt:
            m["yt"] = yt
        if e:
            if e.get("providers"):
                m["wp"] = e["providers"]
            if e.get("cast") and not m["cast"]:
                m["cast"] = e["cast"]
            if e.get("directors") and not m["directors"]:
                m["directors"] = e["directors"]
            for k in ("poster", "backdrop"):
                if e.get(k):
                    m[k] = e[k]
    live = check_youtube([m["yt"] for m in items if "yt" in m])
    for m in items:
        if "yt" in m and m["yt"] not in live:
            del m["yt"]
    providers = {}
    for e in enrich.values():
        providers.update(e.get("provider_names", {}))
    return providers


def load_api_items():
    path = os.path.join(RAW, "tmdb_api.jsonl")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


LANG_NAMES = {"hi": "Hindi", "te": "Telugu", "ta": "Tamil", "ml": "Malayalam", "kn": "Kannada", "bn": "Bengali",
              "mr": "Marathi", "pa": "Punjabi", "gu": "Gujarati", "fr": "French", "ko": "Korean", "ja": "Japanese",
              "es": "Spanish", "it": "Italian", "de": "German", "zh": "Chinese", "cn": "Cantonese"}
INDUSTRY = {"hi": "Bollywood", "te": "Tollywood", "ta": "Kollywood", "ml": "Mollywood", "kn": "Sandalwood"}


def doc_text(m):
    # What the embedding "reads". Genres + keywords carry mood/theme signal that
    # plot summaries alone often lack ("feel-good", "heist", "time loop").
    lang = LANG_NAMES.get(m["lang"])
    kind = "TV series" if m["type"] == "tv" else "film"
    parts = [f"{m['title']} ({m['year']}), a {m['runtime']}-minute {lang + '-language ' if lang else ''}{kind}."]
    if m["lang"] in INDUSTRY:
        parts.append(f"{INDUSTRY[m['lang']]} Indian cinema.")
    if m["genres"]:
        parts.append("Genres: " + ", ".join(m["genres"]) + ".")
    if m["tagline"]:
        parts.append(m["tagline"])
    parts.append(m["overview"])
    if m["keywords"]:
        parts.append("Themes: " + ", ".join(m["keywords"]) + ".")
    return " ".join(parts)


def embed(texts, batch=64):
    model_path = hf_hub_download(MODEL_ID, "onnx/model_quantized.onnx")
    tok = Tokenizer.from_file(hf_hub_download(MODEL_ID, "tokenizer.json"))
    tok.enable_truncation(512)
    tok.enable_padding()
    sess = ort.InferenceSession(model_path)
    input_names = {i.name for i in sess.get_inputs()}
    vecs = []
    for i in range(0, len(texts), batch):
        enc = tok.encode_batch(texts[i:i + batch])
        feeds = {
            "input_ids": np.array([e.ids for e in enc], dtype=np.int64),
            "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64),
        }
        if "token_type_ids" in input_names:
            feeds["token_type_ids"] = np.array([e.type_ids for e in enc], dtype=np.int64)
        hidden = sess.run(None, feeds)[0]
        cls = hidden[:, 0]  # bge uses CLS pooling
        vecs.append(cls / np.linalg.norm(cls, axis=1, keepdims=True))
        print(f"\rembedded {min(i + batch, len(texts))}/{len(texts)}", end="", file=sys.stderr)
    print(file=sys.stderr)
    return np.vstack(vecs).astype(np.float32)


def main():
    # Fresh API data (if fetched) wins over the bundled snapshot for the same title.
    items = load_api_items()
    seen = {(m["type"], m["id"]) for m in items}
    items += [m for m in load_movies() if (m["type"], m["id"]) not in seen]
    for m in items:
        m.setdefault("pv", m["votes"])
    items.sort(key=lambda m: -m["pv"])
    print(f"{len(items)} titles", file=sys.stderr)

    providers = attach_extras(items)
    print(f"{sum('yt' in m for m in items)} trailers, {sum('wp' in m for m in items)} with India watch providers", file=sys.stderr)

    emb_path = os.path.join(OUT, "embeddings.bin")
    if os.environ.get("SKIP_EMBED") and os.path.exists(emb_path):
        # Metadata-only rebuild: reuse vectors, realigned by (type, id) because ranking changes
        # (e.g. corrected vote counts) can reorder the catalog.
        old = json.load(open(os.path.join(OUT, "catalog.json")))
        row = {(m["type"], m["id"]): j for j, m in enumerate(old)}
        prev = np.fromfile(emb_path, dtype=np.int8).reshape(-1, 384).astype(np.float32)
        prev /= json.load(open(os.path.join(OUT, "meta.json")))["scale"]
        missing = [m["title"] for m in items if (m["type"], m["id"]) not in row]
        assert not missing, f"{len(missing)} new titles need embedding; run without SKIP_EMBED"
        vecs = np.stack([prev[row[(m["type"], m["id"])]] for m in items])
    else:
        vecs = embed([doc_text(m) for m in items])
    scale = 127.0 / float(np.abs(vecs).max())
    q = np.clip(np.round(vecs * scale), -127, 127).astype(np.int8)

    os.makedirs(OUT, exist_ok=True)
    q.tofile(os.path.join(OUT, "embeddings.bin"))
    # Split: the core catalog (what Home and filters need) loads first; long text streams in after.
    DETAIL_KEYS = ("overview", "tagline", "keywords")
    core = [{k: v for k, v in m.items() if k not in DETAIL_KEYS} for m in items]
    details = [[m["overview"], m["tagline"], m["keywords"]] for m in items]
    with open(os.path.join(OUT, "catalog.json"), "w") as f:
        json.dump(core, f, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(OUT, "details.json"), "w") as f:
        json.dump(details, f, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(OUT, "providers.json"), "w") as f:
        json.dump(providers, f, separators=(",", ":"))
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        h = hashlib.sha1()
        for name in ("catalog.json", "details.json", "embeddings.bin", "providers.json"):
            h.update(open(os.path.join(OUT, name), "rb").read())
        version = h.hexdigest()[:10]
        json.dump({"version": version, "model": MODEL_ID, "dims": int(vecs.shape[1]), "count": len(items),
                   "scale": scale, "query_prefix": "Represent this sentence for searching relevant passages: "}, f)
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
