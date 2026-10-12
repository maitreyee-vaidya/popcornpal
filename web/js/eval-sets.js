// Two extra eval sets, kept separate from the dev set in eval.js on purpose.
//
// FIELD: the 20 queries from a hands-on user test (Oct 2026). Fixes were made against these,
//        so they're "seen" data: a regression guard, not an honest quality estimate.
// BLIND: written before any of those fixes and never tuned against. This is the number to
//        quote. If a blind case fails, log it and add a NEW blind case later instead of
//        tweaking the parser until this one passes.
const has = (m, re) => re.test(`${m.keywords.join(' ')} ${m.overview} ${m.title}`);
const SOUTH = ['te', 'ta', 'ml', 'kn'];
const INDIAN = ['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa'];
const all = (r, f) => r.length > 0 && r.every(f);
const atLeast = (r, n, f) => r.filter(f).length >= n;
const notes = (it) => (it.notes || []).join(' ').toLowerCase();
const anchorTitle = (it, e) => (it.anchors.length ? e.catalog[it.anchors[0]].title : '');

export const FIELD = [
  ['Field', 'something light to watch with my wife tonight', (r) => atLeast(r, 6, (m) => m.genres.includes('Comedy') || m.genres.includes('Romance')), '≥6 comedy/romance (date night), not literal “wife”'],
  ['Field', 'best Malayalam thriller of all time', (r) => all(r, (m) => m.lang === 'ml') && r.slice(0, 5).some((m) => m.title === 'Drishyam'), 'all Malayalam, Drishyam (2013) in top 5'],
  ['Field', 'a movie like 3 Idiots', (r) => atLeast(r, 6, (m) => m.lang === 'hi'), '≥6 Hindi'],
  ['Field', 'Rajinikanth action movies', (r) => atLeast(r, 5, (m) => m.cast.includes('Rajinikanth')), '≥5 Rajinikanth'],
  ['Field', 'Allu Arjun movies', (r) => atLeast(r, 8, (m) => m.lang === 'te'), 'thin credits → fill with Telugu, not global hits'],
  // Pushpa 2 is in the catalog since the TMDB sync: it should simply come first.
  ['Field', 'Pushpa 2', (r, it) => /^Pushpa 2/.test(r[0]?.title || '') || (/Pushpa/.test(r[0]?.title) && /not in|isn.t in|don.t have/.test(notes(it))), 'Pushpa 2 first (or Pushpa + “not in catalog”)'],
  ['Field', 'Kantara', (r) => r[0]?.title === 'Kantara' && atLeast(r, 6, (m) => INDIAN.includes(m.lang)), 'Kantara first, Indian follow-ups'],
  ['Field', 'latest Hindi movies', (r) => all(r, (m) => m.lang === 'hi') && r.reduce((a, m) => a + m.year, 0) / r.length >= 2020, 'Hindi, avg year ≥ 2020'],
  // Oct 2026: TV arrived with the TMDB sync, so the right answer changed from "say TV isn't covered" to "find the series".
  ['Field', 'web series like Panchayat', (r, it, e) => (it.anchors.length ? e.catalog[it.anchors[0]].title === 'Panchayat' && atLeast(r, 6, (m) => m.type === 'tv') : /tv|series|show/.test(notes(it))), 'anchors the real series + series results (or says TV isn’t covered)'],
  ['Field', 'IPL highlights', (r, it) => /live|sport|cricket/.test(notes(it)) && atLeast(r, 4, (m) => has(m, /cricket/i)), 'says live sports are out of scope; cricket films'],
  ['Field', 'a horror comedy like Stree', (r) => atLeast(r, 7, (m) => m.genres.includes('Horror') && m.genres.includes('Comedy')), '≥7 horror comedies'],
  ['Field', 'Oppenheimer', (r) => r[0]?.title === 'Oppenheimer', 'title first'],
  ['Field', 'I am sad, cheer me up', (r) => atLeast(r, 6, (m) => m.genres.includes('Comedy')), '≥6 comedies, not tearjerkers'],
  ['Field', 'films by Satyajit Ray', (r) => atLeast(r, 8, (m) => INDIAN.includes(m.lang)), 'thin credits → Indian fill, not Shawshank'],
  ['Field', 'south movies dubbed in hindi', (r, it) => atLeast(r, 8, (m) => SOUTH.includes(m.lang)) && /dub/.test(notes(it)), 'South Indian films + honest note on dubs'],
  ['Field', 'Oscar winning Indian films', (r, it) => atLeast(r, 8, (m) => INDIAN.includes(m.lang)) && /award|oscar/.test(notes(it)), 'Indian films + says no awards data'],
  ['Field', 'k-drama romance', (r) => all(r, (m) => m.lang === 'ko'), 'all Korean'],
  ['Field', 'something like Money Heist', (r, it, e) => atLeast(r, 6, (m) => has(m, /heist|robbery|steal|thie|crime|criminal/i)) && (/Money Heist/.test(anchorTitle(it, e)) || /tv|series|show/.test(notes(it))), 'heist/crime titles; anchors the series (or says TV isn’t covered)'],
  ['Field', 'movie for a rainy day', (r) => !r.some((m) => m.genres.includes('Horror')) && atLeast(r, 6, (m) => ['Comedy', 'Romance', 'Family', 'Animation'].some((g) => m.genres.includes(g))), 'cozy picks, not “Rain Man”'],
  // Since the TMDB sync his films are in the catalog: find them (or, without credits, admit it and fill Malayalam).
  ['Field', 'anything with Fahadh Faasil', (r, it) => atLeast(r, 5, (m) => m.cast.includes('Fahadh Faasil')) || (atLeast(r, 6, (m) => m.lang === 'ml') && /fahadh/.test(notes(it))), 'his films, or an honest note + Malayalam'],
];

