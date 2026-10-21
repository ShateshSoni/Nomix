/* ──────────────────────────────────────────────────────────────────────────
   Soapbox — review intelligence engine
   One module, used unchanged by the browser prototype (index.html) and by
   the headless runner (cli/run.js). No dependencies, no network, no LLM:
   every number below is computed from data/reviews.csv, so two runs of the
   same CSV always produce the same pulse, the same explainer and the same
   MCP payloads.
   ────────────────────────────────────────────────────────────────────────── */

export const VERSION = '2.0.0';

/* ── 1. CSV parsing ─────────────────────────────────────────────────────── */

export function parseCSV(text) {
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.map(r => {
    const o = {};
    head.forEach((h, i) => (o[h] = r[i] ?? ''));
    o.rating = Number(o.rating) || 0;
    o.thumbs_up = Number(o.thumbs_up) || 0;
    return o;
  });
}

/* ── 2. Themes ──────────────────────────────────────────────────────────────
   Five themes, the cap the brief sets. Each one is a weighted pattern set:
   `must` is the evidence that the review is about this theme, `lift` raises
   confidence, `block` keeps a review out. Patterns cover English and the
   Hinglish/Devanagari that a third of these reviews are written in.

   Why rules and not k-means: a TF-IDF + spherical k-means pass over the same
   3,270 reviews (k=5, documented in README §6) split the corpus by *language
   and sentiment* — one all-Hinglish cluster, two "app is nice" clusters, one
   empty — not by subject, so it could not answer "what should the team fix".
   These five themes are seeded from the terms that pass actually surfaced.
   ────────────────────────────────────────────────────────────────────────── */

