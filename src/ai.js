/* ──────────────────────────────────────────────────────────────────────────
   Soapbox — the AI writer.

   The engine finds the themes, the numbers and the fee. This module hands a
   language model a small, labelled context pack (the computed stats, the
   reviews retrieved as evidence for each theme and for the fee, and the
   official source facts), asks it to write the parts a person would write
   (the key observation, three actions, which three reviews to quote, and the
   fee explainer), and then checks every claim it makes against that pack.

   A draft that fails a check is sent back once with the failures listed. If
   it fails again, the rule-based output stays. Nothing the model writes
   reaches the approval gate without passing the same checks.

   No platform imports: the browser and cli/run.js both use this file. The
   caller supplies `transport(system, user) → text`, so tests can stand in a
   fake model and the key never touches this module.
   ────────────────────────────────────────────────────────────────────────── */

import { composePulse, retrieveEvidence, quoteFor, fmtDate } from './engine.js';

export const PROVIDERS = {
  gemini: { label: 'Google Gemini', model: 'gemini-2.5-flash', keyHint: 'Free key from aistudio.google.com' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini', keyHint: 'Key from platform.openai.com' },
  anthropic: { label: 'Anthropic', model: 'claude-haiku-4-5', keyHint: 'Key from console.anthropic.com' }
};

const OFFICIAL = /^https:\/\/(www\.)?(groww\.in|cdslindia\.com|sebi\.gov\.in|investor\.sebi\.gov\.in|nseindia\.com|bseindia\.com)\//;
const ADVICE = /\b(you should|we recommend|recommended|best|avoid|better off|switch to|don'?t worry|invest in|good time to)\b/i;
const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;
const clip = (s, n) => { const w = String(s).split(/\s+/); return w.length > n ? w.slice(0, n).join(' ') + '…' : String(s); };

/* ── sources.csv → the facts the explainer may use ───────────────────── */

export function parseSources(csvText) {
  if (!csvText) return [];
  const rows = [];
  const lines = csvText.replace(/\r/g, '').split('\n').filter(Boolean);
  const head = splitRow(lines[0]);
  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    const o = Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
    rows.push({ id: o.id, publisher: o.publisher, title: o.title, url: o.url, facts: o.used_for, verified_on: o.verified_on });
  }
  return rows;
}
function splitRow(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}

/* ── 1. the context pack ─────────────────────────────────────────────── */

/**
 * What the model reads. Budgeted (reviews clipped to 60 words, a fixed number
 * per theme), labelled (every review and source has an id the model must cite),
 * and stripped of anything personal (no names; ids are hashes already).
 */
export function buildContext(result, sourcesText, { lastChecked } = {}) {
  const ev = retrieveEvidence(result);
  const sources = parseSources(sourcesText);
  const index = new Map();
  const pack = r => { index.set(r.review_id, r); return { id: r.review_id, date: r.date, stars: r.rating, text: clip(r.text, 60) }; };

  const ctx = {
    product: 'Groww, Android app, Google Play reviews',
    window: { from: result.meta.from, to: result.meta.asOf, reviews_total: result.meta.totalInWindow, reviews_with_text: result.meta.corpusSize },
    themes: result.themes.map((t, i) => ({
      rank: i + 1, label: t.label, reviews: t.count, share_pct: t.share, avg_stars: t.avgRating,
      one_and_two_star_pct: t.lowStarShare, distinctive_words: t.terms,
      evidence: ev.themes.find(e => e.id === t.id).examples.map(pack)
    })),
    fee_issue: {
      label: result.feeSignal.label,
      reviews_naming_it: result.feeSignal.mentions,
      reviews_not_expecting_it: result.feeSignal.confused,
      confusion_rate_pct: result.feeSignal.confusionRate,
      trend_week_on_week: result.pulse.trend,
      other_charges_scored: result.feeScores.slice(1, 4).map(f => ({ label: f.label, named: f.mentions, confused: f.confused })),
      evidence: ev.fee.map(pack)
    },
    official_sources: sources.map(s => ({ id: s.id, publisher: s.publisher, title: s.title, url: s.url, facts: s.facts })),
    last_checked: lastChecked || result.meta.asOf
  };
  const feeIds = new Set(ctx.fee_issue.evidence.map(e => e.id));
  return { ctx, index, sources, feeIds, json: JSON.stringify(ctx, null, 1) };
}

/* ── 2. the prompt ───────────────────────────────────────────────────── */

export const SYSTEM = `You write two short internal documents for a product team at an Indian stockbroking app, using only the context you are given.

Rules you must follow:
- Use only facts, numbers and reviews that appear in the context. Never invent a number, a review or a source.
- Quote reviews by id only. Choose 3 different review ids from the evidence lists. At least one must come from fee_issue.evidence, and at least one must come from a theme's evidence that is about a problem, not praise.
- The key observation is at most 60 words. It says what is going wrong and what is trending, and it names the fee issue. Any number in it must appear in the context exactly.
- Write exactly 3 action ideas for the product team, each one sentence of at most 25 words, each something a team could ship or change.
- The fee explainer is for a support agent to paste to a user who is confused about the fee issue. Write 4 to 6 bullets, each at most 55 words, plain and neutral, facts only. No advice, no reassurance, no words like "should", "best", "avoid", "recommend".
- Every rupee amount and every percentage in the explainer must appear in the facts of the official_sources you cite. Do not use example amounts.
- Cite exactly 2 official source ids for the explainer, the two that best support the bullets.
- Write in clear English.

Reply with one JSON object and nothing else:
{"observation": string, "actions": [string, string, string], "quote_ids": [string, string, string], "explainer": {"title": string, "bullets": [string], "source_ids": [string, string]}}`;

export function userPrompt(contextJson, feedback) {
  let p = `Context:\n${contextJson}\n\nWrite this week's key observation, three actions, quote choices and the fee explainer as the JSON object described.`;
  if (feedback) p += `\n\nYour previous draft failed these checks. Fix every one and reply with the full JSON again:\n${feedback.map(f => `- ${f}`).join('\n')}`;
  return p;
}

/* ── 3. calling a model (fetch is passed in; the key stays with the caller) */

export function makeTransport({ provider, model, key, fetchImpl = globalThis.fetch }) {
  const m = model || PROVIDERS[provider]?.model;
  const ok = async res => {
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); msg += ' ' + (j.error?.message || j.message || JSON.stringify(j).slice(0, 200)); } catch { /* body not JSON */ }
      throw new Error(`The model service refused the request (${msg})`);
    }
    return res.json();
  };
  if (provider === 'gemini') return async (system, user) => {
    const j = await ok(await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
    }));
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  };
  if (provider === 'openai') return async (system, user) => {
    const j = await ok(await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: m, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    }));
    return j.choices?.[0]?.message?.content || '';
  };
  if (provider === 'anthropic') return async (system, user) => {
    const j = await ok(await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: m, max_tokens: 2000, temperature: 0.2, system, messages: [{ role: 'user', content: user }] })
    }));
    return (j.content || []).map(c => c.text || '').join('');
  };
  throw new Error(`Unknown provider "${provider}"`);
}