// Blind v1: 14/20 before the Oct 2026 fix round, 18/20 after it. Its two misses were then fixed,
// so it's retired (kept as a regression guard). BLIND (v2) below is the current honest number.
export const BLIND_V1 = [
  ['Blind v1', 'Mohanlal movies', (r) => atLeast(r, 4, (m) => m.cast.includes('Mohanlal')) || atLeast(r, 8, (m) => m.lang === 'ml'), 'Mohanlal or Malayalam'],
  ['Blind v1', 'Mahesh Babu action', (r) => atLeast(r, 8, (m) => m.lang === 'te'), 'Telugu'],
  ['Blind v1', 'movies like Dangal', (r, it, e) => anchorTitle(it, e) === 'Dangal' && atLeast(r, 5, (m) => m.lang === 'hi'), 'anchor + ≥5 Hindi'],
  ['Blind v1', 'something to watch with my girlfriend', (r) => atLeast(r, 6, (m) => m.genres.includes('Romance') || m.genres.includes('Comedy')), 'date night'],
  ['Blind v1', 'cheer me up after a bad day', (r) => atLeast(r, 6, (m) => m.genres.includes('Comedy')), '≥6 comedies'],
  ['Blind v1', 'Baahubali', (r) => /hubali/.test(r[0]?.title || ''), 'title first'],
  ['Blind v1', 'RRR', (r) => r[0]?.title === 'RRR', 'title first'],
  ['Blind v1', 'Mirzapur', (r, it, e) => /tv|series|show/.test(notes(it)) || /^Mirzapur/.test(r[0]?.title || '') || /^Mirzapur/.test(anchorTitle(it, e)), 'says TV isn’t covered, or finds the series'],
  ['Blind v1', 'live cricket', (r, it) => /live|sport/.test(notes(it)), 'says live sports are out of scope'],
  ['Blind v1', 'a cozy movie for a rainy evening', (r) => !r.some((m) => m.genres.includes('Horror')) && atLeast(r, 6, (m) => ['Comedy', 'Romance', 'Family', 'Animation'].some((g) => m.genres.includes(g))), 'cozy'],
  ['Blind v1', 'Tamil movies like Vikram', (r, it, e) => anchorTitle(it, e) === 'Vikram' && atLeast(r, 8, (m) => m.lang === 'ta'), 'anchor Vikram (2022) + Tamil'],
  ['Blind v1', 'old Bollywood classics', (r) => atLeast(r, 8, (m) => m.lang === 'hi') && all(r, (m) => m.year <= 1995), 'Hindi, ≤ 1995'],
  ['Blind v1', 'a short funny movie', (r) => all(r, (m) => m.runtime <= 100 && m.genres.includes('Comedy')), 'comedies ≤ 100m'],
  ['Blind v1', 'something scary but not gory', (r) => atLeast(r, 8, (m) => m.genres.includes('Horror')), '≥8 horror'],
  ['Blind v1', 'anime movie like Your Name', (r, it, e) => anchorTitle(it, e) === 'Your Name.' && atLeast(r, 6, (m) => m.lang === 'ja'), 'anchor + Japanese'],
  ['Blind v1', 'Pushpa', (r) => /^Pushpa/.test(r[0]?.title || ''), 'a Pushpa film first (Part 2 exists since the sync)'],
  ['Blind v1', 'father daughter emotional movie', (r) => atLeast(r, 7, (m) => m.genres.includes('Drama')), '≥7 dramas'],
  ['Blind v1', 'Prabhas', (r) => atLeast(r.slice(0, 5), 2, (m) => m.cast.includes('Prabhas')) || atLeast(r, 8, (m) => m.lang === 'te'), 'Prabhas or Telugu'],
  ['Blind v1', 'Kannada movies like KGF', (r, it, e) => /K\.G\.F/.test(anchorTitle(it, e)) && atLeast(r, 8, (m) => m.lang === 'kn'), 'anchor KGF + Kannada'],
  ['Blind v1', 'what should I watch tonight', (r, it, e, o) => !o.lowConfidence && r.length >= 10, 'confident, useful default'],
];

