// Query understanding: turns free text into structured intent.
//
// A query like "something like Inception but less confusing, under two hours"
// is not one thing to embed. It mixes:
//   - hard constraints   (runtime, year, language, people)  -> filters
//   - reference titles   ("like Inception")                 -> anchor vectors
//   - relative modifiers ("less confusing")                 -> steering along attribute axes
//   - moods / genres     ("feel good", "comedy")             -> query expansion + genre priors
//   - leftover description ("heist in space")               -> semantic text
// Embedding the raw string blurs all of these together (and matches "Feel the Beat"
// for "feel good"), so we pull each piece out and hand the ranker a clean intent.

const WORD_NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

export const INDIAN_LANGS = ['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu'];

export const GENRES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family',
  'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller',
  'War', 'Western',
];

// Explicit genre words. Longest phrases first so "romantic comedy" wins over "comedy".
const GENRE_LEXICON = [
  [['romantic comedy', 'romantic comedies', 'rom-com', 'rom com', 'romcom'], ['Romance', 'Comedy']],
  [['science fiction', 'sci-fi', 'sci fi', 'scifi'], ['Science Fiction']],
  [['comedy', 'comedies', 'funny', 'hilarious', 'laugh'], ['Comedy']],
  [['romance', 'romantic', 'love story', 'love stories'], ['Romance']],
  [['horror', 'scary', 'terrifying', 'frightening', 'spooky'], ['Horror']],
  [['thriller', 'thrillers', 'suspense', 'suspenseful'], ['Thriller']],
  [['action', 'action-packed'], ['Action']],
  [['adventure', 'adventures'], ['Adventure']],
  [['animated', 'animation', 'cartoon', 'cartoons', 'pixar', 'anime'], ['Animation']],
  [['documentary', 'documentaries', 'docuseries'], ['Documentary']],
  [['crime', 'gangster', 'mafia', 'heist'], ['Crime']],
  [['mystery', 'mysteries', 'whodunit', 'whodunnit', 'detective'], ['Mystery']],
  [['fantasy', 'magic', 'magical', 'dragons'], ['Fantasy']],
  [['war'], ['War']],
  [['western', 'westerns', 'cowboy', 'cowboys'], ['Western']],
  [['musical', 'musicals'], ['Music']],
  [['historical', 'period piece', 'period drama'], ['History']],
  [['drama', 'dramas', 'dramatic'], ['Drama']],
  [['family', 'for kids', 'kid friendly', 'kid-friendly', 'for the kids', 'children', 'kids'], ['Family']],
];

// Moods are softer than genres: they expand the semantic text with descriptive
// language, nudge genre priors, and set steering directions. They never hard-filter.
const MOODS = [
  { words: ['feel good', 'feel-good', 'feelgood', 'uplifting', 'heartwarming', 'heart-warming', 'wholesome', 'cozy', 'cosy', 'comfort', 'cheer me up', 'happy'],
    label: 'feel-good', expand: 'uplifting, heartwarming, charming and funny story that leaves you smiling',
    genres: ['Comedy', 'Family', 'Romance'], avoid: ['Horror'], steer: { darkness: -1 } },
  { words: ['with my parents', 'with my family', 'with the family', 'with my grandparents', 'with my mom', 'with my dad', 'with my kids', 'family movie night', 'family friendly', 'family-friendly'],
    label: 'family-friendly', expand: 'wholesome, warm, family-friendly film everyone can enjoy',
    genres: ['Family', 'Comedy', 'Adventure'], avoid: ['Horror'], steer: { darkness: -1 } },
  { words: ['masala', 'mass entertainer', 'mass movie', 'mass', 'paisa vasool', 'whistle-worthy', 'larger than life', 'larger-than-life'],
    label: 'masala', expand: 'larger-than-life mass entertainer with a heroic lead, high-octane action, drama, romance and songs',
    genres: ['Action', 'Drama'], steer: { pace: 1, complexity: -1 }, langBoost: INDIAN_LANGS },
  { words: ['family entertainer', 'family drama', 'joint family', 'sanskari'], label: 'family entertainer',
    expand: 'warm family drama about relationships, values and togetherness, with humor and emotion', genres: ['Family', 'Drama', 'Comedy'],
    avoid: ['Horror'], steer: { darkness: -1 }, langBoost: INDIAN_LANGS },
  { words: ['patriotic', 'deshbhakti', 'army', 'freedom fighter', 'freedom struggle'], label: 'patriotic',
    expand: 'patriotic story about soldiers, the nation, sacrifice and India\'s freedom struggle', genres: ['War', 'History', 'Drama'], langBoost: INDIAN_LANGS },
  { words: ['cricket'], label: 'cricket', expand: 'cricket match, batsman and bowler, a cricket team and the World Cup', lex: ['cricket'] },
  { words: ['pan-india', 'pan india'], label: 'pan-India', expand: 'big-budget pan-India blockbuster', langBoost: INDIAN_LANGS },
  { words: ['dark', 'gritty', 'bleak', 'grim'], label: 'dark', expand: 'dark, gritty, morally complex story',
    steer: { darkness: 1 } },
  { words: ['sad', 'tearjerker', 'tear-jerker', 'make me cry', 'emotional', 'heartbreaking'], label: 'emotional',
    expand: 'emotional, moving, heartbreaking drama', genres: ['Drama'] },
  { words: ['mind-bending', 'mind bending', 'mindbending', 'trippy', 'twisty', 'plot twist', 'twist ending', 'mindfuck', 'cerebral'],
    label: 'mind-bending', expand: 'mind-bending, puzzling story with twists and a layered plot', steer: { complexity: 1 } },
  { words: ['light', 'lighthearted', 'light-hearted', 'easy watch', 'easy to watch', 'turn my brain off', 'brain off', 'mindless', 'popcorn', 'chill', 'relaxing'],
    label: 'easy watch', expand: 'light, fun, easygoing entertaining movie', steer: { complexity: -1, darkness: -1 } },
  { words: ['inspiring', 'inspirational', 'motivational', 'motivating'], label: 'inspiring',
    expand: 'inspiring story of perseverance, an underdog who triumphs', steer: { darkness: -1 } },
  { words: ['date night', 'date-night'], label: 'date night', expand: 'charming, light romantic comedy, fun and sweet', genres: ['Romance', 'Comedy'], avoid: ['Horror'], steer: { darkness: -1 } },
  { words: ['epic'], label: 'epic', expand: 'epic, grand-scale saga', genres: ['Adventure'] },
  { words: ['slow burn', 'slow-burn', 'atmospheric'], label: 'slow burn', expand: 'slow-burn, tense, atmospheric', steer: { pace: -1 } },
  { words: ['fast paced', 'fast-paced', 'adrenaline', 'non-stop', 'nonstop'], label: 'fast-paced',
    expand: 'fast-paced, thrilling, action-packed', steer: { pace: 1 } },
  { words: ['based on a true story', 'inspired by a true story', 'based on true events', 'based on real events', 'true story', 'true stories', 'real events', 'real life', 'biopic'], label: 'true story',
    expand: 'based on a true story, real events, biography' },
];

// Attribute axes for relative modifiers ("less confusing", "funnier", "darker").
// Each pole is embedded once at load; the ranker projects every title onto (pos - neg).
export const AXES = {
  complexity: {
    pos: 'A complex, mind-bending, confusing film with a nonlinear, layered plot that demands close attention.',
    neg: 'A simple, straightforward, easy-to-follow film with a clear and linear story.',
    words: { confusing: 1, complex: 1, complicated: 1, cerebral: 1, 'mind-bending': 1, trippy: 1, twisty: 1, convoluted: 1, smart: 1,
      simple: -1, simpler: -1, straightforward: -1, easy: -1, easier: -1, 'easier to follow': -1 },
    labels: ['simpler', 'more complex'],
  },
  darkness: {
    pos: 'A dark, grim, violent, disturbing and bleak film.',
    neg: 'A light, cheerful, warm, uplifting and wholesome film.',
    words: { dark: 1, darker: 1, grim: 1, violent: 1, gory: 1, bleak: 1, depressing: 1, disturbing: 1, heavy: 1, gritty: 1, grittier: 1,
      light: -1, lighter: -1, happy: -1, happier: -1, cheerful: -1, wholesome: -1, uplifting: -1, upbeat: -1 },
    labels: ['lighter', 'darker'],
  },
  humor: {
    pos: 'A funny, hilarious comedy full of jokes and laughs.',
    neg: 'A serious, earnest, solemn drama with no jokes.',
    words: { funny: 1, funnier: 1, comedic: 1, silly: 1, sillier: 1, goofy: 1, goofier: 1, humorous: 1, serious: -1 },
    labels: ['more serious', 'funnier'],
  },
  intensity: {
    pos: 'A terrifying, scary, nerve-wracking and intense film.',
    neg: 'A gentle, calm, low-stakes and relaxing film.',
    words: { scary: 1, scarier: 1, creepy: 1, creepier: 1, intense: 1, frightening: 1, tense: 1, tenser: 1,
      calm: -1, calmer: -1, gentle: -1, gentler: -1, relaxing: -1, chill: -1, chiller: -1 },
    labels: ['gentler', 'more intense'],
  },
  pace: {
    pos: 'A fast-paced, action-packed thriller with explosions, chases and fights.',
    neg: 'A slow, quiet, contemplative, character-driven film.',
    words: { action: 1, exciting: 1, fast: 1, faster: 1, 'fast-paced': 1, 'action-packed': 1,
      slow: -1, slower: -1, quiet: -1, quieter: -1, contemplative: -1 },
    labels: ['slower', 'faster-paced'],
  },
};

const SOUTH = ['te', 'ta', 'ml', 'kn'];