/* ── 4. reading and checking a draft ─────────────────────────────────── */

export function parseDraft(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('The reply was not a JSON object');
  return JSON.parse(t.slice(a, b + 1));
}

const money = s => [...String(s).matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)].map(m => '₹' + Number(m[1].replace(/,/g, '')));
const percents = s => [...String(s).matchAll(/(\d+(?:\.\d+)?)\s?%/g)].map(m => Number(m[1]) + '%');
const numbers = s => [...String(s).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, '')));

/** Every check returns a plain sentence, so a failure can go straight back to the model. */
export function checkDraft(d, c) {
  const checks = [];
  const add = (ok, pass, failMsg) => checks.push({ ok: !!ok, label: ok ? pass : failMsg });

  const shapeOk = d && typeof d.observation === 'string' && Array.isArray(d.actions) && Array.isArray(d.quote_ids) && d.explainer && Array.isArray(d.explainer.bullets) && Array.isArray(d.explainer.source_ids);
  add(shapeOk, 'reply has every field', 'the reply is missing observation, actions, quote_ids or explainer fields');
  if (!shapeOk) return { ok: false, checks };

  /* the observation */
  add(words(d.observation) <= 60, `observation is ${words(d.observation)} words, limit 60`, `the observation is ${words(d.observation)} words; the limit is 60`);
  const allowed = new Set(numbers(c.json));
  const strayObs = numbers(d.observation).filter(n => n > 12 && !allowed.has(n));
  add(!strayObs.length, 'every number in the observation is in the data', `the observation uses numbers not in the context: ${strayObs.join(', ')}`);
  const feeWords = /charge|fee|brokerage|deduct|dp\b|cost/i;
  add(feeWords.test(d.observation), 'observation names the fee issue', 'the observation does not mention the fee issue');

  /* the actions */
  add(d.actions.length === 3, '3 action ideas', `there are ${d.actions.length} action ideas; there must be exactly 3`);
  const longAct = d.actions.filter(a => words(a) > 25 || !String(a).trim());
  add(!longAct.length, 'each action is one short sentence', `${longAct.length} action idea(s) are empty or over 25 words`);

  /* the quotes */
  const ids = d.quote_ids.map(String);
  const unknown = ids.filter(id => !c.index.has(id));
  add(ids.length === 3 && new Set(ids).size === 3, '3 different reviews quoted', 'quote_ids must hold 3 different review ids');
  add(!unknown.length, 'every quoted review is real and in the evidence', `these quote ids are not in the evidence: ${unknown.join(', ')}`);
  add(ids.some(id => c.feeIds.has(id)), 'at least one quote is about the fee', 'none of the quotes comes from fee_issue.evidence');

  /* the explainer */
  const e = d.explainer;
  add(e.bullets.length >= 4 && e.bullets.length <= 6, `${e.bullets.length} bullets, limit 6`, `the explainer has ${e.bullets.length} bullets; it needs 4 to 6`);
  const longB = e.bullets.filter(b => words(b) > 55);
  add(!longB.length, 'each bullet is 55 words or fewer', `${longB.length} bullet(s) are over 55 words`);
  add(!ADVICE.test(e.bullets.join(' ') + ' ' + (e.title || '')), 'neutral tone, no recommendation words', 'the explainer uses advice or reassurance words (should, best, avoid, recommend…)');
  const srcIds = e.source_ids.map(String);
  const cited = srcIds.map(id => c.sources.find(s => s.id === id)).filter(Boolean);
  add(srcIds.length === 2 && cited.length === 2 && new Set(srcIds).size === 2, '2 sources cited', `source_ids must be 2 different ids from official_sources; got ${srcIds.join(', ') || 'none'}`);
  add(cited.every(s => OFFICIAL.test(s.url)), 'both sources are official domains', 'a cited source is not an official domain');
  const factText = c.sources.map(s => s.facts).join(' ');
  const factFigures = new Set([...money(factText), ...percents(factText)]);
  const claimed = [...new Set(e.bullets.flatMap(b => [...money(b), ...percents(b)]))];
  const stray = claimed.filter(f => !factFigures.has(f));
  add(claimed.length > 0 && !stray.length, `${claimed.length} figures, each in the official source facts`, claimed.length ? `these figures are not in any official source fact: ${stray.join(', ')}` : 'the explainer states no figures; it must give the actual amounts from the sources');

  return { ok: checks.every(x => x.ok), checks };
}