// Blind v2: written after the Oct 2026 fix round, before running it even once. Deliberately
// includes things the fixes don't cover (a star missing from STAR_LANG, a show missing from
// KNOWN_SHOWS, franchise negation) so the score reflects real generalization.
export const BLIND = [
  ['Blind', 'a thriller like Andhadhun', (r, it, e) => anchorTitle(it, e) === 'Andhadhun' && atLeast(r, 5, (m) => m.lang === 'hi') && atLeast(r, 6, (m) => m.genres.includes('Thriller')), 'anchor + Hindi thrillers'],
  ['Blind', 'Telugu romantic comedy', (r) => atLeast(r, 6, (m) => m.lang === 'te') && atLeast(r, 6, (m) => m.genres.includes('Romance')), 'Telugu rom-coms'],
  ['Blind', 'something like Interstellar but Indian', (r, it, e) => anchorTitle(it, e) === 'Interstellar' && atLeast(r, 8, (m) => INDIAN.includes(m.lang)), 'anchor + Indian'],
  ['Blind', 'movies about friendship in college', (r) => atLeast(r, 6, (m) => has(m, /friend|college|student|campus|university/i)), 'friendship / college'],
  ['Blind', 'a 90 minute animated movie', (r) => all(r, (m) => m.genres.includes('Animation') && m.runtime <= 110), 'animation ≈ 90m'],
  ['Blind', 'Hindi movies from the 2000s that are funny', (r) => all(r, (m) => m.lang === 'hi' && m.year >= 2000 && m.year <= 2009) && atLeast(r, 6, (m) => m.genres.includes('Comedy')), 'Hindi 2000s comedies'],
  ['Blind', 'Ajay Devgn action movies', (r) => atLeast(r, 5, (m) => m.cast.includes('Ajay Devgn')), '≥5 Ajay Devgn'],
  ['Blind', 'Kunchacko Boban movies', (r, it, e, o) => atLeast(r, 6, (m) => m.lang === 'ml') || /kunchacko/.test(notes(it)), 'unknown star: Malayalam or honest note'],
  ['Blind', 'films like Lagaan', (r, it, e) => anchorTitle(it, e) === 'Lagaan: Once Upon a Time in India' && atLeast(r, 5, (m) => m.lang === 'hi'), 'anchor + Hindi'],
  ['Blind', 'scary movie for teenagers', (r) => atLeast(r, 7, (m) => m.genres.includes('Horror')), '≥7 horror'],
  ['Blind', "Christopher Nolan's best", (r) => atLeast(r, 5, (m) => m.directors.includes('Christopher Nolan')), '≥5 Nolan'],
  ['Blind', 'a Marathi film', (r) => atLeast(r.slice(0, 5), 5, (m) => m.lang === 'mr'), 'Marathi first'],
  ['Blind', 'underrated Telugu thrillers', (r) => all(r, (m) => m.lang === 'te') && atLeast(r, 8, (m) => m.genres.includes('Thriller')), 'Telugu thrillers'],
  ['Blind', 'movie night with kids', (r) => !r.some((m) => m.genres.includes('Horror')) && atLeast(r, 7, (m) => m.genres.includes('Family') || m.genres.includes('Animation')), 'kid-friendly'],
  ['Blind', 'a mind-bending Malayalam movie', (r) => all(r, (m) => m.lang === 'ml'), 'Malayalam'],
  ['Blind', 'superhero films but not Marvel', (r) => atLeast(r, 6, (m) => has(m, /superhero|super hero|superpower|super power/i)) && !r.some((m) => /marvel/i.test(m.keywords.join(' '))), 'superheroes, no Marvel'],
  ['Blind', 'Dhoom', (r) => /^Dhoom/.test(r[0]?.title || ''), 'title first'],
  ['Blind', 'sports movies based on true stories', (r) => atLeast(r, 6, (m) => has(m, /sport|cricket|football|boxing|boxer|wrestl|athlete|race|hockey|olympic|coach/i)), '≥6 sports'],
  ['Blind', 'I want to cry', (r) => atLeast(r, 7, (m) => m.genres.includes('Drama')), '≥7 dramas'],
  ['Blind', 'something like The Crown', (r, it) => /tv|series|show/.test(notes(it)) || atLeast(r, 6, (m) => has(m, /queen|royal|king|monarch/i)), 'TV note or royal dramas'],
];