const THEMES = [
  {
    id: 'charges',
    label: 'Unexpected charges and unclear fee deductions',
    gist: 'Users question deductions applied to sell transactions and struggle to understand the fees charged to their accounts.',
    polarity: 'negative',
    weak: [/\bcharge\w*\b/i, /\bfees?\b/i, /\bbrokerage\b/i, /\bdeduct\w*/i, /\bचार्ज/i, /\bपैसे? (कट|काट)/i],
    must: [
      /\b(dp|depositor(y|ies)|cdsl|demat)\s*(charge|fee)/i,
      /\b(hidden|extra|unknown|unnecessary|undisclosed|surprise|silent(ly)?|secret)\b[^.!?]{0,30}\b(charge|fee|cost|deduct)/i,
      /\b(charge|fee|deduct)[^.!?]{0,30}\b(hidden|extra|unknown|without (any )?(information|notice|informing)|bina bata|chhupe?|chupe?)/i,
      /\b(brokerage|charges?|fees?)\b[^.!?]{0,40}\b(high|too much|jyada|jada|zyada|bahut|loot|rip ?off|eat|khaa|kaat|cut)\b/i,
      /\b(charge|paisa|paise|amount)\s*(kat|kaat|cut)\w*\b/i,
      /\b(20|25|30|40)\s*(rs|rupee|rupay|₹)\b[^.!?]{0,25}\b(order|sell|sale|trade|charge)/i,
      /\b(square ?off|pledge|auto ?square|call ?(and|&) ?trade|amc|annual maintenance)\s*(charge|fee)/i,
      /\bgst\b[^.!?]{0,25}\b(charge|deduct|extra)/i,
      /\b(charge|fee)s?\b[^.!?]{0,30}\b(not (clear|disclosed|shown|mentioned)|nowhere|kahi nahi|pata nahi)/i,
      /\b(mtf|margin)\b[^.!?]{0,25}\binterest\b/i
    ],
    lift: [/\bhidden\b/i, /\bdp charge/i, /\bcdsl\b/i, /\bmislead/i, /\bloot\b/i, /\btrue to label/i],
    block: [/\bno (other )?hidden charges?\b/i, /\bzero hidden\b/i, /\bwithout any hidden\b/i, /\bno extra charge/i]
  },
  {
    id: 'support',
    label: 'Unresolved support requests and poor follow-up',
    gist: 'Users report unanswered queries, missed callbacks, and support cases closed without a satisfactory resolution.',
    polarity: 'negative',
    weak: [/\bsupport\b/i, /\bservice\b/i, /\bcomplain\w*/i, /\bresolv\w*/i, /\bसपोर्ट|सर्विस/i],
    must: [
      /\bcustomer\s*(care|support|service|executive)/i,
      /\b(support|care)\s*(team|is|was|bahut|very|not|never)/i,
      /\b(ticket|complaint|grievance|escalat)\w*/i,
      /\b(no|not|never|nobody|koi (nahi|nhi))\b[^.!?]{0,30}\b(respond|reply|answer|revert|call ?back|resolv|solution|samadhan)/i,
      /\b(respond|reply|revert|resolv)\w*[^.!?]{0,25}\b(slow|late|delay|never|not|days|weeks)/i,
      /\bchat ?bot\b|\bbot (reply|answer|hi)/i,
      /\bhelpline|toll ?free|customer number\b/i
    ],
    lift: [/\bticket\s*(no|number|#)?\s*\d{5,}/i, /\bworst (support|service)/i, /\bescalat/i],
    block: [/\b(support|service) (is |was )?(excellent|great|good|fast|prompt|quick|best|helpful)/i]
  },
  {
    id: 'reliability',
    label: 'Order execution and app reliability issues',
    gist: 'App crashes, login failures, and unsuccessful or delayed orders disrupt investing and reduce user confidence.',
    polarity: 'negative',
    weak: [/\bnot working\b/i, /\bband ho\b/i, /\bkaam nahi\b/i, /\bissue\b/i, /\bproblem\b/i, /\bslow\b/i, /\bupdate\b/i, /\bचल नहीं|काम नहीं/i],
    must: [
      /\bapp\b[^.!?]{0,25}\b(crash|hang|freeze|frozen|slow|lag|stuck|not (work|open|load|respond))/i,
      /\b(crash|hang|freez|lagg|glitch|bug|error|not working|band ho|chal nahi)\w*/i,
      /\b(order|trade|sell|buy|position)\w*[^.!?]{0,30}\b(fail|not (execut|place|go|complete)|reject|stuck|pending|cancel|delay)/i,
      /\b(stop ?loss|sl|target|gtt|limit order|square ?off)\b[^.!?]{0,30}\b(not|fail|never|didn'?t|nahi)/i,
      /\b(login|log in|otp|sign in|password|biometric)\b[^.!?]{0,25}\b(not|fail|issue|problem|error|nahi)/i,
      /\b(chart|candle|watchlist|price|ltp|data)\b[^.!?]{0,25}\b(wrong|freeze|stuck|not updat|delay|lag)/i,
      /\b(server|technical)\s*(issue|error|down|problem)/i,
      /\bupdate\b[^.!?]{0,30}\b(worse|worst|bad|broke|ruin|problem|issue|bekar)/i
    ],
    lift: [/\bevery ?time\b/i, /\bagain and again\b/i, /\bsince (the )?(last )?update\b/i],
    block: [/\bno (bug|crash|glitch|issue)s?\b/i, /\bworks? (perfectly|smoothly|fine)\b/i]
  },
  {
    id: 'funds',
    label: 'Withdrawal delays and balance discrepancies',
    gist: 'Users experience uncertainty around fund withdrawals, settlement timelines, and differences between expected and displayed balances.',
    polarity: 'negative',
    weak: [/\bwithdraw\w*/i, /\brefund\w*/i, /\bbalance\b/i, /\bपैसा|पैसे/i],
    must: [
      /\b(withdraw|withdrwal|withdrawl|payout|redeem|redemption)\w*/i,
      /\b(money|amount|fund|paisa|paise|balance|cash)\b[^.!?]{0,35}\b(not (credit|receiv|transfer|refund|come|aya)|stuck|block|hold|pending|missing|debit but|gaya)/i,
      /\b(refund|reversal|unsettled|settlement|t\+1|t\+2)\b/i,
      /\b(bank|upi|mandate|autopay|nach)\b[^.!?]{0,30}\b(fail|not|issue|problem|debit|deduct)/i,
      /\b(ipo)\b[^.!?]{0,30}\b(block|fund|refund|mandate|upi|not|fail)/i
    ],
    lift: [/\b\d+\s*(day|days|week)s?\b[^.!?]{0,20}\b(withdraw|credit|refund|pending)/i, /\bstill not (credit|receiv)/i],
    block: [/\bwithdraw\w*[^.!?]{0,20}\b(instant|fast|quick|same day|smooth|easy)/i]
  },
  {
    id: 'experience',
    label: 'Simple onboarding and intuitive navigation',
    gist: 'First-time investors find the app easy to understand, navigate, and use for everyday investing activities.',
    polarity: 'positive',
    weak: [
      /\b(best|good|nice|great|excellent|awesome|super|amazing|wonderful|fantastic|outstanding|brilliant|perfect|helpful|useful|convenient|trustworthy|reliable|satisfied|recommend)\b/i,
      /\b(achh?a|acha|badhiya|mast|sahi|shandar|bekhtar)\b/i,
      /\b(अच्छा|बढ़िया|शानदार|मस्त|सही)\b/i,
      /\blove (this|the|it)\b/i, /\bthank/i, /\bhappy\b/i, /\bsmooth\b/i, /\bsimple\b/i, /\beasy\b/i
    ],
    must: [
      /\b(user ?friendly|easy to (use|understand|navigate|operate|invest)|simple (to use|interface|app)|smooth (experience|interface|app)|hassle ?free|seamless)\b/i,
      /\b(beginner|new investor|first time|starter|naya|students?)\b[^.!?]{0,35}\b(easy|friendly|simple|good|best|helpful|perfect|suitable)/i,
      /\b(interface|ui|ux|design|layout)\b[^.!?]{0,25}\b(good|great|nice|clean|simple|easy|best|smooth|intuitive|achh?a)/i,
      /\b(best|good|great|excellent|awesome|nice)\b[^.!?]{0,25}\b(app|platform|application)\b[^.!?]{0,30}\b(invest|trad|beginner|mutual fund|stock|sip)/i,
      /\b(easy|asan|aasan|simple)\b[^.!?]{0,20}\b(invest|sip|mutual fund|start)/i
    ],
    lift: [/\buser ?friendly\b/i, /\beasy to use\b/i, /\bfor beginners?\b/i],
    block: [/\b(not|isn'?t|never)\b[^.!?]{0,15}\buser ?friendly\b/i]
  }
];

/* ── 3. Fee entities and the confusion markers that sit beside them ────────
   A fee is "misunderstood", not merely disliked, when a review names it and
   also carries a marker of not having expected it. Scoring both separately
   is what lets the pipeline pick one fee out of several that get complaints.
   ────────────────────────────────────────────────────────────────────────── */

const FEE_ENTITIES = [
  {
    id: 'dp_sell',
    label: 'What is deducted when you sell, beyond brokerage',
    short: 'charges deducted on a sell',
    patterns: [
      /\b(dp|depositor(y|ies)|cdsl|nsdl|demat)\s*(charge|fee)/i,
      /\bdp\s*charges?\b/i,
      /\b(cdsl|dp)\b[^.!?]{0,20}\bcharge/i,
      /\b(charge|fee|deduct|cut|kat|kaat|काट|कट)\w*[^.!?]{0,40}\b(sell|selling|sale|sold|bech|बेच)/i,
      /\b(sell|selling|sale|sold|bech|बेच)\w*[^.!?]{0,40}\b(charge|fee|deduct|cut|kat|kaat|काट|कट)/i,
      /\b(buy|buying)\s*(and|&|or|\+)\s*(sell|selling)\b[^.!?]{0,30}\b(charge|fee|deduct|cut|tax)/i,
      /\b(charge|fee|deduct|cut)\w*[^.!?]{0,30}\b(buy|buying)\s*(and|&|or|\+)\s*(sell|selling)/i,
      /\b(20|23|24|25)\s*(rs|rupee|rupay|₹|\/-)\b[^.!?]{0,30}\b(sell|order|scrip|share|stock|trade)/i,
      /\b(rs\.?|₹)\s*(20|23|24|25)\b[^.!?]{0,30}\b(sell|order|scrip|share|per|trade)/i,
      /\b(per|each|every)\s*(sell|sale)\s*(order|transaction)?\b[^.!?]{0,25}\bcharge/i,
      /\bexchange transaction charge/i
    ]
  },
  { id: 'brokerage', label: 'Brokerage, and the charges deducted beside it', short: 'brokerage', patterns: [/\bbrokerage\b/i, /\bbroking (charge|fee)/i, /\bcommission\b/i, /\bब्रोकरेज/i] },
  { id: 'gst_stat', label: 'GST and statutory levies', short: 'GST and statutory charges', patterns: [/\bgst\b/i, /\bstt\b/i, /\bstamp duty\b/i, /\bexchange transaction (charge|fee)/i, /\bsebi (turnover|charge)/i] },
  { id: 'mtf', label: 'MTF interest and pledge charges', short: 'MTF interest', patterns: [/\bmtf\b/i, /\bmargin trading\b/i, /\bpledge\b/i, /\binterest\b[^.!?]{0,25}\b(margin|mtf|fund)/i] },
  { id: 'squareoff', label: 'Auto square-off charge', short: 'auto square-off charge', patterns: [/\bauto ?square ?off\b/i, /\bsquare ?off (charge|fee)/i, /\bsquareoff\b/i] },
  { id: 'amc_fee', label: 'Account maintenance and platform fees', short: 'account and platform fees', patterns: [/\bamc\b/i, /\bannual maintenance\b/i, /\bmaintenance charge/i, /\bprime\b[^.!?]{0,20}\b(fee|charge|subscription|paid)/i, /\bsubscription\b/i, /\bter\b/i] }
];

const CONFUSION_MARKERS = [
  /\bhidden\b/i, /\bextra\b/i, /\bunknown\b/i, /\bunnecessar/i, /\bundisclosed\b/i, /\bnot (disclosed|clear|mentioned|shown|informed|told)\b/i,
  /\bwithout (any )?(information|informing|notice|telling|intimation)\b/i, /\bsurprise/i, /\bsilent(ly)?\b/i, /\bsecret/i,
  /\bwhy (are|is|do|did|they|so)\b/i, /\bdon'?t know\b/i, /\bno idea\b/i, /\bwhat (is|are) (this|these|the) charge/i,
  /\bmislead/i, /\bcheat/i, /\bfraud/i, /\bloot\b/i, /\bnowhere\b/i,
  /\bpata nahi\b/i, /\bpata nhi\b/i, /\bbina bata/i, /\bchhupe?\b/i, /\bchupa\w*\b/i, /\bkyu+\b/i, /\bkyo+n?\b/i, /\bkaise\b/i,
  /\bbata(ya)? nahi\b/i, /\bbata(ya)? nhi\b/i, /\bnahi bata/i, /\bnhi bata/i, /\bkahi (nahi|nhi)\b/i
];

/* ── 4. Helpers ─────────────────────────────────────────────────────────── */

const any = (pats, s) => pats.some(p => p.test(s));
const countAny = (pats, s) => pats.reduce((n, p) => n + (p.test(s) ? 1 : 0), 0);
const WORDS = s => s.trim().split(/\s+/).filter(Boolean).length;

const STOP = new Set(('a an the and or but if is are was were be been being am i me my we our you your he she it they them this that these those to of in on for ' +
  'with at by from as not no so very too much many more most all any some do does did done have has had will would can could should its it s dont cant just only ' +
  'also than then there here what which who when where why how about into over after before again once up down out off while because until against between during ' +
  'get got give go going use used using one two three really even still back such own same other new old good bad best worst please thanks thank app groww like ' +
  'am pm rs inr hai ho hi ka ki ke ko se me mein kar karo kiya raha rha he bhi nhi nahi aur par pe to jo wo woh ye yeh is isme usme aap apne mera meri mujhe ' +
  'bahut bohot kya koi sab sabhi liye wala wali hota hoti hona kuch abhi phir fir').split(/\s+/));

const TOKENS = new WeakMap();
/** Tokenised once per review object, then reused by every theme. */
function tokensOf(r) {
  let t = TOKENS.get(r);
  if (!t) {
    t = new Set(r.text.toLowerCase().replace(/[^a-zऀ-ॿ\s]/g, ' ').split(/\s+/)
      .map(w => w.replace(/(ing|ed|es|s)$/, '')).filter(w => w.length > 2 && !STOP.has(w)));
    TOKENS.set(r, t);
  }
  return t;
}

/** Terms that are distinctive to a set of reviews, by log-odds against the rest. */
function distinctiveTerms(members, all, n = 6) {
  const inSet = new Map(), outSet = new Map();
  const ids = new Set(members.map(r => r.review_id));
  let inTot = 0, outTot = 0;
  for (const r of all) {
    const mine = ids.has(r.review_id);
    const target = mine ? inSet : outSet;
    for (const w of tokensOf(r)) {
      target.set(w, (target.get(w) || 0) + 1);
      if (mine) inTot++; else outTot++;
    }
  }
  const out = [];
  for (const [w, c] of inSet) {
    if (c < Math.max(4, members.length * 0.02)) continue;
    const o = outSet.get(w) || 0;
    const score = Math.log(((c + 0.5) / (inTot + 1)) / ((o + 0.5) / (outTot + 1)));
    out.push({ term: w, inCount: c, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

/** A quote a PM can paste into a deck: long enough to carry the point, short enough to read.
    `focus` says what the quote is for: a fee entity (score the confusion it
    voices and the figures it cites) or a theme (score how squarely it hits
    that theme's own patterns), so a reliability quote is never chosen for
    containing the word "hidden". */
function pickQuotes(members, focus, count = 3) {
  const scored = members.map(r => {
    const len = r.text.length;
    let s = 0;
    if (focus?.kind === 'fee') {
      s += countAny(CONFUSION_MARKERS, r.text) * 3;
      if (any(focus.patterns, r.text)) s += 6;
      if (/(₹|\brs\.?|\binr)\s*\d|\d[\d,]*\s*(rs|rupees?|inr|₹)/i.test(r.text)) s += 5;   // a figure makes the point concrete
    } else if (focus?.kind === 'theme') {
      s += Math.min(countAny(focus.must, r.text), 3) * 3 + countAny(focus.lift, r.text) * 2;
      if (/\b(lost|loss|money|order|placed|sell|buy)\b/i.test(r.text)) s += 2;           // consequence, not just annoyance
    }
    if (len >= 90 && len <= 320) s += 4; else if (len > 320) s += 2; else s -= 3;
    if (r.rating <= 2) s += 2;
    s += Math.min(r.thumbs_up, 10) * 0.4;                                             // other users agreed
    if (/[ऀ-ॿ]/.test(r.text)) s -= 1.5;            // prefer quotes a global reader can read
    if (/\b(fuck|f u |bloody|bastard|ghatiya|chutiya|bc\b|mc\b)/i.test(r.text)) s -= 8;
    if (/^[^a-z]*$/i.test(r.text)) s -= 5;
    return { r, s };
  }).sort((a, b) => b.s - a.s);

  const week = iso => { const d = new Date(iso + 'T00:00:00Z'); return Math.floor(+d / (7 * 864e5)); };
  const out = [], usedWeeks = new Set();
  for (const { r } of scored) {
    if (out.length >= count) break;
    if (usedWeeks.has(week(r.date))) continue;                // spread across the window
    usedWeeks.add(week(r.date));
    const pats = focus?.kind === 'fee' ? [...focus.patterns, ...CONFUSION_MARKERS] : focus?.kind === 'theme' ? [...focus.must, ...focus.lift] : [];
    out.push({
      review_id: r.review_id, date: r.date, rating: r.rating,
      text: r.text.length > 300 ? r.text.slice(0, 297).replace(/\s+\S*$/, '') + '…' : r.text,
      keyAt: keyWord(r.text, pats)
    });
  }
  return out;
}

/** Index of the word where the first focus pattern matches, so an excerpt can
    start at the clause that makes the point rather than at "hello, I have". */
function keyWord(text, patterns) {
  let at = Infinity;
  for (const p of patterns) { const m = p.exec(text); if (m && m.index < at) at = m.index; }
  if (at === Infinity) return 0;
  return text.slice(0, at).trim().split(/\s+/).filter(Boolean).length;
}

/** Verbatim excerpt of at most `cap` words that contains the key word: starts
    at the earliest clause boundary from which the key word still fits, ends at
    a sentence end when one falls near the budget, and marks any cut with …. */
function excerpt(text, cap, keyAt = 0) {
  const words = text.replace(/…$/, '').trim().split(/\s+/);
  const cut = /…$/.test(text);
  if (words.length <= cap) return cut ? text : words.join(' ');
  const mi = Math.min(keyAt, words.length - 1);
  const boundary = i => i === 0 || /[.!?,;:]$/.test(words[i - 1]);
  let start = Math.max(0, mi - 4);
  for (let i = Math.max(0, mi - (cap - 5)); i <= mi; i++) if (boundary(i)) { start = i; break; }
  let end = Math.min(words.length, start + cap);
  for (let i = end - 1; i >= Math.max(start + 1, end - 6); i--) if (/[.!?]$/.test(words[i])) { end = i + 1; break; }
  let out = words.slice(start, end).join(' ');
  const endsSentence = /[.!?]$/.test(out);
  if ((end < words.length || cut) && !endsSentence) out = out.replace(/[,;:—-]+$/, '') + '…';
  if (start > 0) out = '…' + out;
  return out;
}

const fmtDate = iso => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y}`;
};
const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : 0;

/* ── 5. The pipeline ───────────────────────────────────────────────────── */

export function runPipeline(rows, opts = {}) {
  const trace = [];
  const step = (stage, detail) => trace.push({ stage, detail });

  /* 5.1 window */
  const windowWeeks = opts.windowWeeks ?? 12;
  const dates = rows.map(r => r.date).sort();
  const asOf = opts.asOf || dates[dates.length - 1];
  const from = new Date(new Date(asOf + 'T00:00:00Z') - (windowWeeks * 7 - 1) * 864e5).toISOString().slice(0, 10);
  const windowed = rows.filter(r => r.date >= from && r.date <= asOf);
  step('Window', `${windowed.length} reviews between ${fmtDate(from)} and ${fmtDate(asOf)} (${windowWeeks} weeks)`);

  /* 5.2 substantive text only — a bare "nice app" carries no theme */
  const corpus = windowed.filter(r => r.text.trim().length >= 25);
  step('Qualify', `${corpus.length} reviews carry 25+ characters of text and enter clustering; ${windowed.length - corpus.length} set aside`);

  /* 5.3 assign each review to its strongest theme */
  const buckets = new Map(THEMES.map(t => [t.id, []]));
  let unassigned = 0;
  for (const r of corpus) {
    let best = null, bestScore = 0;
    for (const t of THEMES) {
      if (any(t.block, r.text)) continue;
      const hits = countAny(t.must, r.text);
      const weak = countAny(t.weak || [], r.text);
      if (!hits && !weak) continue;
      const score = hits * 2 + countAny(t.lift, r.text) + weak * (hits ? 0.5 : 1);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    if (best) buckets.get(best.id).push(r); else unassigned++;
  }
  step('Cluster', `${corpus.length - unassigned} reviews matched one of 5 themes, ${unassigned} matched none and are left out rather than forced`);

  const themes = THEMES.map(t => {
    const m = buckets.get(t.id);
    const avg = m.length ? m.reduce((a, r) => a + r.rating, 0) / m.length : 0;
    const low = m.filter(r => r.rating <= 2).length;
    return {
      id: t.id, label: t.label, gist: t.gist, polarity: t.polarity,
      count: m.length, share: pct(m.length, corpus.length),
      avgRating: Math.round(avg * 100) / 100,
      lowStarShare: pct(low, m.length),
      terms: distinctiveTerms(m, corpus).map(x => x.term),
      members: m
    };
  }).sort((a, b) => b.count - a.count);

  const topThemes = themes.slice(0, 3);
  step('Rank', `Top three by volume: ${topThemes.map(t => `${t.label} (${t.count})`).join('; ')}`);

  /* 5.4 which fee is misunderstood, not merely disliked */
  const feeScores = FEE_ENTITIES.map(f => {
    const named = corpus.filter(r => any(f.patterns, r.text));
    const confused = named.filter(r => any(CONFUSION_MARKERS, r.text));
    const avg = named.length ? named.reduce((a, r) => a + r.rating, 0) / named.length : 0;
    const rate = pct(confused.length, named.length);
    return {
      id: f.id, label: f.label, short: f.short, entity: f,
      mentions: named.length,
      confused: confused.length,
      confusionRate: rate,
      // Volume alone would always pick the best-known charge; density alone would
      // pick a charge two people mentioned. The product of the two picks the fee
      // that is both frequently raised and frequently not understood.
      confusionScore: Math.round(confused.length * (rate / 100) * 100) / 100,
      avgRating: Math.round(avg * 100) / 100,
      members: confused
    };
  }).sort((a, b) => b.confusionScore - a.confusionScore || b.confused - a.confused);

  const feeSignal = feeScores[0];
  feeSignal.weeklyRun = weeklyCounts(feeSignal.members, from, asOf);
  step('Detect', `Scored each fee on reviews that name it and also signal not expecting it (confused x rate): ${feeScores.slice(0, 4).map(f => `${f.short} ${f.confusionScore}`).join(', ')} — picked ${feeSignal.short}`);

  /* 5.5 quotes: two must carry the fee confusion, one speaks for the leading
         negative theme, so the three together support the note they sit in */
  const leadNeg = themes.find(t => t.polarity === 'negative');
  const feePool = [...new Set([...feeSignal.members, ...themes.find(t => t.id === 'charges').members])];
  const feeQuotes = pickQuotes(feePool, { kind: 'fee', patterns: feeSignal.entity.patterns }, 2);
  const taken = new Set(feeQuotes.map(q => q.review_id));
  const leadDef = THEMES.find(t => t.id === leadNeg.id);
  const themeQuote = pickQuotes(leadNeg.members.filter(r => !taken.has(r.review_id)), { kind: 'theme', must: leadDef.must, lift: leadDef.lift }, 1);
  const quotes = [...feeQuotes, ...themeQuote];
  step('Quote', `3 verbatim quotes: 2 from the ${feePool.length} charge-related reviews, 1 from ${leadNeg.label}; one per week, profanity and all-caps reviews excluded`);

  /* 5.6 the two outputs */
  const pulse = buildPulse({ themes, topThemes, quotes, feeSignal, corpus, windowed, from, asOf, opts });
  step('Pulse', `${pulse.words} words (limit 250)`);

  const explainer = buildExplainer({ feeSignal, asOf: opts.lastChecked || opts.today || asOf });
  step('Explainer', `${explainer.bullets.length} bullets (limit 6), ${explainer.sources.length} official links`);

  return {
    version: VERSION,
    meta: {
      product: 'Groww (Android, Google Play)',
      source: 'Google Play public reviews, in/en',
      from, asOf, windowWeeks,
      reviewsInWindow: windowed.length,
      totalInWindow: opts.totalInWindow || windowed.length,
      corpusSize: corpus.length,
      unassigned,
      ratingMix: [1, 2, 3, 4, 5].map(s => ({ stars: s, count: windowed.filter(r => r.rating === s).length }))
    },
    themes, topThemes, quotes, feeSignal, feeScores, pulse, explainer, trace
  };
}

function weeklyCounts(members, from, asOf) {
  const weeks = [];
  let start = new Date(asOf + 'T00:00:00Z');
  start = new Date(start - 6 * 864e5);
  for (let i = 0; i < 6; i++) {
    const s = new Date(start - i * 7 * 864e5), e = new Date(+s + 6 * 864e5);
    const si = s.toISOString().slice(0, 10), ei = e.toISOString().slice(0, 10);
    if (ei < from) break;
    weeks.unshift({ from: si, to: ei, count: members.filter(r => r.date >= si && r.date <= ei).length });
  }
  return weeks;
}

/* ── 6. Weekly product pulse (≤250 words) ──────────────────────────────── */

function buildPulse({ themes, topThemes, quotes, feeSignal, corpus, windowed, from, asOf, opts = {}, override = null }) {
  const neg = topThemes.filter(t => t.polarity === 'negative');
  const lead = neg[0] || topThemes[0];
  const run = feeSignal.weeklyRun;
  const trend = run.length >= 2
    ? (run.at(-1).count > run[0].count ? 'rising' : run.at(-1).count < run[0].count ? 'easing' : 'flat')
    : 'flat';

  const actions = override?.actions || [
    'Itemise brokerage, DP charge, CDSL and GST on the order confirmation, not only the next-day contract note.',
    'Show the rupee cost live as quantity is entered, including the ₹0 case under ₹100 of debit value.',
    'Ship the explainer below as the canned support reply and track repeat contacts about charges.'
  ];

  const themeLines = topThemes.map((t, i) =>
    `${i + 1}. **${t.label}**: ${t.count.toLocaleString('en-IN')} reviews (${t.share}%), ${t.avgRating.toFixed(2)}★.`
  ).join('\n');

  const chargeTheme = themes.find(t => t.id === 'charges');
  const chargeRank = themes.indexOf(chargeTheme) + 1;
  const observation = override?.observation ? `**Key observation.** ${override.observation}` : `**Key observation.** ${lead.label} is the largest negative theme (${lead.count} reviews, ${lead.avgRating.toFixed(2)}★). The most fixable one is charges (#${chargeRank}, ${chargeTheme.count} reviews): ${feeSignal.confused} of ${feeSignal.mentions} reviews naming ${feeSignal.short} did not expect the deduction ("hidden", "extra", "bina bataye"). Every charge is published; this is placement, not pricing. Mentions ${trend} week on week.`;

  /* The brief caps this note at 250 words. Quotes carry the most compressible
     text, so they are trimmed in fixed steps until the note fits — same input,
     same output, and the full verbatim stays in the doc entry. */
  const render = cap => {
    const quoteLines = quotes.map(q => `> "${excerpt(q.text, cap, q.keyAt)}" — ${q.rating}★, ${fmtDate(q.date)}`).join('\n\n');

    return `# Weekly product pulse — ${fmtDate(asOf)}

**Scope.** ${(opts.totalInWindow || windowed.length).toLocaleString('en-IN')} Google Play reviews, ${fmtDate(from)} to ${fmtDate(asOf)}; ${corpus.length.toLocaleString('en-IN')} with text analysed.

**Top themes**

${themeLines}

**What users said**

${quoteLines}

${observation}

**Three things to do**

1. ${actions[0]}
2. ${actions[1]}
3. ${actions[2]}
`;
  };

  const count = s => WORDS(s.replace(/[#*>]/g, ' '));
  let body = '', words = 0;
  for (const cap of [28, 26, 24, 22, 20, 18, 16, 14, 12, 10]) {
    body = render(cap); words = count(body);
    if (words <= 250) break;
  }
  return { markdown: body, words, trend, actions, limit: 250, withinLimit: words <= 250 };
}

/** The same note, with the observation, the actions and the quotes supplied
    by someone else (the AI writer). Numbers, themes and layout stay computed. */
export function composePulse(result, override) {
  return buildPulse({
    themes: result.themes, topThemes: result.topThemes, quotes: override.quotes || result.quotes,
    feeSignal: result.feeSignal, corpus: { length: result.meta.corpusSize }, windowed: { length: result.meta.reviewsInWindow },
    from: result.meta.from, asOf: result.meta.asOf, opts: { totalInWindow: result.meta.totalInWindow }, override
  });
}

/** Retrieval for the AI writer: the most telling reviews per theme and for the
    fee, scored and spread across weeks by the same picker that chooses quotes. */
export function retrieveEvidence(result, { perTheme = 5, otherThemes = 3, fee = 10 } = {}) {
  const themes = result.themes.map((t, i) => {
    const def = THEMES.find(d => d.id === t.id);
    return { id: t.id, examples: pickQuotes(t.members, { kind: 'theme', must: def.must, lift: def.lift }, i < 3 ? perTheme : otherThemes) };
  });
  const pool = [...new Set([...result.feeSignal.members, ...result.themes.find(t => t.id === 'charges').members])];
  return { themes, fee: pickQuotes(pool, { kind: 'fee', patterns: result.feeSignal.entity.patterns }, fee) };
}

/** A quote object for a review the AI writer picked, with the key word found
    the same way the engine finds it, so the excerpt opens on the point. */
export function quoteFor(row, result) {
  const pats = [...result.feeSignal.entity.patterns, ...CONFUSION_MARKERS, ...THEMES.flatMap(t => t.must)];
  return {
    review_id: row.review_id, date: row.date, rating: row.rating,
    text: row.text.length > 300 ? row.text.slice(0, 297).replace(/\s+\S*$/, '') + '…' : row.text,
    keyAt: keyWord(row.text, pats)
  };
}

export { fmtDate };

/* ── 7. Fee explainer (≤6 bullets, facts only, 2 official links) ───────── */

const FEE_COPY = {
  brokerage: {
    title: 'What is deducted on a trade, and why brokerage is only part of it',
    bullets: [
      'Brokerage on an equity order is ₹20 or 0.1% of the order value, whichever is lower, subject to a minimum of ₹5. It is charged per executed order, so a buy and a later sell are two separate charges.',
      'A delivery sell also attracts a DP (depository participant) charge, because shares leave your demat account: ₹16.50 charged by Groww and ₹3.50 charged by the depository, CDSL. The depository part is ₹3.25 where the first holder is a woman. Buying and intraday trading do not attract it.',
      'The DP charge is a flat amount per sell transaction, not a percentage, so a ₹500 sell and a ₹5,00,000 sell attract the same amount. Where the debit value is under ₹100, Groww\'s ₹16.50 is not applied.',
      'GST of 18% applies on brokerage, DP charges and exchange transaction charges. It is a tax, collected on top of those charges rather than retained as a fee.',
      'STT, stamp duty, exchange transaction charges and SEBI turnover fees are levied by the government, the exchange or the regulator. They appear on the same contract note but are not Groww\'s charges.',
      'Every one of these lines is itemised on the contract note and in the ledger for the trade date, and the rates are published on Groww\'s pricing page.'
    ],
    // Every rate the bullets assert, so eval/run_eval.js can check each one
    // against sources.csv. Illustrative amounts (₹500, ₹5,00,000) are not rates.
    figures: ['₹20', '0.1%', '₹5', '₹16.50', '₹3.50', '₹3.25', '₹100', '18%'],
    sources: [
      { label: 'Groww — Charges and pricing', url: 'https://groww.in/pricing' },
      { label: 'Groww Help — When are DP charges levied', url: 'https://groww.in/help/stocks/searchable/when-are-dp-charges-levied' }
    ]
  },
  dp_sell: {
    title: 'Why a flat charge appears when you sell shares',
    bullets: [
      'The charge is a DP (depository participant) charge. It applies when shares leave your demat account, which happens on a delivery sell. Buying shares does not attract it, and intraday trades do not attract it.',
      'It has two parts on every sell transaction: ₹16.50 charged by Groww and ₹3.50 charged by the depository, CDSL. The depository part is ₹3.25 where the first holder is a woman. GST of 18% applies on both parts.',
      'It is a flat amount per sell transaction, not a percentage. Selling shares worth ₹500 and shares worth ₹5,00,000 attract the same charge. Where the debit value is under ₹100, Groww\'s ₹16.50 is not applied.',
      'It is separate from brokerage. Brokerage on an equity order is ₹20 or 0.1% of order value, whichever is lower, subject to a ₹5 minimum. Brokerage and DP charges are listed as separate lines.',
      'It applies whether the sell was at a profit or a loss, because it pays for the transfer of shares out of the demat account rather than being a charge on gains.',
      'Both amounts are published on Groww\'s pricing page and the depository\'s tariff, and appear on your contract note and ledger for the day of the sell.'
    ],
    sources: [
      { label: 'Groww — Charges and pricing', url: 'https://groww.in/pricing' },
      { label: 'Groww Help — When are DP charges levied', url: 'https://groww.in/help/stocks/searchable/when-are-dp-charges-levied' }
    ]
  }
};

function buildExplainer({ feeSignal, asOf }) {
  const copy = FEE_COPY[feeSignal.id] || {
    title: `About ${feeSignal.short}`,
    bullets: [`${feeSignal.label} is published on Groww's pricing page.`],
    sources: [{ label: 'Groww — Charges and pricing', url: 'https://groww.in/pricing' }]
  };
  return {
    feeId: feeSignal.id,
    title: copy.title,
    bullets: copy.bullets.slice(0, 6),
    figures: copy.figures || [],
    sources: copy.sources,
    lastChecked: asOf,
    lastCheckedLabel: fmtDate(asOf),
    tone: 'facts only, no recommendation',
    withinLimit: copy.bullets.length <= 6,
    markdown: `## ${copy.title}\n\n${copy.bullets.slice(0, 6).map(b => `- ${b}`).join('\n')}\n\n**Sources**\n\n${copy.sources.map(s => `- [${s.label}](${s.url})`).join('\n')}\n\nLast checked: ${fmtDate(asOf)}\n`
  };
}

/* ── 8. The two MCP payloads ───────────────────────────────────────────── */

export function buildDocEntry(result) {
  return {
    date: result.meta.asOf,
    top_themes: result.topThemes.map(t => ({ theme: t.label, reviews: t.count, share_pct: t.share, avg_rating: t.avgRating })),
    weekly_pulse: result.pulse.markdown,
    identified_fee_issue: {
      fee: result.feeSignal.label,
      reviews_naming_it: result.feeSignal.mentions,
      reviews_signalling_confusion: result.feeSignal.confused,
      confusion_rate_pct: result.feeSignal.confusionRate,
      trend: result.pulse.trend
    },
    explanation_bullets: result.explainer.bullets,
    source_links: result.explainer.sources.map(s => s.url)
  };
}

export function buildEmailDraft(result) {
  const d = fmtDate(result.meta.asOf);
  const subject = `Weekly Product Pulse + Customer Clarification — ${d}`;
  const body = [
    `Team,`,
    ``,
    `This week's pulse from ${result.meta.totalInWindow.toLocaleString('en-IN')} Google Play reviews (${fmtDate(result.meta.from)} to ${d}), of which ${result.meta.corpusSize.toLocaleString('en-IN')} carried text, and a support snippet for the fee that keeps coming up.`,
    ``,
    `— — — WEEKLY PRODUCT PULSE — — —`,
    ``,
    result.pulse.markdown.replace(/^# .*\n+/, '').replace(/\*\*/g, '').replace(/^> /gm, '    '),
    `— — — SUPPORT SNIPPET: ${result.explainer.title.toUpperCase()} — — —`,
    ``,
    `Paste this as-is when a user asks why a charge appeared on a sell.`,
    ``,
    ...result.explainer.bullets.map(b => `• ${b}`),
    ``,
    `Sources:`,
    ...result.explainer.sources.map(s => `- ${s.label}: ${s.url}`),
    ``,
    `Last checked: ${result.explainer.lastCheckedLabel}`,
    ``,
    `This is a factual explanation of a charge. It is not investment advice.`
  ].join('\n');
  return { to: ['product-team@example.com'], cc: ['support-leads@example.com'], subject, body, send: false };
}