/* ── 5. turning a passed draft into the two documents ────────────────── */

export function assemble(d, result, c) {
  const quotes = d.quote_ids.map(id => quoteFor(c.index.get(String(id)), result));
  const pulse = composePulse(result, { observation: d.observation.trim(), actions: d.actions.map(a => a.trim()), quotes });
  const sources = d.explainer.source_ids.map(id => c.sources.find(s => s.id === String(id))).map(s => ({ label: /^Help\b/.test(s.title) ? `${s.publisher} ${s.title}` : `${s.publisher} — ${s.title}`, url: s.url }));
  const title = (d.explainer.title || `About ${result.feeSignal.short}`).trim();
  const bullets = d.explainer.bullets.map(b => b.trim());
  const lastChecked = c.ctx.last_checked;
  const explainer = {
    feeId: result.feeSignal.id, title, bullets,
    figures: [...new Set(bullets.flatMap(b => [...String(b).matchAll(/₹\s?[\d,]+(?:\.\d+)?|\d+(?:\.\d+)?%/g)].map(m => m[0])))],
    sources, lastChecked, lastCheckedLabel: fmtDate(lastChecked),
    tone: 'facts only, no recommendation', withinLimit: bullets.length <= 6,
    markdown: `## ${title}\n\n${bullets.map(b => `- ${b}`).join('\n')}\n\n**Sources**\n\n${sources.map(s => `- [${s.label}](${s.url})`).join('\n')}\n\nLast checked: ${fmtDate(lastChecked)}\n`
  };
  return { ...result, quotes, pulse, explainer, writer: 'ai' };
}

/* ── 6. the loop: draft, check, one retry with the failures, else fall back */

export async function writeWithModel({ result, sourcesText, lastChecked, transport, maxAttempts = 2, onEvent = () => {} }) {
  const c = buildContext(result, sourcesText, { lastChecked });
  const attempts = [];
  let feedback = null;
  for (let n = 1; n <= maxAttempts; n++) {
    onEvent({ type: 'attempt', n });
    const user = userPrompt(c.json, feedback);
    let raw = '', draft = null, verdict;
    try {
      raw = await transport(SYSTEM, user);
      draft = parseDraft(raw);
      verdict = checkDraft(draft, c);
      if (verdict.ok) {
        const out = assemble(draft, result, c);
        const pulseOk = out.pulse.words <= 250;
        verdict.checks.push({ ok: pulseOk, label: pulseOk ? `assembled pulse is ${out.pulse.words} words, limit 250` : `the assembled pulse is ${out.pulse.words} words; shorten the observation and actions` });
        verdict.ok = pulseOk;
        if (pulseOk) {
          attempts.push({ n, raw, draft, checks: verdict.checks });
          onEvent({ type: 'checked', n, ok: true, checks: verdict.checks });
          return { status: 'accepted', output: out, attempts, context: c };
        }
      }
    } catch (err) {
      if (/refused the request|fetch|network/i.test(err.message) && !draft) { attempts.push({ n, raw, error: err.message }); onEvent({ type: 'error', n, message: err.message }); return { status: 'error', error: err.message, attempts, context: c }; }
      verdict = { ok: false, checks: [{ ok: false, label: `the reply could not be read as the JSON object asked for (${err.message})` }] };
    }
    attempts.push({ n, raw, draft, checks: verdict.checks });
    onEvent({ type: 'checked', n, ok: false, checks: verdict.checks });
    feedback = verdict.checks.filter(x => !x.ok).map(x => x.label);
  }
  return { status: 'fallback', output: result, attempts, context: c };
}

export const approxTokens = s => Math.round(String(s).length / 3.6);