// Longest phrases first ("south indian" before "indian"). Values are language-code lists.
const LANGS = [
  [['south indian', 'south-indian', 'south cinema', 'south movies?'], SOUTH],
  [['indian', 'desi', 'regional'], INDIAN_LANGS],
  [['tollywood', 'telugu'], ['te']], [['kollywood', 'tamil'], ['ta']], [['mollywood', 'malayalam'], ['ml']],
  [['sandalwood', 'kannada'], ['kn']], [['bollywood', 'hindi'], ['hi']], [['bengali', 'bangla', 'tollygunge'], ['bn']],
  [['marathi'], ['mr']], [['punjabi', 'pollywood'], ['pa']], [['gujarati', 'dhollywood'], ['gu']],
  [['korean', 'k-drama'], ['ko']], [['french'], ['fr']], [['italian'], ['it']], [['japanese'], ['ja']],
  [['spanish'], ['es']], [['german'], ['de']], [['chinese', 'mandarin'], ['zh', 'cn']], [['cantonese'], ['cn']],
  [['russian'], ['ru']], [['swedish'], ['sv']], [['danish'], ['da']], [['norwegian'], ['no']],
  [['portuguese', 'brazilian'], ['pt']], [['turkish'], ['tr']], [['thai'], ['th']], [['persian', 'iranian'], ['fa']],
  [['polish'], ['pl']], [['english', 'hollywood'], ['en']],
];

