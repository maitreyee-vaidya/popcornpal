#!/usr/bin/env bash
# One-shot refresh: pull fresh TMDB data (where-to-watch, trailers, 2023+ releases, TV, cast),
# rebuild the catalog + embeddings, and deploy. Safe to run from any folder.
# Needs TMDB_API_KEY=... in ~/popcornpal-tmdb.env (free at https://www.themoviedb.org/settings/api).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f ~/popcornpal-tmdb.env ]; then
  echo "No TMDB key yet. Create it first:"
  echo "  echo 'TMDB_API_KEY=your_read_access_token' > ~/popcornpal-tmdb.env"
  exit 1
fi

if grep -q "PASTE_TOKEN_HERE\|your_read_access_token" ~/popcornpal-tmdb.env; then
  echo "~/popcornpal-tmdb.env still has the placeholder text, not your real TMDB token."
  exit 1
fi

# Python environment for the data scripts (created once, reused after).
if [ ! -x .venv/bin/python ]; then
  echo "Setting up Python environment (one time)…"
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

# Raw datasets (downloaded once; ~600 MB, stays outside the website folder).
mkdir -p raw
fetch() { [ -s "raw/$1" ] || { echo "Downloading $1…"; curl -fsSL -o "raw/$1" "$2"; }; }
fetch recommovie.csv "https://huggingface.co/datasets/kinjalrk2k/Recommovie-TMDB-Dataset/resolve/main/db_exported.csv"
fetch tmdb_5000_credits.csv "https://huggingface.co/datasets/maximus007411/tmdb-5000-movie-data/resolve/main/tmdb_5000_credits.csv"
fetch imdb_india.csv "https://huggingface.co/datasets/jason1966/adrianmcmahon_imdb-india-movies/resolve/main/IMDb%20Movies%20India.csv"
fetch telugu.csv "https://huggingface.co/datasets/rohitvaddepalli/TeluguMovies/resolve/main/TeluguMovies_dataset.csv"

echo "Fetching from TMDB (≈15 min)…"
.venv/bin/python scripts/fetch_tmdb.py all
echo "Rebuilding catalog and embeddings…"
.venv/bin/python scripts/build_dataset.py
echo "Deploying…"
cd web && npx --yes vercel@latest deploy --prod --yes
