// Search-quality regression suite. Each case is a real query plus an automatic check on the
// top-10 results, so changes to the parser or ranker can be measured instead of eyeballed.
import { Engine } from './engine.js';
import { parse, isFollowUp, mergeIntent } from './nlu.js';
import { FIELD, BLIND, BLIND_V1 } from './eval-sets.js';

const has = (m, re) => re.test(`${m.keywords.join(' ')} ${m.overview} ${m.title}`);
const SOUTH = ['te', 'ta', 'ml', 'kn'];
const INDIAN = ['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa'];
const all = (r, f) => r.length > 0 && r.every(f);
const atLeast = (r, n, f) => r.filter(f).length >= n;

export const CASES = [
  // [category, query, check(results, intent, engine), what the check means]
  ['Constraints', 'a feel good comedy under two hours', (r) => all(r, (m) => m.runtime <= 120 && m.genres.includes('Comedy') && !m.genres.includes('Horror')), 'all comedies ≤ 2h, no horror'],
  ['Constraints', 'comedy under 90 minutes', (r) => all(r, (m) => m.runtime <= 90 && m.genres.includes('Comedy')), 'all comedies ≤ 90m'],
  ['Constraints', 'horror movies from the 80s', (r) => all(r, (m) => m.genres.includes('Horror') && m.year >= 1980 && m.year <= 1989), 'all 1980s horror'],
  ['Constraints', 'highly rated 90s movies', (r) => all(r, (m) => m.year >= 1990 && m.year <= 1999) && r.reduce((a, m) => a + m.rating, 0) / r.length >= 7.8, '1990s, avg rating ≥ 7.8'],
  ['Constraints', 'an hour and a half sci-fi with no romance', (r) => all(r, (m) => m.genres.includes('Science Fiction') && !m.genres.includes('Romance') && m.runtime <= 100), 'sci-fi ~90m, no romance'],
  ['Constraints', 'animated movie for kids', (r) => all(r, (m) => m.genres.includes('Animation') && !m.genres.includes('Horror')), 'animation, no horror'],
  ['Reference titles', 'something like Inception but less confusing', (r, it, e) => it.anchors.length && e.catalog[it.anchors[0]].title === 'Inception' && !r.some((m) => m.title === 'Inception') && atLeast(r, 8, (m) => m.genres.some((g) => ['Science Fiction', 'Action', 'Adventure', 'Thriller'].includes(g))), 'resolves Inception, ≥8 same-family genres'],
  ['Reference titles', 'films like Parasite', (r, it, e) => it.anchors.length && e.catalog[it.anchors[0]].title === 'Parasite', 'resolves Parasite'],
  ['Reference titles', 'movies like intersteller', (r, it, e) => it.anchors.length && e.catalog[it.anchors[0]].title === 'Interstellar', 'typo still resolves Interstellar'],
  ['Reference titles', 'funnier than Interstellar', (r, it, e) => it.anchors.length && e.catalog[it.anchors[0]].title === 'Interstellar' && it.steer.humor > 0, 'anchor + humor steer'],
  ['Reference titles', 'movies like RRR', (r) => !r.some((m) => m.title === 'RRR') && atLeast(r, 6, (m) => INDIAN.includes(m.lang)), 'excludes RRR, ≥6 Indian'],
  ['Indian cinema', 'Telugu thriller like Drishyam', (r) => all(r, (m) => m.lang === 'te' && m.genres.includes('Thriller')), 'all Telugu thrillers'],
  ['Indian cinema', 'mass masala action in Tamil', (r) => all(r, (m) => m.lang === 'ta' && m.genres.includes('Action')), 'all Tamil action'],
  ['Indian cinema', 'underrated Malayalam movies', (r) => all(r, (m) => m.lang === 'ml'), 'all Malayalam'],
  ['Indian cinema', 'south indian horror comedy', (r) => all(r, (m) => SOUTH.includes(m.lang) && m.genres.includes('Horror')), 'all South Indian horror'],
  ['Indian cinema', 'Bollywood romantic comedy', (r) => all(r, (m) => m.lang === 'hi' && m.genres.includes('Romance') && m.genres.includes('Comedy')), 'all Hindi rom-coms'],
  ['Indian cinema', 'Kollywood movies like Vikram Vedha', (r) => all(r, (m) => m.lang === 'ta'), 'all Tamil'],
  ['Indian cinema', 'cricket movie', (r) => atLeast(r, 5, (m) => has(m, /cricket/i)), '≥5 actually about cricket'],
  ['Indian cinema', 'a patriotic film based on a true story', (r) => atLeast(r, 6, (m) => INDIAN.includes(m.lang)), '≥6 Indian'],
  ['People', 'Shah Rukh Khan romance from the 90s', (r) => r.length >= 5 && all(r, (m) => m.cast.includes('Shah Rukh Khan') && m.year <= 1999 && m.genres.includes('Romance')), 'all SRK 90s romance'],
  ['People', 'Tom Hanks movies before 2000', (r) => all(r, (m) => m.cast.includes('Tom Hanks') && m.year < 2000), 'all Tom Hanks pre-2000'],
  ['People', 'Christopher Nolan movies', (r) => atLeast(r, 6, (m) => m.directors.includes('Christopher Nolan')), '≥6 Nolan-directed'],
  ['People', 'Shahrukh Khan romantic movies', (r) => r.length >= 5 && all(r, (m) => m.cast.includes('Shah Rukh Khan')), 'spelling variant resolves SRK'],
  ['People', 'srk movies', (r) => all(r, (m) => m.cast.includes('Shah Rukh Khan')), 'nickname resolves SRK'],
  ['People', 'thalaivar movies', (r) => atLeast(r, 5, (m) => m.cast.includes('Rajinikanth')), 'nickname resolves Rajinikanth'],
  ['People', 'Prabhas action movies', (r) => atLeast(r, 2, (m) => m.cast.includes('Prabhas')), 'one-word star name'],
  ['Spoken (Whisper)', ' مجھے ایک درابنی فیلم دکھاو', (r) => atLeast(r, 8, (m) => m.genres.includes('Horror')) && atLeast(r, 5, (m) => m.lang === 'hi'), 'Hindi speech, Urdu-script transcript → Hindi horror'],
  ['Spoken (Whisper)', ' شاحرخ خان کی کوئی رومانتک فیلم دکھاو', (r) => all(r, (m) => m.cast.includes('Shah Rukh Khan')), 'Hindi speech → SRK romance'],
  ['Spoken (Whisper)', ' எனக்கு ஒரு நகைச்சுவை படம் வேண்டும்.', (r) => atLeast(r, 8, (m) => m.genres.includes('Comedy')) && atLeast(r, 5, (m) => m.lang === 'ta'), 'Tamil speech → Tamil comedy'],
  ['Topics', 'a heist movie', (r) => atLeast(r, 8, (m) => has(m, /heist|robbery|thie|steal|bank job|con /i)), '≥8 heists'],
  ['Topics', 'movies about time travel', (r) => atLeast(r, 8, (m) => has(m, /time travel|time machine|time loop|past|future/i)), '≥8 time travel'],
  ['Topics', 'zombie apocalypse', (r) => atLeast(r, 8, (m) => has(m, /zombie|undead|infect/i)), '≥8 zombie'],
  ['Topics', 'world war 2 movies', (r) => atLeast(r, 8, (m) => m.genres.includes('War') || has(m, /world war|nazi|wwii/i)), '≥8 WW2'],
  ['Topics', 'superhero movies', (r) => atLeast(r, 8, (m) => has(m, /superhero|super hero|marvel|dc comics|superpower|super power/i)), '≥8 superhero'],
  ['Topics', 'true story about space exploration', (r) => r.slice(0, 5).some((m) => m.title === 'Apollo 13'), 'Apollo 13 in top 5'],
  ['Topics', 'a sad movie that will make me cry', (r) => atLeast(r, 8, (m) => m.genres.includes('Drama')), '≥8 dramas'],
  ['Languages', 'korean thriller', (r) => all(r, (m) => m.lang === 'ko' && m.genres.includes('Thriller')), 'all Korean thrillers'],
  ['Languages', 'drishym but in telugu', (r) => all(r, (m) => m.lang === 'te'), 'all Telugu'],
  ['Hinglish / Hindi', 'koi achhi comedy movie batao', (r) => atLeast(r, 8, (m) => m.genres.includes('Comedy')), '≥8 comedies'],
  ['Hinglish / Hindi', 'bachon ke liye animated movie', (r) => atLeast(r, 8, (m) => m.genres.includes('Animation')), '≥8 animated'],
  ['Hinglish / Hindi', 'koi darawni film dikhao', (r) => atLeast(r, 8, (m) => m.genres.includes('Horror')), '≥8 horror'],
  ['Hinglish / Hindi', 'डरावनी फिल्म', (r) => atLeast(r, 8, (m) => m.genres.includes('Horror')), '≥8 horror'],
  ['Hinglish / Hindi', 'हिंदी कॉमेडी फिल्में', (r) => all(r, (m) => m.lang === 'hi' && m.genres.includes('Comedy')), 'all Hindi comedies'],
  ['Hinglish / Hindi', 'thai horror', (r) => r[0]?.lang === 'th' && r[1]?.lang === 'th', '“thai” survives Hinglish cleanup; exact Thai matches first'],
  ['Indian scripts', 'పోకిరి లాంటి సినిమా', (r, it, e) => it.anchors.length && e.catalog[it.anchors[0]].title === 'Pokiri' && atLeast(r, 6, (m) => m.lang === 'te'), 'Telugu: “movie like Pokiri” → anchor + Telugu lean'],
  ['Indian scripts', 'తెలుగు హారర్ సినిమా', (r) => all(r, (m) => m.lang === 'te' && m.genres.includes('Horror')), 'Telugu: “Telugu horror movie”'],
  ['Indian scripts', 'தமிழ் காமெடி படம்', (r) => all(r, (m) => m.lang === 'ta' && m.genres.includes('Comedy')), 'Tamil: “Tamil comedy film”'],
  ['Indian scripts', 'മലയാളം ത്രില്ലർ സിനിമ', (r) => all(r, (m) => m.lang === 'ml' && m.genres.includes('Thriller')), 'Malayalam: “Malayalam thriller movie”'],
  ['Indian scripts', 'ಕನ್ನಡ ಸಿನಿಮಾ', (r) => all(r, (m) => m.lang === 'kn'), 'Kannada: “Kannada movie”'],
  ['Indian scripts', 'ভূতের সিনেমা', (r) => atLeast(r, 8, (m) => m.lang === 'bn') && atLeast(r.slice(0, 3), 2, (m) => m.genres.includes('Horror') || has(m, /ghost|bhoot|bhooter|haunt/i)), 'Bengali: “ghost movie” → Bengali ghost films first (script = language filter since Oct 2026)'],
  ['Indian scripts', 'Pokiri jaisi movie', (r, it, e) => it.anchors.length && e.catalog[it.anchors[0]].title === 'Pokiri', 'Hinglish postposition “like”'],
  ['Indian scripts', 'drishyam lanti cinema', (r, it, e) => it.anchors.length && /Drishyam|Drushyam/.test(e.catalog[it.anchors[0]].title), 'Telugu-romanized “like”'],
  ['Indian scripts', 'பாகுபலி மாதிரி படம்', (r, it, e) => it.anchors.length && /hubali/.test(e.catalog[it.anchors[0]].title), 'Tamil-script Baahubali → cross-script match'],
  ['Indian scripts', 'मुझे एक डरावनी फिल्म दिखाओ जो बहुत लंबी न हो', (r, it) => !it.anchors.length && atLeast(r, 8, (m) => m.genres.includes('Horror')) && all(r, (m) => m.runtime <= 130), 'Hindi sentence: horror, not too long, no false “Darr” anchor'],
  ['Indian scripts', 'నాకు నవ్వించే ఫ్యామిలీ సినిమా కావాలి', (r, it) => !it.semantic.match(/[^\x00-\u024f]/) && atLeast(r, 6, (m) => m.genres.includes('Comedy')), 'Telugu sentence: family comedy, no junk in embedding'],
  ['Robustness', 'asdkjh qwe zzz', (r, it, e, o) => o.lowConfidence, 'flags low confidence'],
  ['Robustness', '<img src=x onerror=alert(1)>', (r) => r.length > 0, 'no crash'],
  ['Robustness', 'movie '.repeat(200), (r) => r.length > 0, 'very long query, no crash'],
];