const FILLER = /\b(find|show|give|get|recommend|suggest|search|looking|look|want|wanna|need|like to|i'd|i|me|my|we|us|can you|could you|please|some|something|anything|a|an|the|movie|movies|film|films|flick|flicks|to watch|watch|tonight|today|for|that'?s|that is|which is|is|are|one|ones|good|great|nice|kind of|sort of|maybe|just|really|pretty|with|and|or|but|of|to|in|on|about|it|any|what|whats|what's|should)\b/g;

const DURATION = String.raw`(?:(\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|twenty|thirty|forty|fifty|sixty|ninety)\s*(?:and\s+a\s+half\s+)?(hours?|hrs?|h|minutes?|mins?|m)\b(?:\s+and\s+a\s+half)?|(?:an?\s+)?hour\s+and\s+a\s+half|(\d+)\s*h\s*(\d+)\s*m?)`;

function parseDuration(text) {
  const t = text.toLowerCase().trim();
  if (/hour\s+and\s+a\s+half/.test(t) && !/\d|two|three/.test(t)) return 90;
  let m = t.match(/(\d+)\s*h\s*(\d+)/);
  if (m) return +m[1] * 60 + +m[2];
  m = t.match(/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|twenty|thirty|forty|fifty|sixty|ninety)\s*(?:and\s+a\s+half\s+)?(hours?|hrs?|h|minutes?|mins?|m)\b/);
  if (!m) return null;
  let n = WORD_NUM[m[1]] ?? parseFloat(m[1]);
  if (/and a half/.test(t)) n += 0.5;
  return /^h/.test(m[2]) ? Math.round(n * 60) : Math.round(n);
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const normTitle = (s) => norm(s).replace(/^(the|a|an) /, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => new RegExp(`(?<![a-z-])${escapeRe(w)}(?![a-z])`, 'i');

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}

// Indexes over the catalog that the parser needs (titles + people).
// Everyday phrasing that names a need rather than a topic. Rewritten before parsing so
// "I'm sad, cheer me up" means feel-good comedy (not tearjerkers) and "with my wife" means
// date night (not films about wives). Each entry: [pattern, replacement].
const IDIOMS = [
  [/\b(?:cheer me up|lift my (?:mood|spirits)|pick me up|make me (?:laugh|smile|happy)|need a (?:laugh|smile|pick-me-up)|mood booster|after a (?:bad|long|rough|tough|hard) day|bad day)\b/g, ' feel-good comedy '],
  [/\b(?:with|for) (?:my )?(?:wife|husband|girlfriend|boyfriend|partner|bae|fianc[eé]e?|spouse|date|crush|other half)\b|\bromantic evening\b/g, ' date night '],
  [/\b(?:with|for) (?:my )?(?:friends|buddies|the gang|mates|roommates|flatmates)\b/g, ' funny popular '],
  [/\b(?:a )?(?:rainy|stormy|monsoon) (?:day|evening|night|afternoon|weekend)\b|\blazy (?:sunday|afternoon|day|weekend)\b|\bsunday afternoon\b|\bwinter (?:night|evening)\b|\bcomfort (?:movie|film|watch)\b/g, ' cozy '],
  [/\b(?:of all time|of all times|all[- ]time|ever made|the best ever|greatest)\b/g, ' best '],
];

// Popular series people ask for by name. TV isn't in the bundled catalog yet, so instead of
// fuzzy-matching "Panchayat" to some film, say so and search films with the same feel.
const KNOWN_SHOWS = [
  ['panchayat', 'Panchayat', 'hi', 'gentle small-town village comedy-drama about a young man working in a rural government office'],
  ['mirzapur', 'Mirzapur', 'hi', 'gritty small-town crime saga, gangsters, power struggle and violence'],
  ['sacred games', 'Sacred Games', 'hi', 'dark Mumbai crime thriller, gangster and a police officer, conspiracy'],
  ['the family man', 'The Family Man', 'hi', 'spy action thriller with humor, a middle-class family man who is a secret intelligence agent'],
  ['scam 1992', 'Scam 1992', 'hi', 'true story financial thriller, stock market scam, rise and fall of a broker'],
  ['kota factory', 'Kota Factory', 'hi', 'coming-of-age drama about students preparing for entrance exams at a coaching institute'],
  ['paatal lok', 'Paatal Lok', 'hi', 'dark investigative crime thriller, a cop and a high-profile case, social commentary'],
  ['delhi crime', 'Delhi Crime', 'hi', 'police procedural based on a true crime investigation in Delhi'],
  ['aspirants', 'Aspirants', 'hi', 'friendship drama about civil services exam aspirants'],
  ['gullak', 'Gullak', 'hi', 'warm middle-class family comedy-drama in a small town'],
  ['special ops', 'Special Ops', 'hi', 'espionage thriller hunting a terrorist mastermind'],
  ['aarya', 'Aarya', 'hi', 'crime drama, a mother takes over a drug empire to protect her family'],
  ['rocket boys', 'Rocket Boys', 'hi', 'biographical drama about India’s space and nuclear scientists'],
  ['money heist', 'Money Heist', 'es', 'heist thriller, a mastermind professor and a crew robbing a mint'],
  ['squid game', 'Squid Game', 'ko', 'deadly survival game thriller, debt and desperation'],
  ['breaking bad', 'Breaking Bad', 'en', 'crime drama, a chemistry teacher turns drug kingpin'],
  ['stranger things', 'Stranger Things', 'en', '1980s supernatural mystery adventure with kids'],
  ['game of thrones', 'Game of Thrones', 'en', 'epic medieval fantasy war for a throne, dragons and politics'],
  ['friends', 'Friends', 'en', 'feel-good ensemble comedy about a group of friends in the city'],
  ['the office', 'The Office', 'en', 'deadpan workplace comedy'],
];

// Stars whose filmographies are thin (or absent) in the free credit data, with the language
// they mostly work in, so a thin match can fall back to that cinema instead of global hits.
const STAR_LANG = {
  'allu arjun': 'te', 'mahesh babu': 'te', 'n t rama rao jr': 'te', 'jr ntr': 'te', 'ram charan': 'te', prabhas: 'te', nani: 'te',
  'vijay deverakonda': 'te', chiranjeevi: 'te', 'pawan kalyan': 'te', 'ravi teja': 'te', 'nagarjuna akkineni': 'te', venkatesh: 'te',
  'samantha ruth prabhu': 'te', 'rashmika mandanna': 'te', 's s rajamouli': 'te', sukumar: 'te',
  rajinikanth: 'ta', 'kamal haasan': 'ta', 'joseph vijay': 'ta', 'ajith kumar': 'ta', suriya: 'ta', dhanush: 'ta', sivakarthikeyan: 'ta',
  karthi: 'ta', 'vijay sethupathi': 'ta', nayanthara: 'ta', 'mani ratnam': 'ta', 'lokesh kanagaraj': 'ta', vetrimaaran: 'ta',
  mohanlal: 'ml', mammootty: 'ml', 'fahadh faasil': 'ml', 'dulquer salmaan': 'ml', 'prithviraj sukumaran': 'ml', 'nivin pauly': 'ml',
  'tovino thomas': 'ml', 'jeethu joseph': 'ml',
  yash: 'kn', 'rishab shetty': 'kn', 'puneeth rajkumar': 'kn', 'kichcha sudeep': 'kn', sudeep: 'kn', upendra: 'kn', 'rakshit shetty': 'kn', 'prashanth neel': 'kn',
  'satyajit ray': 'bn', 'uttam kumar': 'bn', 'prosenjit chatterjee': 'bn', 'soumitra chatterjee': 'bn', 'ritwik ghatak': 'bn', 'rituparno ghosh': 'bn',
  'nagraj manjule': 'mr',
};
const LANG_LABEL = { hi: 'Hindi', te: 'Telugu', ta: 'Tamil', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', mr: 'Marathi' };
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

const COMMON_WORDS = new Set(['madonna', 'harish', 'mako', 'pran', 'xzibit', 'happy', 'love', 'hero', 'king', 'queen', 'star', 'babu', 'raja', 'rani',
  'baby', 'action', 'drama', 'magic', 'music', 'police', 'doctor', 'sister', 'brother', 'mother', 'father', 'family', 'india', 'indian']);

// Fan nicknames and first names people actually say, mapped to the credited name.
const PEOPLE_ALIASES = {
  srk: 'Shah Rukh Khan', shahrukh: 'Shah Rukh Khan', 'king khan': 'Shah Rukh Khan', 'big b': 'Amitabh Bachchan', amitabh: 'Amitabh Bachchan',
  salman: 'Salman Khan', sallu: 'Salman Khan', aamir: 'Aamir Khan', akki: 'Akshay Kumar', akshay: 'Akshay Kumar', hrithik: 'Hrithik Roshan',
  ranbir: 'Ranbir Kapoor', deepika: 'Deepika Padukone', rajini: 'Rajinikanth', thalaivar: 'Rajinikanth', 'superstar rajinikanth': 'Rajinikanth',
  thalapathy: 'Joseph Vijay', 'thalapathy vijay': 'Joseph Vijay', kamal: 'Kamal Haasan', ulaganayagan: 'Kamal Haasan', 'mahesh babu': 'Mahesh Babu',
  'allu arjun': 'Allu Arjun', bunny: 'Allu Arjun', ntr: 'N.T. Rama Rao Jr.', 'jr ntr': 'N.T. Rama Rao Jr.', tarak: 'N.T. Rama Rao Jr.',
  'ram charan': 'Ram Charan', chiru: 'Chiranjeevi', megastar: 'Chiranjeevi', lalettan: 'Mohanlal', rajamouli: 'S.S. Rajamouli',
  'ss rajamouli': 'S.S. Rajamouli', 'mani ratnam': 'Mani Ratnam', nolan: 'Christopher Nolan',
};

// Provider name keys match TMDB's India provider names case-insensitively.
export const PROVIDERS = [
  ['hotstar', 'JioHotstar'], ['netflix', 'Netflix'], ['amazon prime', 'Prime Video'], ['zee5', 'ZEE5'],
  ['sony liv', 'SonyLIV'], ['aha', 'aha'], ['sun nxt', 'Sun NXT'], ['apple tv', 'Apple TV+'], ['mx player', 'MX Player'], ['youtube', 'YouTube'],
];
function providerKey(raw) {
  const r = raw.toLowerCase().replace(/\s+/g, ' ');
  if (/hotstar|disney/.test(r)) return 'hotstar';
  if (/prime|amazon/.test(r)) return 'amazon prime';
  if (/zee/.test(r)) return 'zee5';
  if (/sony/.test(r)) return 'sony liv';
  if (/sun/.test(r)) return 'sun nxt';
  if (/apple/.test(r)) return 'apple tv';
  return r;
}

const LEX_STOP = new Set(['about', 'movie', 'movies', 'film', 'films', 'show', 'shows', 'story', 'stories', 'something', 'anything',
  'people', 'person', 'with', 'where', 'when', 'into', 'from', 'their', 'there', 'them', 'they', 'what', 'which', 'watch', 'good', 'great']);
const stem = (w) => (w.length > 4 ? w.replace(/(?:ies)$/, 'y').replace(/(?<![su])s$/, '') : w);

// Hindi (Devanagari) and Hinglish words -> English equivalents the rest of the parser knows.
// A full multilingual embedding model is the real fix; this covers the most common asks cheaply.
const TRANSLIT = [
  [/डरावनी|डरावना|भूतिया|हॉरर|darawni|darauni|darawna|bhootiya|bhutiya|bhoot/g, ' horror '],
  [/कॉमेडी|हास्य|मज़ेदार|मजेदार|हंसाने|comedy wali|hasya|mazedar|mazedaar|hasane/g, ' comedy '],
  [/रोमांटिक|प्यार|इश्क|प्रेम कहानी|pyaar|pyar|ishq|prem kahani/g, ' romance '],
  [/एक्शन|मारधाड़|maar ?dhaad|maardhad/g, ' action '],
  [/थ्रिलर|रहस्य|rahasya/g, ' thriller '],
  [/बच्चों|बच्चे|bachon|bachchon|bacchon|bachche|bacche/g, ' kids '],
  [/परिवार|फैमिली|pariwar|parivar/g, ' family '],
  [/देशभक्ति|desh ?bhakti/g, ' patriotic '],
  [/दुखद|रुलाने|emotional wali|dukhi|rula dene/g, ' sad '],
  [/हिंदी|हिन्दी/g, ' hindi '], [/तेलुगु/g, ' telugu '], [/तमिल/g, ' tamil '], [/मलयालम/g, ' malayalam '], [/कन्नड़/g, ' kannada '],
  [/पुरानी|purani/g, ' old '], [/नई|naya|nayi|nai wali/g, ' new movies '],
  [/बहुत लंबी न हो|लंबी न हो|ज़्यादा लंबी नहीं|ज्यादा लंबी नहीं|लंबी नहीं|छोटी सी/g, ' not too long '],
  [/मुझे|हमें|एक|जो|बहुत|कुछ|देखनी|देखना|हो|है|हैं|और|या/g, ' '],
  // Urdu script: Whisper often transcribes spoken Hindi in Urdu script, so map the common words too.
  [/شاہ ?رخ خان|شاحرخ خان|شاہرخ خان|شارخ خان/g, ' shah rukh khan '], [/سلمان خان/g, ' salman khan '], [/عامر خان/g, ' aamir khan '],
  [/اکشے کمار|اکشی کمار/g, ' akshay kumar '], [/امیتابھ بچن|امیتاب بچن/g, ' amitabh bachchan '], [/ہریتک روشن|رتک روشن|ریتک روشن/g, ' hrithik roshan '],
  [/ڈراؤنی|ڈراونی|درابنی|ڈرانی|ڈراونا|ڈراؤنا|خوفناک|بھوت|بھوتیا|ہارر|ہورر/g, ' horror '], [/کامیڈی|مزاحیہ|ہنسانے/g, ' comedy '],
  [/رومانٹک|رومانتک|رومینٹک|رومانوی|پیار|محبت|عشق/g, ' romance '], [/ایکشن/g, ' action '], [/تھرلر|تھریلر|سسپنس/g, ' thriller '],
  [/فیملی|خاندانی/g, ' family '], [/بچوں/g, ' kids '], [/حب الوطنی|دیش بھکتی/g, ' patriotic '],
  [/لمبی نہ ہو|زیادہ لمبی نہیں|لمبی نہیں/g, ' not too long '], [/ہندی/g, ' hindi '], [/تیلگو/g, ' telugu '], [/تامل/g, ' tamil '],
  [/فلمیں|فلم|فیلم|پکچر|سنیما/g, ' movie '],
  [/مجھے|ہمیں|ایک|دکھاو|دکھاؤ|دکھائیے|دکھائیں|کوئی|اچھی|اچھا|بتاؤ|بتاو|چاہیے|جو|بہت|کی|کا|کے|ہے|ہو|اور/g, ' '],
  // Telugu
  [/హారర్|భయానక|భయంకరమైన|దెయ్యం/g, ' horror '], [/కామెడీ|హాస్య|నవ్వించే|నవ్వుకునే/g, ' comedy '], [/నాకు|మాకు|ఒక/g, ' '], [/ప్రేమ|రొమాంటిక్|లవ్/g, ' romance '],
  [/యాక్షన్/g, ' action '], [/థ్రిల్లర్/g, ' thriller '], [/కుటుంబ|ఫ్యామిలీ/g, ' family '], [/పిల్లల/g, ' kids '], [/తెలుగు/g, ' telugu '],
  // Tamil
  [/திகில்|பேய்|ஹாரர்/g, ' horror '], [/நகைச்சுவை|காமெடி|சிரிக்க வைக்கும்/g, ' comedy '], [/எனக்கு|ஒரு/g, ' '], [/காதல்|ரொமான்ஸ்/g, ' romance '],
  [/ஆக்ஷன்|அதிரடி/g, ' action '], [/த்ரில்லர்/g, ' thriller '], [/குடும்ப/g, ' family '], [/குழந்தைகள்/g, ' kids '], [/தமிழ்/g, ' tamil '],
  // Malayalam
  [/ഹൊറർ|പ്രേത|ഭയപ്പെടുത്തുന്ന/g, ' horror '], [/കോമഡി|ഹാസ്യ/g, ' comedy '], [/പ്രണയ|റൊമാന്റിക്/g, ' romance '],
  [/ആക്ഷൻ/g, ' action '], [/ത്രില്ലർ/g, ' thriller '], [/കുടുംബ/g, ' family '], [/കുട്ടികൾ/g, ' kids '], [/മലയാളം|മലയാള/g, ' malayalam '],
  // Kannada
  [/ಹಾರರ್|ಭಯಾನಕ|ದೆವ್ವ/g, ' horror '], [/ಕಾಮಿಡಿ|ಹಾಸ್ಯ/g, ' comedy '], [/ಪ್ರೀತಿ|ಪ್ರೇಮ|ರೊಮ್ಯಾಂಟಿಕ್/g, ' romance '],
  [/ಆಕ್ಷನ್/g, ' action '], [/ಥ್ರಿಲ್ಲರ್/g, ' thriller '], [/ಕುಟುಂಬ/g, ' family '], [/ಮಕ್ಕಳ/g, ' kids '], [/ಕನ್ನಡ/g, ' kannada '],
  // Bengali
  [/ভূতের|ভৌতিক|হরর/g, ' horror '], [/কমেডি|হাসির/g, ' comedy '], [/প্রেম|ভালোবাসা|রোমান্টিক/g, ' romance '],
  [/অ্যাকশন/g, ' action '], [/থ্রিলার|রহস্য/g, ' thriller '], [/পারিবারিক/g, ' family '], [/ছোটদের/g, ' kids '], [/বাংলা/g, ' bengali '],
  // Marathi (Devanagari words that differ from Hindi)
  [/भयपट/g, ' horror '], [/विनोदी/g, ' comedy '], [/कौटुंबिक/g, ' family '], [/मराठी/g, ' marathi '],
  // "movie" in each script + romanized
  [/फिल्में|फिल्म|फ़िल्म|सिनेमा|चित्रपट|picture|pikchar|సినిమా|సినిమాలు|చిత్రం|படம்|படங்கள்|திரைப்படம்|സിനിമ|ಸಿನಿಮಾ|ಚಿತ್ರ|সিনেমা|ছবি/g, ' movie '],
  [/చూపించు|చెప్పు|కావాలి|ఏదైనా|మంచి|ஒரு|நல்ல|சொல்லு|வேண்டும்|ഒരു|നല്ല|പറയൂ|ಒಳ್ಳೆಯ|ಹೇಳಿ|একটা|ভালো|বলো|दाखवा|चांगला|सांगा/g, ' '],
  [/कोई|अच्छी|अच्छा|बताओ|दिखाओ|चाहिए|वाली|वाला|के लिए|koi|achhi|acchi|accha|achha|batao|dikhao|chahiye|wali|wala|ke liye|dekhni|dekhna|hai|hain/g, ' '],
];
// ---- Indic romanization -------------------------------------------------------------
// Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada and Malayalam share one
// ISCII-derived layout: the same offset in each 128-char block is the same letter. So a single
// offset table romanizes all of them well enough for phonetic title matching.
const INDIC_BASES = [0x0900, 0x0980, 0x0A00, 0x0A80, 0x0B00, 0x0B80, 0x0C00, 0x0C80, 0x0D00];
const IV = { 0x05: 'a', 0x06: 'aa', 0x07: 'i', 0x08: 'ii', 0x09: 'u', 0x0A: 'uu', 0x0B: 'ri', 0x0E: 'e', 0x0F: 'e', 0x10: 'ai', 0x12: 'o', 0x13: 'o', 0x14: 'au' };
const CONS = ['k', 'kh', 'g', 'gh', 'ng', 'c', 'ch', 'j', 'jh', 'ny', 't', 'th', 'd', 'dh', 'n', 't', 'th', 'd', 'dh', 'n', 'n', 'p', 'ph', 'b', 'bh', 'm', 'y', 'r', 'r', 'l', 'l', 'zh', 'v', 'sh', 'sh', 's', 'h'];
const VS = { 0x3E: 'aa', 0x3F: 'i', 0x40: 'ii', 0x41: 'u', 0x42: 'uu', 0x43: 'ri', 0x46: 'e', 0x47: 'e', 0x48: 'ai', 0x4A: 'o', 0x4B: 'o', 0x4C: 'au' };
export function romanize(text) {
  let out = '';
  const cps = [...text].map((c) => c.codePointAt(0));
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const base = INDIC_BASES.find((b) => cp >= b && cp < b + 0x80);
    if (base == null) { out += String.fromCodePoint(cp).toLowerCase(); continue; }
    const o = cp - base;
    if (IV[o]) out += IV[o];
    else if (o >= 0x15 && o <= 0x39) {
      out += CONS[o - 0x15];
      let j = i + 1;
      while (j < cps.length && cps[j] - base === 0x3C) j++; // nukta
      const next = j < cps.length ? cps[j] - base : -1;
      if (VS[next]) { out += VS[next]; i = j; } else if (next === 0x4D) { i = j; } else out += 'a';
    } else if (o === 0x01 || o === 0x02) {
      // Anusvara: "m" at a word end or before p/b/m (Drishyam, Kumbalangi), otherwise "n" (Hindi).
      const nb = i + 1 < cps.length ? cps[i + 1] - base : -1;
      out += (nb < 0 || nb > 0x7F || (nb >= 0x2A && nb <= 0x2E)) ? 'm' : 'n';
    }
    else if (o >= 0x66 && o <= 0x6F) out += String(o - 0x66);
  }
  return out;
}
// Coarse sound key: drop aspiration and voicing (Tamil writes b/p, g/k with one letter), merge
// long vowels, collapse doubles. "Baahubali" and "பாகுபலி" both land near "pakupali".
export function phonetic(latin) {
  return latin.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '')
    .replace(/([kgcjtdpb])h/g, '$1').replace(/sh/g, 's').replace(/zh/g, 'l')
    .replace(/[bp]/g, 'p').replace(/[gk]/g, 'k').replace(/[dt]/g, 't').replace(/[jc]/g, 'c').replace(/[vw]/g, 'v').replace(/z/g, 's')
    .replace(/h/g, '').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a').replace(/(.)\1+/g, '$1');
}
const nativeKey = (t) => t.replace(/[^\p{L}\p{M}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

// Which Indian language a piece of text is written in, by Unicode block.
export function scriptLang(text) {
  const blocks = [[/[\u0C00-\u0C7F]/, 'te'], [/[\u0B80-\u0BFF]/, 'ta'], [/[\u0D00-\u0D7F]/, 'ml'], [/[\u0C80-\u0CFF]/, 'kn'],
    [/[\u0980-\u09FF]/, 'bn'], [/[\u0A00-\u0A7F]/, 'pa'], [/[\u0A80-\u0AFF]/, 'gu'], [/[\u0900-\u097F]/, 'hi'],
    [/[\u0600-\u06FF]/, 'hi']]; // Urdu script here almost always means spoken Hindi transcribed by Whisper
  for (const [re, code] of blocks) if (re.test(text)) return code;
  return null;
}

// Whole words only, so "hai" never eats the middle of "thai" (Devanagari isn't a-z, so this holds there too).
const TRANSLIT_RE = TRANSLIT.map(([re, rep]) => [new RegExp(`(?<![a-z\u0600-\u06ff])(?:${re.source})(?![a-z\u0600-\u06ff])`, 'g'), rep]);
export function normalizeInput(text) {
  let t = text;
  for (const [re, rep] of TRANSLIT_RE) t = t.replace(re, rep);
  return t;
}

export function buildIndex(catalog) {
  const titles = new Map(); // normalized title -> [idx...]
  catalog.forEach((m, i) => {
    const k = normTitle(m.title);
    if (!titles.has(k)) titles.set(k, []);
    titles.get(k).push(i);
  });
  const people = new Map(); // normalized full name -> display name
  const peopleCompact = new Map(); // "shahrukhkhan" -> "Shah Rukh Khan"
  const credits = new Map(); // display name -> number of titles
  const directorSurnames = new Map(); // surname -> {name, count}
  for (const m of catalog) {
    for (const p of [...m.cast, ...m.directors]) credits.set(p, (credits.get(p) || 0) + 1);
    for (const p of m.cast) people.set(norm(p), p);
    for (const d of m.directors) {
      people.set(norm(d), d);
      const sur = norm(d).split(' ').pop();
      const cur = directorSurnames.get(sur);
      if (!cur) directorSurnames.set(sur, { name: d, count: 1 });
      else if (cur.name === d) cur.count++;
      else if (cur.count < 3) directorSurnames.set(sur, { name: d, count: 1 });
    }
  }
  for (const [k, name] of people) {
    const c = k.replace(/ /g, '');
    if (k.includes(' ') && c.length >= 8 && (!peopleCompact.has(c) || credits.get(name) > credits.get(peopleCompact.get(c)))) peopleCompact.set(c, name);
  }
  // One-word stage names (Prabhas, Rajinikanth, Kajol): only well-credited ones, never everyday words.
  // First names of well-credited full names ("ajay" in "Ajay Devgn") are too ambiguous to use alone.
  const firstNames = new Set();
  for (const [k, name] of people) if (k.includes(' ') && (credits.get(name) || 0) >= 3) firstNames.add(k.split(' ')[0]);
  const singleNames = new Map();
  for (const [k, name] of people) {
    if (!k.includes(' ') && k.length >= 4 && (credits.get(name) || 0) >= 3 && !firstNames.has(k) && !COMMON_WORDS.has(k) && !GENRE_WORDS.has(k)) singleNames.set(k, name);
  }
  // Native-script original titles ("పోకిరి") -> most-voted index, for typed/spoken Indian-language queries.
  const native = new Map();
  catalog.forEach((m, i) => {
    if (!m.ot) return;
    const k = nativeKey(m.ot);
    const cur = native.get(k);
    if (k && (cur == null || catalog[cur].votes < m.votes)) native.set(k, i);
  });
  const phon = new Map();
  catalog.forEach((m, i) => {
    if (!['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu'].includes(m.lang)) return;
    for (const t of [m.title, m.ot && romanize(m.ot)]) {
      if (!t) continue;
      const k = phonetic(t.replace(/:.*$/, ''));
      const cur = phon.get(k);
      if (k.length >= 4 && (cur == null || catalog[cur].votes < m.votes)) phon.set(k, i);
    }
  });
  const maxYear = Math.max(...catalog.map((m) => m.year));
  const hasTV = catalog.some((m) => m.type === 'tv');
  const loose = new Map(); // "kgfchapter1" -> most-voted index
  for (const [t, ids] of titles) {
    const k = t.replace(/ /g, '');
    const best = ids.reduce((a, b) => (catalog[b].votes > catalog[a].votes ? b : a));
    if (!loose.has(k) || catalog[loose.get(k)].votes < catalog[best].votes) loose.set(k, best);
  }
  return { titles, loose, native, phon, people, peopleCompact, singleNames, credits, directorSurnames, catalog, maxYear, hasTV, topicWords: null };
}

// Fuzzy title resolution: exact normalized match first (most-voted wins, so
// "Alien" is the 1979 film), else best bigram-Dice match above a threshold.
export function resolveTitle(raw, index) {
  const q = normTitle(raw);
  if (q.length < 2) return null;
  const exact = index.titles.get(q);
  if (exact) return exact.reduce((a, b) => (index.catalog[b].votes > index.catalog[a].votes ? b : a));
  const lq = q.replace(/ /g, '');
  if (lq.length >= 3 && index.loose) {
    if (index.loose.has(lq)) return index.loose.get(lq);
    let pre = null;
    for (const [k, i] of index.loose) if (k.startsWith(lq) && /^[a-z]{3,6}$/.test(lq) && (pre == null || index.catalog[i].votes > index.catalog[pre].votes)) pre = i;
    if (pre != null && q.length <= 6) return pre; // short acronym-like names only
  }
  let best = null, bestScore = 0;
  for (const [t, ids] of index.titles) {
    if (Math.abs(t.length - q.length) > Math.max(6, q.length)) continue;
    let s = dice(q, t);
    if (t.startsWith(q + ' ') || t.startsWith(q + ' part')) s = Math.max(s, 0.86); // "harry potter" -> first match
    const top = ids.reduce((a, b) => (index.catalog[b].votes > index.catalog[a].votes ? b : a));
    s += Math.min(0.04, Math.log10(index.catalog[top].votes) / 150); // popularity tiebreak
    if (s > bestScore) { bestScore = s; best = top; }
  }
  return bestScore >= 0.72 ? best : null;
}

// Title lookup for bare-title queries: exact, punctuation-insensitive ("kgf" -> "K.G.F"),
// prefix ("pushpa" -> "Pushpa: The Rise"), or sound-alike for Indian titles ("baahubali").
// A trailing sequel number that isn't in the catalog ("Pushpa 2") resolves to the base film
// and is reported back so the reply can say what's missing.
function resolveTitleIntent(q, raw, index) {
  const nameLike = (w) => /[A-Z0-9]/.test(raw) || !index.topicWords?.has(w);
  const qn = normTitle(q);
  if (!qn || !qn.split(' ').every(nameLike)) return null;
  const pick = (ids) => ids.reduce((a, b) => (index.catalog[b].votes > index.catalog[a].votes ? b : a));
  const find = (key) => {
    if (index.titles.has(key)) return pick(index.titles.get(key));
    const loose = key.replace(/ /g, '');
    if (loose.length < 3) return null;
    if (index.loose.has(loose)) return index.loose.get(loose);
    let best = null;
    for (const [k, i] of index.loose) if (k.startsWith(loose) && (best == null || index.catalog[i].votes > index.catalog[best].votes)) best = i;
    if (best != null) return best;
    if (!key.includes(' ')) return index.phon.get(phonetic(key)) ?? null;
    return null;
  };
  const direct = find(qn);
  if (direct != null) {
    // "Kalki": an exact but obscure title loses to a much more popular one that starts with the
    // same word ("Kalki 2898-AD"), since that's almost always what people mean.
    const loose = qn.replace(/ /g, '');
    let alt = null;
    if (loose.length >= 4) for (const [k, i] of index.loose) if (k !== loose && k.startsWith(loose) && /^[^a-z]/.test(k.slice(loose.length)) && (alt == null || index.catalog[i].votes > index.catalog[alt].votes)) alt = i;
    if (alt != null && index.catalog[alt].votes >= 5 * Math.max(1, index.catalog[direct].votes)) return { i: alt };
    return { i: direct };
  }
  const seq = qn.match(/^(.+?)\s+(?:part\s+)?(\d{1,2}|ii|iii|iv)$/);
  if (seq) {
    const base = find(seq[1]);
    if (base != null) return { i: base, missing: titleCase(q) };
  }
  return null;
}

const GENRE_WORDS = new Set(GENRE_LEXICON.flatMap(([ps]) => ps.map((p) => norm(p))));

const ANCHOR_TRIGGER = /\b(?:(?:more |something |anything |stuff |movies? |films? )?(?:like|similar to|in the vein of|in the style of|along the lines of|reminds? me of|same vibes? as|the vibe of|vibes? of|if i (?:liked|loved|enjoyed)|fans? of|comparable to))\s+/gi;
const ANCHOR_STOP = /\s*(?:,|;|\bbut\b|\bexcept\b|\bthough\b|\bwith(?:out)?\b|\bthat\b|\bwhich\b|\bunder\b|\bover\b|\bless than\b|\bmore than\b|\bshorter\b|\blonger\b|\bfrom\b|\bset in\b|\bin the\b|\bnot\b|\bminus\b|\bplus\b|\bonly\b|\bbefore\b|\bafter\b|\bsince\b|\bfor\b|$)/i;

function extractAnchors(text, index, consume, rawText = '', isFree = () => true) {
  const anchors = [];
  ANCHOR_TRIGGER.lastIndex = 0;
  let m;
  while ((m = ANCHOR_TRIGGER.exec(text))) {
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const stop = rest.search(ANCHOR_STOP);
    const phrase = rest.slice(0, stop < 0 ? rest.length : stop).replace(/[.?!]+$/, '').trim();
    if (!phrase) continue;
    // "I'd like a comedy"
    if (!isFree(start, start + phrase.length)) continue; // already claimed (e.g. a TV show name) / "feels like home" / "like the second one" are not title references.
    if (/(?:would|'d|\bi|\bwe|\byou|feel|feels|felt|looks?|sounds?)\s*$/.test(text.slice(0, m.index).trimEnd())) continue;
    if (/^(?:the |a |an )?(?:first|second|third|fourth|fifth|last|top|1st|2nd|3rd|4th|5th|#\s*\d|number\b|this|that|these|those|it\b|them\b|one\b|ones\b)/.test(phrase)) continue;
    if (GENRE_WORDS.has(norm(phrase).replace(/^(a|an|the) /, '').replace(/ (movies?|films?)$/, ''))) continue;
    // Try the whole phrase ("Fast and Furious"), then split lists ("Up and Coco").
    let ids = [];
    const whole = resolveTitle(phrase, index);
    if (whole != null) ids = [whole];
    else {
      for (const part of phrase.split(/\s*(?:,|\band\b|\bor\b|&)\s*/)) {
        const id = resolveTitle(part, index);
        if (id != null) ids.push(id);
      }
    }
    if (ids.length) {
      anchors.push(...ids);
      consume(m.index, start + phrase.length);
    }
  }
  // Indian-language "like": the title comes BEFORE the postposition ("Pokiri jaisi", "Pokiri lanti").
  const POST = /([a-z0-9][a-z0-9:' -]{1,60}?)\s+(?:jaisi|jaisa|jaise|ke jaisi|ki tarah|ke tarah|type ki|type ka|lanti|laanti|lanti di|laga|laaga|madhiri|maadiri|mathiri|maari|pola|pole|polulla|tharam|tarah|tara|antha|matho|moto|motoi|sarkha|sarkhi|sarkhe)\b/g;
  while ((m = POST.exec(text))) {
    const words = m[1].trim().split(/\s+/);
    for (let n = Math.min(5, words.length); n >= 1; n--) {
      const phrase = words.slice(-n).join(' ');
      if (GENRE_WORDS.has(phrase) || /^(koi|ek|oka|oru|movie|film|a|the)$/.test(phrase)) continue;
      const id = resolveTitle(phrase, index);
      if (id != null) {
        anchors.push(id);
        consume(m.index + m[0].indexOf(phrase), m.index + m[0].length);
        break;
      }
    }
  }
  // Titles typed in an Indian script ("పోకిరి లాంటి సినిమా"). First an exact whole-word match on
  // native original titles; failing that, romanize the words and match phonetically against
  // Indian films' English titles, which catches cross-script names ("பாகுபலி" -> Baahubali).
  if (/[^\x00-\u024f]/.test(rawText)) {
    const key = nativeKey(rawText);
    const toks = ` ${key} `;
    // Words right before an Indian-language "like" (లాంటి, மாதிரி, जैसी, പോലെ, ತರಹ, মতো, सारखा…).
    const post = key.match(/((?:\S+\s+){0,2}\S+)\s+(?:లాంటి|లాగా|వంటి|మాదిరి|மாதிரி|போல|போன்ற|போல்|जैसी|जैसा|जैसे|की तरह|के जैसी|പോലെ|പോലുള്ള|ತರಹ|ಅಂತಹ|ಹಾಗೆ|মতো|মত|सारखा|सारखी|सारखे)(?:\s|$)/u);
    const before = post ? post[1].split(' ') : [];
    let best = null;
    for (const [t, i] of index.native) {
      // Short native titles ("डर" = fear) are ordinary words; only trust them right before "like".
      const ok = t.length >= 4 ? toks.includes(` ${t} `) : before.length && ` ${before.join(' ')} `.includes(` ${t} `);
      if (ok && (!best || t.length > best[0].length)) best = [t, i];
    }
    if (best) anchors.push(best[1]);
    else if (before.length) {
      // Cross-script: romanize the words before "like" and match phonetically against Indian titles.
      let hit = null, hitScore = 0;
      for (let n = before.length; n >= 1; n--) {
        const k = phonetic(romanize(before.slice(-n).join(' ')));
        if (k.length < 4) continue;
        for (const [pk, i] of index.phon) {
          if (Math.abs(pk.length - k.length) > 3) continue;
          const sc = dice(pk, k) + Math.min(0.03, Math.log10(index.catalog[i].votes + 1) / 150);
          if (sc > hitScore) { hitScore = sc; hit = i; }
        }
      }
      if (hit != null && hitScore >= 0.72) anchors.push(hit);
    }
  }

  // "funnier than Interstellar": the comparative itself is left for the steering pass.
  const THAN = /\b(?:[a-z]+er|more [a-z-]+|less [a-z-]+|not as [a-z-]+)\s+(than|as)\s+/gi;
  while ((m = THAN.exec(text))) {
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const stop = rest.search(ANCHOR_STOP);
    const phrase = rest.slice(0, stop < 0 ? rest.length : stop).replace(/[.?!]+$/, '').trim();
    if (!phrase || /^(?:that|those|these|it|this|them|the (?:first|second|third|last) one)\b/.test(phrase)) continue;
    if (GENRE_WORDS.has(norm(phrase).replace(/^(a|an|the) /, '').replace(/ (movies?|films?)$/, ''))) continue;
    const id = resolveTitle(phrase, index);
    if (id != null) {
      anchors.push(id);
      consume(m.index + m[0].search(/\s(?:than|as)\s+$/i) + 1, start + phrase.length);
    }
  }
  return [...new Set(anchors)];
}

// Collects the spans each rule consumed so the leftover text can be embedded.
class Spans {
  constructor(text) { this.text = text; this.mask = new Array(text.length).fill(false); }
  take(a, b) { for (let i = a; i < b; i++) this.mask[i] = true; }
  takeRe(re, fn) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(this.text))) {
      if (!m[0].length) { g.lastIndex++; continue; }
      if (!this.free(m.index, m.index + m[0].length)) continue;
      if (fn(m) !== false) this.take(m.index, m.index + m[0].length);
      if (!m[0].length) g.lastIndex++;
    }
  }
  free(a, b) { for (let i = a; i < b; i++) if (this.mask[i]) return false; return true; }
  leftover() { return this.text.split('').map((c, i) => (this.mask[i] ? ' ' : c)).join(''); }
}

const NEG_BEFORE = /\b(?:no|not|nothing|without|avoid|except|skip|minus|isn'?t|aren'?t|don'?t want|hate|non)\s+(?:too\s+|very\s+|really\s+|a\s+|any\s+|more\s+)?$/i;

export function parse(input, index) {
  const normalized = normalizeInput(input.toLowerCase());
  let pre = normalized.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  const cheer = /cheer me up|lift my|pick me up|make me (?:laugh|smile|happy)|need a (?:laugh|smile)|mood booster|bad day/.test(pre);
  for (const [re, rep] of IDIOMS) pre = pre.replace(re, rep);
  // "I'm sad, cheer me up" wants the opposite of sad.
  if (cheer) pre = pre.replace(/\b(?:i'?m|i am|feeling|feel|so)?\s*(?:sad|down|low|blue|depressed|upset|stressed)\b/g, ' ');
  const text = ' ' + pre.trim() + ' ';
  const lower = text.toLowerCase();
  const sp = new Spans(lower);
  const intent = {
    raw: input.trim(), filters: {}, genres: [], softGenres: [], avoidGenres: [], excludeGenres: [],
    anchors: [], steer: {}, moods: [], people: [], quality: null, expansions: [], notes: [], refine: {},
  };
  const f = intent.filters;

  // --- conversation control first, so "new search" isn't read as "new releases"
  sp.takeRe(/\b(?:start(?:ing)? over|new search|new chat|forget (?:that|it|all that|about that)|never ?mind|actually|instead|reset|something different entirely|different question)\b[:,.]?/i, () => { intent.refine.reset = true; });

  // --- things PopcornPal can't do: say so plainly, then offer the closest useful thing
  sp.takeRe(/\b(?:ipl|live (?:cricket|matches?|scores?|sports?|football|games?|stream(?:ing)?)|(?:cricket|football|kabaddi|tennis|hockey) (?:matches|match|scores?|highlights|live)|match highlights|highlights|world cup live|isl|premier league|formula (?:1|one)|f1 races?)\b/i, (m) => {
    if (intent.sports) return;
    intent.sports = true;
    const cricket = /ipl|cricket|world cup/.test(lower);
    intent.notes.push(`Live sports and match highlights aren’t part of PopcornPal; it’s for movies (on JioHotstar they’d sit under Sports). Here are ${cricket ? 'cricket' : 'sports'} films instead.`);
    intent.lex = [...(intent.lex || []), cricket ? 'cricket' : 'sport'];
    intent.expansions.push(cricket ? 'cricket match, a cricket team and the World Cup' : 'sports drama, a big match');
  });
  sp.takeRe(/\b(?:(?:oscar|academy award|national (?:film )?award|filmfare|golden globe|cannes)(?:[- ]winning|[- ]winners?|s)?|award[- ]winning|won (?:an? )?(?:oscar|awards?))\b/i, () => {
    intent.quality = 'high';
    intent.notes.push('I don’t have awards data yet, so these are the highest-rated matches instead.');
  });
  sp.takeRe(/\b(?:dubbed (?:in(?:to)? )?(hindi|telugu|tamil|malayalam|kannada|english|bengali|marathi)|(hindi|telugu|tamil|malayalam|kannada|english|bengali|marathi)[- ]dubbed|(?:with )?(hindi|telugu|tamil|malayalam|kannada|english|bengali|marathi) dub(?:bing)?|dubbed)\b/i, (m) => {
    const lang = m[1] || m[2] || m[3];
    intent.notes.push(`I can’t see dub or audio-language availability yet, so these are originals${lang ? `; many big ones also have ${titleCase(lang)} dubs` : ''}.`);
  });
  for (const [key, name, lang, feel] of KNOWN_SHOWS) {
    sp.takeRe(new RegExp(String.raw`\b(?:the )?${escapeRe(key)}\b`, 'i'), () => {
      intent.show = name;
      // Once the catalog has TV, the show is just a title: anchor on the real series.
      const tv = index.hasTV ? index.catalog.findIndex((m) => m.type === 'tv' && normTitle(m.title) === normTitle(name)) : -1;
      if (tv >= 0) {
        intent.anchors.push(tv); intent.showIdx = tv;
        if (!/\b(?:like|similar|vibe|such as)\b/.test(lower)) intent.titleHit = tv; // "Mirzapur" -> the series first
        return;
      }
      intent.notes.push(`${name} is a TV series that isn’t in my catalog, so here are titles with a similar feel.`);
      intent.expansions.push(feel);
      if (lang !== 'en') { intent.langBoost = [lang]; intent.langBoostWeight = 1.8; }
    });
  }

  // --- reference titles ("like Inception") — before anything else eats title words
  intent.anchors = [...intent.anchors, ...extractAnchors(lower, index, (a, b) => sp.take(a, b), input, (a, b) => sp.free(a, b))];

  // --- runtime
  sp.takeRe(new RegExp(String.raw`\b(?:under|less than|shorter than|below|max(?:imum)?|no (?:more|longer) than|at most|within|tops|up to|not (?:more|longer) than|<)\s*${DURATION}(?:\s+long)?`, 'i'), (m) => {
    const d = parseDuration(m[0]); if (!d) return false; f.maxRuntime = d;
  });
  sp.takeRe(new RegExp(String.raw`\b(?:over|more than|longer than|at least|above|minimum|>)\s*${DURATION}(?:\s+long)?`, 'i'), (m) => {
    const d = parseDuration(m[0]); if (!d) return false; f.minRuntime = d;
  });
  sp.takeRe(new RegExp(String.raw`\b(?:around|about|roughly|approximately|~)\s*${DURATION}(?:\s+long)?`, 'i'), (m) => {
    const d = parseDuration(m[0]); if (!d) return false; f.minRuntime = d - 15; f.maxRuntime = d + 15;
  });
  // Bare durations ("a 90 minute movie", "an hour and a half sci-fi") mean "about that long".
  sp.takeRe(new RegExp(String.raw`\b${DURATION}(?:\s+(?:long|or (?:so|less)|max|tops))?`, 'i'), (m) => {
    const d = parseDuration(m[0]); if (!d || d < 30) return false;
    if (/or less|max|tops/.test(m[0])) { f.maxRuntime = d; return; }
    if (f.maxRuntime == null && f.minRuntime == null) { f.minRuntime = d - 20; f.maxRuntime = d + 10; }
  });
  sp.takeRe(/\b(?:short|quick|brief)(?:\s+(?:one|movie|film))?\b(?!\s+(?:story|stories|film festival))/i, () => {
    if (f.maxRuntime == null) f.maxRuntime = 100;
  });
  sp.takeRe(/\b(?:((?:not|aren'?t|isn'?t|nothing|never|without being) (?:too |so |very |that |super |overly )?)?(?:long|lengthy))(?:\s+(?:one|movie|film))?\b/i, (m) => {
    if (m[1]) { if (f.maxRuntime == null) f.maxRuntime = 125; } else if (f.minRuntime == null) f.minRuntime = 140;
  });

  // --- years / eras
  sp.takeRe(/\b(?:from |in |of |made in |set in )?(?:the )?(?:(19|20)?([0-9])0)'?s\b/i, (m) => {
    const century = m[1] ? +m[1] * 100 : (+m[2] >= 3 ? 1900 : 2000);
    const start = century + +m[2] * 10;
    if (start < 1900 || start > index.maxYear) return false;
    if (/set in/.test(m[0])) return false; // "set in the 80s" is a story setting, keep for semantics
    f.yearMin = start; f.yearMax = start + 9;
  });
  sp.takeRe(/\b(?:before|pre-?|older than|prior to|until)\s*((?:19|20)\d\d)\b/i, (m) => { f.yearMax = +m[1] - 1; });
  sp.takeRe(/\b(?:after|post-?|since|newer than|from)\s*((?:19|20)\d\d)\b/i, (m) => { f.yearMin = +m[1] + (/after|post/.test(m[0]) ? 1 : 0); });
  sp.takeRe(/\b(?:between|from)\s*((?:19|20)\d\d)\s*(?:and|to|-)\s*((?:19|20)\d\d)\b/i, (m) => { f.yearMin = +m[1]; f.yearMax = +m[2]; });
  sp.takeRe(/\b(?:in|released in|came out in)\s+((?:19|20)\d\d)\b/i, (m) => { f.yearMin = f.yearMax = +m[1]; });
  sp.takeRe(/\b(?:recent|brand new|new(?=\s+(?:movies?|films?|releases?|ones?|stuff)\b)|latest|newest|modern|recently released)\b(?:\s+(?:ones?|releases?|movies?|films?))?/i, (m) => {
    const latest = /latest|newest|brand new/.test(m[0]);
    if (f.yearMin == null) f.yearMin = index.maxYear - (latest ? 3 : 6);
    intent.recent = latest ? 1 : 0.5; // also rank newer first within the window
  });
  sp.takeRe(/\b(?:old(?! school| west| man| woman| friends?)|classic|classics|vintage|golden age|old school|old-school)\b(?:\s+(?:ones?|movies?|films?|hollywood))?/i, (m) => {
    if (f.yearMax == null) f.yearMax = /golden/.test(m[0]) ? 1965 : 1995;
    if (/classic/.test(m[0])) intent.quality = 'high';
  });

  // --- ratings
  sp.takeRe(/\b(?:rated|rating|score)\s*(?:of\s*)?(?:above|over|at least|more than|>=?|\+)?\s*(\d(?:\.\d)?)(?![\d']|s\b)(?:\s*(?:\+|or (?:more|higher|above)|stars?|\/10))?/i, (m) => { f.minRating = +m[1]; });
  sp.takeRe(/\b(?:hidden gems?|underrated|under-rated|lesser[- ]known|obscure|under the radar|not (?:too )?(?:mainstream|popular|well[- ]known))\b/i, () => { intent.quality = 'hidden'; });
  sp.takeRe(/\b(?:highly[- ]rated|top[- ]rated|best|acclaimed|critically acclaimed|award[- ]winning|oscar[- ]winning|masterpieces?|must[- ]see|must[- ]watch|great|excellent|really good)\b/i, () => {
    if (intent.quality !== 'hidden') intent.quality = 'high';
  });
  sp.takeRe(/\b(?:popular|blockbusters?|mainstream|well[- ]known|crowd[- ]pleasers?|famous)\b/i, () => { intent.quality = intent.quality || 'popular'; });

  // --- language
  sp.takeRe(/\b(?:foreign|international|non-english|world cinema|subtitled|with subtitles)\b(?:\s+(?:language|movies?|films?))?/i, () => { f.excludeLangs = ['en']; });
  sp.takeRe(/\b(?:no subtitles|in english|english[- ]language)\b/i, () => { f.langs = ['en']; });
  for (const [words, codes] of LANGS) {
    for (const word of words) {
      sp.takeRe(new RegExp(String.raw`\b(?:in\s+)?${word}(?:\s+(?:language|cinema))?\b`, 'i'), (m) => {
        const before = lower.slice(Math.max(0, m.index - 12), m.index);
        if (/\bnot?\s*$|\bnon-?\s*$/.test(before)) { f.excludeLangs = [...(f.excludeLangs || []), ...codes]; return; }
        f.langs = [...new Set([...(f.langs || []), ...codes])];
        if (/wood$/.test(word)) intent.expansions.push(word[0].toUpperCase() + word.slice(1));
      });
    }
  }
  if (/\banime\b/.test(lower)) f.langs = f.langs || ['ja'];

  // --- where to watch ("on Netflix", "streaming on JioHotstar", "something I can watch")
  sp.takeRe(/\b(?:(?:streaming|available|that'?s|which is|is)\s+)?on\s+(netflix|amazon prime video|amazon prime|prime video|prime|amazon|jio\s?hotstar|hotstar|disney\+?\s?hotstar|zee\s?5|sony\s?liv|aha|sun\s?nxt|mx player|apple tv\+?|youtube)\b/i, (m) => {
    f.providers = [...new Set([...(f.providers || []), providerKey(m[1])])];
  });
  sp.takeRe(/\b(?:on my apps|(?:that )?i can (?:actually )?(?:watch|stream)(?: (?:now|tonight|right now))?|on my subscriptions?|what i have)\b/i, () => { intent.mine = true; });

  // --- type
  sp.takeRe(/\b(?:tv shows?|tv series|tv|shows(?! me)|(?<!the )series|sitcoms?|miniseries|binge(?:-?worthy)?)\b/i, () => {
    if (index.hasTV) f.type = 'tv';
    else if (!intent.show) intent.notes.push('TV shows aren’t in my catalog yet, so these are films.');
    if (index.hasTV) intent.wantsTV = true;
  });

  // --- people ("with Tom Hanks", "directed by Nolan", "Shahrukh movies", "Thalaivar", "Prabhas")
  // Only unconsumed text: "like Vikram Vedha" must not also read "Vikram" as the actor.
  const words = norm(sp.leftover()).split(' ').filter(Boolean);
  const usedTok = new Set(); // token positions already part of a matched name ("ajay" inside "ajay devgn")
  for (let n = 4; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if ([...Array(n).keys()].some((k) => usedTok.has(i + k))) continue;
      const cand = words.slice(i, i + n).join(' ');
      const compact = cand.replace(/ /g, '');
      // Exact full name, a spacing/spelling variant ("shahrukh khan"), a fan nickname, or a one-word star name.
      const name = (n >= 2 && index.people.get(cand)) || index.peopleCompact.get(compact) || PEOPLE_ALIASES[cand]
        || (n === 1 && index.singleNames.get(cand));
      if (name && !intent.people.includes(name) && index.people.has(norm(name))) {
        intent.people.push(name);
        for (let k = 0; k < n; k++) usedTok.add(i + k);
        sp.takeRe(new RegExp(String.raw`\b(?:starring|with|featuring|directed by|by|from)?\s*${cand.split(' ').map(escapeRe).join('[^a-z]+')}(?:'s)?\b`, 'i'), () => {});
      }
    }
  }
  // Stars we know of but have few or no credits for: keep the person filter (exact matches first)
  // and fall back to their cinema's language, saying so.
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const cand = words.slice(i, i + n).join(' ');
      const lang = STAR_LANG[cand];
      if (!lang || (n === 1 && !index.singleNames.has(cand) && !['prabhas', 'nani', 'yash', 'mohanlal', 'mammootty', 'rajinikanth', 'suriya', 'dhanush', 'chiranjeevi', 'sudeep', 'karthi', 'nayanthara', 'upendra', 'sivakarthikeyan', 'vetrimaaran', 'venkatesh', 'sukumar'].includes(cand))) continue;
      const known = intent.people.find((p) => norm(p) === cand || norm(p).replace(/ /g, '') === cand.replace(/ /g, ''));
      const credits = known ? index.credits.get(known) || 0 : 0;
      if (known && credits >= 4) continue;
      intent.peopleLang = lang;
      if (!known) {
        const display = titleCase(cand).replace(/\bJr\b/, 'Jr.').replace(/^N T /, 'N.T. ').replace(/^S S /, 'S.S. ');
        intent.notes.push(`I don’t have ${display}’s filmography yet (it arrives with the TMDB data sync), so here are popular ${LANG_LABEL[lang]} films.`);
        if (!f.langs) f.langs = [lang];
        sp.takeRe(new RegExp(String.raw`\b(?:starring|with|featuring|directed by|by|anything with|films? by|movies? by)?\s*${cand.split(' ').map(escapeRe).join('[^a-z]+')}(?:'s)?\b`, 'i'), () => {});
      } else {
        intent.notes.push(`I only know ${credits} ${known} film${credits === 1 ? '' : 's'} so far; the rest are popular ${LANG_LABEL[lang]} films.`);
      }
    }
  }
  sp.takeRe(/\b(?:directed by|by|from director|director)\s+([a-z][a-z'-]+)\b|\b([a-z][a-z'-]+)(?:'s)?\s+(?:movie|movies|film|films)\b/i, (m) => {
    const sur = norm(m[1] || m[2] || '');
    const hit = index.directorSurnames.get(sur);
    if (!hit || hit.count < 3 || intent.people.includes(hit.name)) return false;
    intent.people.push(hit.name);
  });
  sp.takeRe(/\b(?:starring|with|featuring|directed by|by)\s*$/i, () => {});

  // --- relative modifiers ("less confusing", "funnier", "not as dark")
  for (const [axis, def] of Object.entries(AXES)) {
    for (const [w, sign] of Object.entries(def.words)) {
      const re = new RegExp(String.raw`\b(?:(less|not as|not so|not too|not that|not overly|not very|not|nothing|no|non|never|without|without being|way less|a bit less|a little less|slightly less|much less|fewer)\s+|(more|even more|way more|a bit more|a little more|slightly more|much more|extra)\s+)?${escapeRe(w)}(?:\s+than\s+(?:that|those|these|it))?\b`, 'gi');
      let m;
      while ((m = re.exec(lower))) {
        const comparative = m[1] || m[2] || /er$/.test(w);
        if (!comparative) continue; // bare adjectives are handled as moods / semantics
        if (!sp.free(m.index, m.index + m[0].length)) continue;
        const flip = m[1] ? -1 : 1;
        intent.steer[axis] = (intent.steer[axis] || 0) + sign * flip;
        sp.take(m.index, m.index + m[0].length);
      }
    }
  }

  // --- moods
  for (const mood of MOODS) {
    for (const w of mood.words) {
      const re = wordRe(w);
      const m = re.exec(lower);
      if (!m || !sp.free(m.index, m.index + m[0].length)) continue;
      const before = lower.slice(Math.max(0, m.index - 14), m.index);
      if (NEG_BEFORE.test(before)) {
        for (const [ax, s] of Object.entries(mood.steer || {})) intent.steer[ax] = (intent.steer[ax] || 0) - s;
        sp.take(m.index - before.match(NEG_BEFORE)[0].length, m.index + m[0].length);
        break;
      }
      intent.moods.push(mood.label);
      intent.expansions.push(mood.expand);
      if (mood.langs && !f.langs) f.langs = mood.langs;
      if (mood.langBoost) intent.langBoost = mood.langBoost;
      if (mood.lex) intent.lex = [...(intent.lex || []), ...mood.lex];
      for (const w2 of mood.words) sp.takeRe(wordRe(w2), () => {}); // swallow synonyms too ("mass masala")
      intent.softGenres.push(...(mood.genres || []));
      intent.avoidGenres.push(...(mood.avoid || []));
      for (const [ax, s] of Object.entries(mood.steer || {})) intent.steer[ax] = (intent.steer[ax] || 0) + s * 0.5;
      sp.take(m.index, m.index + m[0].length);
      break;
    }
  }

  // --- genres (with negation: "no horror", "not a romance")
  for (const [phrases, genres] of GENRE_LEXICON) {
    for (const p of phrases) {
      const re = new RegExp(String.raw`(?<![a-z-])${escapeRe(p)}(?![a-z])`, 'gi');
      let m;
      while ((m = re.exec(lower))) {
        if (!sp.free(m.index, m.index + m[0].length)) continue;
        const before = lower.slice(Math.max(0, m.index - 22), m.index);
        const neg = before.match(NEG_BEFORE);
        if (neg) {
          intent.excludeGenres.push(...genres);
          sp.take(m.index - neg[0].length, m.index + m[0].length);
        } else {
          // "funny"/"scary" describe tone, so they are soft; nouns like "comedy" are hard.
          const soft = /^(funny|hilarious|laugh|romantic|magical|magic|dramatic|suspenseful|heist|detective|children)$/.test(p);
          (soft ? intent.softGenres : intent.genres).push(...genres);
          if (soft) intent.expansions.push(p);
          sp.take(m.index, m.index + m[0].length);
        }
      }
    }
  }
  if (intent.genres.includes('Family')) { intent.avoidGenres.push('Horror'); intent.steer.darkness = (intent.steer.darkness || 0) - 0.5; }

  // --- conversational refinements (only meaningful as follow-ups)
  const r = intent.refine;
  sp.takeRe(/\b(?:shorter|less long|not as long|not so long)\b/i, () => { r.shorter = true; });
  sp.takeRe(/\b(?:longer)\b/i, () => { r.longer = true; });
  sp.takeRe(/\b(?:newer|more recent|less old)\b/i, () => { r.newer = true; });
  sp.takeRe(/\b(?:older|less recent)\b/i, () => { r.older = true; });
  sp.takeRe(/\b(?:show me |give me |any )?(?:more|others|other ones|something else|different ones|next|keep going)\b(?:\s+(?:results|options|ones|please|like (?:this|these)))?\s*[.?!]?\s*$/i, () => { r.more = true; });
  sp.takeRe(/\b(?:more |something )?like (?:the )?(first|second|third|fourth|fifth|top|last|1st|2nd|3rd|4th|5th|#\s*\d+|number \d+)(?: one| pick)?\b/i, (m) => {
    const map = { first: 0, top: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4, last: -1 };
    const k = m[1].replace(/#\s*|number /, '');
    r.likeResult = map[k] ?? (+k - 1);
  });
  if (/^\s*(?:but|and|also|make it|maybe|only|just|now|what about|how about|ok(?:ay)?|hmm+|nah|no,|not|any|same but|ideally|preferably|less|more|without|with)\b/i.test(text)) r.continues = true;

  // --- leftover text becomes the semantic description
  const left = sp.leftover()
    .replace(/\b(?:i'?d|i'?m|i'?ve|it'?s|that'?s|aren'?t|isn'?t|don'?t|doesn'?t|won'?t|wouldn'?t|can'?t|let'?s|what'?s|there'?s|we'?re|you'?re)\b/g, ' ')
    .replace(/[^\x00-\u024f]+/g, ' ') // untranslated Indic words: the English model can't use them
    .replace(/["'?!.,;:()]/g, ' ')
    .replace(FILLER, ' ')
    .replace(/\b(?:so|too|very|than|that|as|be|not|from|set|by|era|made|where|who|has|have|had|was|were|will|would|could|lot|lots|plenty|type|kind|sort|vibe|vibes|no|kinda|bit|little|less|more|then|there|these|those|this|minutes?|hours?|long|like|web|tonight|watch|popular)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  intent.semantic = left.length >= 3 ? left : '';
  // Asked in an Indian script or Hinglish: lean (softly) toward that language unless one was named.
  if (!f.langs && !intent.langBoost) {
    const script = scriptLang(input);
    // Asking in a language's own script (or Hinglish) is a strong signal, stronger than a mood's lean.
    // Writing in a language's own script is a near-certain preference: make it a (relaxable)
    // language filter, shown as a chip the viewer can remove.
    if (script) { f.langs = [script]; intent.langFromScript = true; }
    else if (normalized !== input.toLowerCase()) { intent.langBoost = ['hi']; intent.langBoostWeight = 2.2; }
  }
  // Content words for the lexical half of hybrid scoring (exact topical words like "cricket",
  // "zombie" that pure embeddings blur into "sports drama" / "horror").
  const content = intent.semantic.split(' ').filter((w) => w.length >= 4 && !LEX_STOP.has(w));
  intent.lex = [...new Set([...content.map(stem), ...(intent.lex || [])])].slice(0, 6);
  if (content.length >= 2) intent.lexPhrase = content.map(stem).join(' ');

  // --- a bare title ("Kantara", "Pushpa 2", "RRR"): show that film first, then films like it.
  // Only when nothing else was understood, and only for name-like words (capitalized, or not an
  // everyday topic word), so "heist" or "space" still mean topics.
  if (!intent.anchors.length && !intent.genres.length && !intent.moods.length && !intent.people.length && !intent.show
      && !Object.keys(f).length && !Object.keys(intent.steer).length && intent.semantic && intent.semantic.split(' ').length <= 4) {
    const hit = resolveTitleIntent(intent.semantic, input, index);
    if (hit) {
      intent.titleHit = hit.i;
      intent.anchors = [hit.i];
      if (hit.missing) intent.notes.push(`${hit.missing} isn’t in my catalog yet, so here’s ${index.catalog[hit.i].title} and films like it.`);
      intent.semantic = '';
      intent.lex = [];
      delete intent.lexPhrase;
    }
  }

  // Films vs series once the catalog has both: a runtime or the word "movie" means films;
  // a series as the reference ("something like Breaking Bad") means series; otherwise both.
  if (index.hasTV && !f.type) {
    if (f.maxRuntime || f.minRuntime || /\b(?:movies?|films?|flicks?|cinema|picture)\b/.test(lower)) f.type = 'movie';
    else if (intent.anchors.length && intent.anchors.every((a) => index.catalog[a].type === 'tv')) f.type = 'tv';
  }
  intent.notes = [...new Set(intent.notes)];
  intent.genres = [...new Set(intent.genres)];
  intent.softGenres = [...new Set(intent.softGenres)].filter((g) => !intent.genres.includes(g) && !intent.excludeGenres.includes(g));
  intent.avoidGenres = [...new Set(intent.avoidGenres)].filter((g) => !intent.genres.includes(g));
  intent.excludeGenres = [...new Set(intent.excludeGenres)];
  intent.expansions = [...new Set(intent.expansions)];
  for (const k of Object.keys(intent.steer)) {
    intent.steer[k] = Math.max(-1.5, Math.min(1.5, intent.steer[k]));
    if (!intent.steer[k]) delete intent.steer[k];
  }
  return intent;
}

// True when the new turn reads as a tweak to the previous one rather than a new request.
export function isFollowUp(intent, prev) {
  if (!prev || intent.refine.reset) return false;
  const r = intent.refine;
  if (r.more || r.likeResult != null || r.shorter || r.longer || r.newer || r.older) return true;
  const newTopic = intent.semantic || intent.anchors.length || intent.genres.length || intent.moods.length || intent.people.length;
  if (r.continues) return true;
  return !newTopic && (Object.keys(intent.filters).length > 0 || Object.keys(intent.steer).length > 0 || intent.excludeGenres.length > 0 || intent.quality);
}

// Folds a follow-up into the previous intent ("shorter", "no horror", "more like the second one").
export function mergeIntent(prev, next, lastResults, catalog) {
  const m = structuredClone(prev);
  m.raw = `${prev.raw} → ${next.raw}`;
  Object.assign(m.filters, next.filters);
  m.genres = [...new Set([...m.genres, ...next.genres])].filter((g) => !next.excludeGenres.includes(g));
  m.softGenres = [...new Set([...m.softGenres, ...next.softGenres])].filter((g) => !next.excludeGenres.includes(g));
  m.excludeGenres = [...new Set([...m.excludeGenres.filter((g) => !next.genres.includes(g)), ...next.excludeGenres])];
  m.avoidGenres = [...new Set([...m.avoidGenres, ...next.avoidGenres])];
  m.moods = [...new Set([...m.moods, ...next.moods])];
  m.expansions = [...new Set([...m.expansions, ...next.expansions])];
  m.people = [...new Set([...m.people, ...next.people])];
  if (next.quality) m.quality = next.quality;
  if (next.mine) m.mine = true;
  for (const [k, v] of Object.entries(next.steer)) m.steer[k] = Math.max(-1.5, Math.min(1.5, (m.steer[k] || 0) + v));
  if (next.anchors.length) m.anchors = next.anchors;
  if (next.semantic) m.semantic = [m.semantic, next.semantic].filter(Boolean).join(' ');
  m.notes = next.notes;
  m.refine = next.refine;
  m.exclude = [...(prev.exclude || [])];

  const r = next.refine;
  const runtimes = lastResults.map((i) => catalog[i].runtime).sort((a, b) => a - b);
  const years = lastResults.map((i) => catalog[i].year).sort((a, b) => a - b);
  const median = (a) => a[Math.floor(a.length / 2)];
  if (r.shorter && runtimes.length) m.filters.maxRuntime = Math.min(m.filters.maxRuntime ?? 999, median(runtimes) - 5);
  if (r.longer && runtimes.length) { m.filters.minRuntime = median(runtimes) + 10; delete m.filters.maxRuntime; }
  if (r.newer && years.length) { m.filters.yearMin = Math.max(m.filters.yearMin ?? 0, median(years) + 1); delete m.filters.yearMax; }
  if (r.older && years.length) { m.filters.yearMax = Math.min(m.filters.yearMax ?? 9999, median(years) - 1); delete m.filters.yearMin; }
  if (r.more) m.exclude.push(...lastResults);
  if (r.likeResult != null && lastResults.length) {
    const idx = r.likeResult < 0 ? lastResults.length - 1 : Math.min(r.likeResult, lastResults.length - 1);
    m.anchors = [lastResults[idx]];
    m.semantic = next.semantic;
  }
  return m;
}