const CONVERSATION = [
  ['tamil action movies', (it, r) => all(r, (m) => m.lang === 'ta')],
  ['shorter', (it, r, prev) => all(r, (m) => m.lang === 'ta') && Math.max(...r.map((m) => m.runtime)) < Math.max(...prev.map((m) => m.runtime))],
  ['from after 2015', (it, r) => all(r, (m) => m.lang === 'ta' && m.year > 2015)],
  ['no romance', (it, r) => all(r, (m) => !m.genres.includes('Romance'))],
  ['more like the second one', (it) => it.anchors.length === 1],
  ['start over: a korean romance', (it, r) => all(r, (m) => m.lang === 'ko')],
];

export async function runEval(onProgress = () => {}) {
  const e = new Engine();
  await e.load((p) => onProgress(p));
  const ctx = { prefs: ['hi', 'te', 'ta', 'ml', 'en'] };
  const rows = [];
  const lat = [];
  const SETS = [['Dev', CASES], ['Field', FIELD], ['Blind v1', BLIND_V1], ['Blind', BLIND]];
  for (const [set, cases] of SETS) for (const [cat, q, check, desc] of cases) {
    const it = parse(q, e.index);
    const t0 = performance.now();
    const o = await e.search(it, 10, ctx);
    lat.push(performance.now() - t0);
    const r = o.results.map((x) => e.catalog[x.i]);
    let pass = false;
    try { pass = !!check(r, it, e, o); } catch { pass = false; }
    rows.push({ set, cat, q, desc, pass, notes: it.notes || [], top: r.slice(0, 5).map((m) => `${m.title} (${m.lang}, ${m.year})`), relaxed: o.relaxed });
  }
  let prev = null, last = [], lastR = [];
  const conv = [];
  for (const [q, check] of CONVERSATION) {
    let it = parse(q, e.index);
    if (isFollowUp(it, prev)) it = mergeIntent(prev, it, last, e.catalog);
    const o = await e.search(it, 10, ctx);
    const r = o.results.map((x) => e.catalog[x.i]);
    conv.push({ q, pass: !!check(it, r, lastR), top: r.slice(0, 3).map((m) => `${m.title} (${m.year}, ${m.runtime}m)`) });
    prev = it; last = o.results.map((x) => x.i); lastR = r;
  }
  lat.sort((a, b) => a - b);
  return { rows, conv, p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], titles: e.catalog.length };
}
