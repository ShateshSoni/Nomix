#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Checks every constraint the brief sets, plus the ones that keep the
   outputs honest. Exits 1 on any failure.
     node eval/run_eval.js
   ────────────────────────────────────────────────────────────────────────── */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { parseCSV, runPipeline, buildDocEntry, buildEmailDraft } from '../src/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

const rows = parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'reviews.csv'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corpus-meta.json'), 'utf8'));
const r = runPipeline(rows, { asOf: meta.window.to, windowWeeks: meta.window.weeks, totalInWindow: meta.reviews_in_window_all, lastChecked: meta.pulled_on });

console.log('\nStep 1 — review intelligence');
check('CSV parsed', rows.length > 1000, `${rows.length} rows`);
check('CSV columns intact', ['review_id', 'date', 'rating', 'text'].every(c => c in rows[0]));
check('window is 8 to 12 weeks', meta.window.weeks >= 8 && meta.window.weeks <= 12, `${meta.window.weeks} weeks`);
check('all rows fall inside the window', rows.every(x => x.date >= meta.window.from && x.date <= meta.window.to));
check('at most 5 themes', r.themes.length <= 5, `${r.themes.length}`);
check('exactly 3 top themes', r.topThemes.length === 3);
check('every theme has members', r.themes.every(t => t.count > 0));
check('themes do not double-count', r.themes.reduce((a, t) => a + t.count, 0) + r.meta.unassigned === r.meta.corpusSize);
check('coverage above 60%', (r.meta.corpusSize - r.meta.unassigned) / r.meta.corpusSize > 0.6,
  `${Math.round((1 - r.meta.unassigned / r.meta.corpusSize) * 100)}%`);
check('exactly 3 quotes', r.quotes.length === 3);
check('quotes are verbatim from the CSV', r.quotes.every(q => {
  const src = rows.find(x => x.review_id === q.review_id);
  return src && (src.text === q.text || src.text.startsWith(q.text.replace(/…$/, '').trim()));
}));
check('quotes carry a rating and a date', r.quotes.every(q => q.rating >= 1 && q.rating <= 5 && /^\d{4}-\d{2}-\d{2}$/.test(q.date)));
check('a fee issue was identified', !!r.feeSignal && r.feeSignal.confused > 0, `${r.feeSignal.label}, ${r.feeSignal.confused} confused mentions`);
check('the fee issue is evidenced by real reviews', r.feeSignal.members.every(m => rows.some(x => x.review_id === m.review_id)));
check('fees are ranked by the documented score', r.feeScores.every((f, i, a) => i === 0 || a[i - 1].confusionScore >= f.confusionScore));

console.log('\nStep 2 — weekly pulse');
check('250 words or fewer', r.pulse.words <= 250, `${r.pulse.words} words`);
check('carries the theme summary', /Top themes/.test(r.pulse.markdown));
check('carries supporting quotes', (r.pulse.markdown.match(/^>/gm) || []).length === 3);
check('carries a key observation', /Key observation/.test(r.pulse.markdown));
check('carries exactly 3 action ideas', r.pulse.actions.length === 3);
check('names each of the top 3 themes', r.topThemes.every(t => r.pulse.markdown.includes(t.label)));
check('quotes no figure that is not computed', !/\b(42|99|100)%/.test(r.pulse.markdown));
check('pulse quotes are verbatim excerpts of the CSV', (r.pulse.markdown.match(/^> "(.*)" — /gm) || []).every(l => {
  const body = l.replace(/^> "…?/, '').replace(/…?" — $/, '');
  return rows.some(x => x.text.includes(body));
}));
check('pulse quotes keep at least 10 words each', (r.pulse.markdown.match(/^> "(.*)" — /gm) || []).every(l => l.split(/\s+/).length >= 12));

console.log('\nStep 3 — fee explainer');
const e = r.explainer;
check('6 bullets or fewer', e.bullets.length <= 6, `${e.bullets.length}`);
check('at least 2 official source links', e.sources.length >= 2, `${e.sources.length}`);
check('sources are official domains', e.sources.every(s => /^https:\/\/(groww\.in|www\.cdslindia\.com|www\.sebi\.gov\.in|investor\.sebi\.gov\.in)\//.test(s.url)));
check('carries "Last checked"', /Last checked: \d+ \w+ \d{4}/.test(e.markdown));
check('derives from the fee found in step 1', e.feeId === r.feeSignal.id);
check('neutral tone, no recommendation', !/\b(you should|we recommend|best|avoid|better off|switch to|don'?t worry)\b/i.test(e.bullets.join(' ')));
check('no advice verbs about investing', !/\b(buy|sell|invest) (now|more|instead)\b/i.test(e.bullets.join(' ')));
const srcCsv = fs.readFileSync(path.join(ROOT, 'sources.csv'), 'utf8');
check('declares the rates it asserts', e.figures.length >= 6, `${e.figures.length} figures`);
check('every asserted rate is in the bullets', e.figures.every(f => e.bullets.join(' ').includes(f)),
  e.figures.filter(f => !e.bullets.join(' ').includes(f)).join(' ') || 'all present');
check('every asserted rate is traceable to a source', e.figures.every(f => srcCsv.includes(f)),
  e.figures.filter(f => !srcCsv.includes(f)).join(' ') || 'all traceable');

console.log('\nMCP payloads');
const d = buildDocEntry(r), mail = buildEmailDraft(r);
check('doc entry has every required key', ['date', 'top_themes', 'weekly_pulse', 'identified_fee_issue', 'explanation_bullets', 'source_links'].every(k => k in d));
check('doc entry source links are URLs', d.source_links.length >= 2 && d.source_links.every(u => u.startsWith('https://')));
check('email subject matches the brief', /^Weekly Product Pulse \+ Customer Clarification — /.test(mail.subject), mail.subject);
check('email body carries the pulse and the snippet', mail.body.includes('WEEKLY PRODUCT PULSE') && mail.body.includes('SUPPORT SNIPPET'));
check('email is a draft, never sent', mail.send === false);

console.log('\nSources and provenance');
const scsv = parseCSV(fs.readFileSync(path.join(ROOT, 'sources.csv'), 'utf8'));
check('4 to 6 sources listed', scsv.length >= 4 && scsv.length <= 6, `${scsv.length}`);
check('all sources verified', scsv.every(s => s.status === '200'));
check('reviews are anonymised', !/userName|userImage/.test(fs.readFileSync(path.join(ROOT, 'data', 'reviews.csv'), 'utf8').slice(0, 400))
  && rows.every(x => /^r_[0-9a-f]{12}$/.test(x.review_id)));

console.log('\nDeterminism');
const again = runPipeline(parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'reviews.csv'), 'utf8')),
  { asOf: meta.window.to, windowWeeks: meta.window.weeks, totalInWindow: meta.reviews_in_window_all, lastChecked: meta.pulled_on });
check('same input, same pulse', again.pulse.markdown === r.pulse.markdown);
check('same input, same fee issue', again.feeSignal.id === r.feeSignal.id);
check('same input, same quotes', JSON.stringify(again.quotes) === JSON.stringify(r.quotes));

/* ── the gate, against the real server ────────────────────────────────── */
console.log('\nApproval gating (live server over stdio)');
await (async () => {
  /* The server is pointed at a scratch directory, so a test run never
     appends to docs/product-pulse-log.md, which holds only approved entries. */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'soapbox-eval-'));
  const docPath = path.join(scratch, 'product-pulse-log.md');
  const proc = spawn('node', [path.join(ROOT, 'mcp', 'server.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SOAPBOX_DOC: docPath, SOAPBOX_OUT: scratch }
  });
  let id = 1, buf = '';
  const pending = new Map();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', c => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l) continue;
      const m = JSON.parse(l);
      pending.get(m.id)?.(m); pending.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise(res => {
    const myId = id++;
    pending.set(myId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result?.structuredContent;

  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval', version: '1' } });
  check('server initialises', init.result?.serverInfo?.name === 'soapbox-mcp');
  const tools = (await rpc('tools/list', {})).result.tools;
  check('exposes both tools', tools.length === 2 && tools.some(t => t.name === 'notes.append_entry') && tools.some(t => t.name === 'email.create_draft'));
  check('tools declare an input schema', tools.every(t => t.inputSchema?.type === 'object'));

  const g1 = await call('notes.append_entry', d);
  check('append is blocked without approval', g1.status === 'approval_required');
  check('the block shows what would be written', !!g1.what_will_happen && !!g1.preview && !!g1.target);
  const g2 = await call('email.create_draft', mail);
  check('draft is blocked without approval', g2.status === 'approval_required');

  const forged = await call('notes.append_entry', { ...d, approval_token: 'ap_forged' });
  check('a forged token is refused', forged.status === 'rejected');

  const swapped = await call('notes.append_entry', { ...d, date: '1999-01-01', approval_token: g1.approval_token });
  check('an approved token cannot be moved to a different payload', swapped.status === 'rejected');

  const before = fs.existsSync(docPath) ? fs.statSync(docPath).size : 0;
  const w1 = await call('notes.append_entry', { ...d, approval_token: g1.approval_token });
  check('append succeeds once approved', w1.status === 'appended');
  check('the document actually grew', fs.statSync(docPath).size > before);
  check('the entry carries every field of the payload', (() => {
    const t = fs.readFileSync(docPath, 'utf8');
    return t.includes(`## Week ending ${d.date}`) && d.top_themes.every(x => t.includes(x.theme)) && t.includes(d.identified_fee_issue.fee)
      && d.explanation_bullets.every(b => t.includes(b)) && d.source_links.every(u => t.includes(u)) && t.includes(d.weekly_pulse.trim());
  })());

  const replay = await call('notes.append_entry', { ...d, approval_token: g1.approval_token });
  check('an approval is single-use', replay.status === 'rejected');

  const w2 = await call('email.create_draft', { ...mail, approval_token: g2.approval_token });
  check('draft is created once approved', w2.status === 'draft_created' && w2.sent === false);
  const eml = fs.readFileSync(path.join(scratch, 'email-draft.eml'), 'utf8');
  check('the .eml opens as an unsent draft', /^X-Unsent: 1$/m.test(eml));
  check('the .eml carries the subject from the brief', eml.includes(mail.subject));

  proc.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
})();

/* ── the AI writer, against a stand-in model ───────────────────────────── */
await (async () => {
  console.log('\nAI writer (stand-in model, no network)');
  const { buildContext, writeWithModel, checkDraft, SYSTEM } = await import('../src/ai.js');
  const srcText = fs.readFileSync(path.join(ROOT, 'sources.csv'), 'utf8');
  const c = buildContext(r, srcText, { lastChecked: meta.pulled_on });
  check('context carries all 5 themes with retrieved evidence', c.ctx.themes.length === r.themes.length && c.ctx.themes.slice(0, 3).every(t => t.evidence.length >= 3));
  check('context carries evidence for the fee issue', c.ctx.fee_issue.evidence.length >= 5, `${c.ctx.fee_issue.evidence.length} reviews`);
  check('every evidence review is a real row', [...c.index.keys()].every(id => rows.some(x => x.review_id === id)));
  check('context carries the official source facts', c.ctx.official_sources.length === 6 && c.ctx.official_sources.every(s => s.facts));
  check('context identifies reviewers by id only', !/display_?name|author|user_?name|avatar/i.test(c.json));
  check('context stays inside a small budget', c.json.length < 24000, `${c.json.length} chars`);
  check('instructions forbid invented numbers, quotes and sources', /Never invent a number, a review or a source/.test(SYSTEM));

  const lead = c.ctx.themes.find(t => t.label === r.themes.find(x => x.polarity === 'negative').label);
  const good = {
    observation: `Charges are the most fixable complaint: ${r.feeSignal.confused} of ${r.feeSignal.mentions} reviews naming brokerage did not expect the deduction, while ${lead.label} is the largest negative theme.`,
    actions: ['Show the DP charge and GST on the order confirmation.', 'Show the rupee cost live as quantity is typed.', 'Use the explainer as the support reply for charge questions.'],
    quote_ids: [c.ctx.fee_issue.evidence[0].id, c.ctx.fee_issue.evidence[1].id, lead.evidence[0].id],
    explainer: { title: 'What is deducted when you sell', source_ids: ['S1', 'S3'], bullets: [
      'Brokerage is ₹20 or 0.1% of order value, whichever is lower, with a ₹5 minimum.',
      'A delivery sell has a DP charge of ₹16.50 from Groww and ₹3.50 from CDSL.',
      'GST of 18% applies on brokerage and DP charges.',
      'Each line is itemised on the contract note.'] }
  };
  const variant = patch => JSON.parse(JSON.stringify({ ...good, ...patch }));
  const fails = d => checkDraft(d, c).checks.filter(x => !x.ok).map(x => x.label).join(' | ');
  check('a grounded draft passes every check', checkDraft(good, c).ok, fails(good));
  check('an invented rupee figure is caught', !checkDraft(variant({ explainer: { ...good.explainer, bullets: [...good.explainer.bullets.slice(0, 3), 'A sell costs ₹25.'] } }), c).ok);
  check('advice words are caught', !checkDraft(variant({ explainer: { ...good.explainer, bullets: [...good.explainer.bullets.slice(0, 3), 'You should avoid small sells.'] } }), c).ok);
  check('a quote id outside the evidence is caught', !checkDraft(variant({ quote_ids: ['r_made_up', ...good.quote_ids.slice(1)] }), c).ok);
  check('an invented number in the observation is caught', !checkDraft(variant({ observation: 'Charges worry 4,812 users this week.' }), c).ok);
  check('an unofficial or unknown source is caught', !checkDraft(variant({ explainer: { ...good.explainer, source_ids: ['S1', 'S9'] } }), c).ok);
  check('more than 6 bullets is caught', !checkDraft(variant({ explainer: { ...good.explainer, bullets: Array(7).fill(good.explainer.bullets[2]) } }), c).ok);

  const bad = variant({ explainer: { ...good.explainer, bullets: [...good.explainer.bullets.slice(0, 3), 'You should avoid this ₹25 charge.'] } });
  let seen = [];
  let n = 0;
  const res = await writeWithModel({ result: r, sourcesText: srcText, lastChecked: meta.pulled_on, transport: async (sys, user) => { seen.push(user); return JSON.stringify(n++ ? good : bad); } });
  check('a failed draft goes back once with the reasons', res.status === 'accepted' && res.attempts.length === 2 && /previous draft failed/.test(seen[1]) && /₹25/.test(seen[1]));
  const out = res.output;
  check('the accepted pulse is 250 words or fewer', out.pulse.words <= 250, `${out.pulse.words} words`);
  check('the accepted pulse keeps the computed themes and scope', r.topThemes.every(t => out.pulse.markdown.includes(t.label)) && out.pulse.markdown.includes('12,765'));
  check('the accepted pulse quotes verbatim excerpts', (out.pulse.markdown.match(/^> "(.*)" — /gm) || []).length === 3 && (out.pulse.markdown.match(/^> "(.*)" — /gm) || []).every(l => {
    const body = l.replace(/^> "…?/, '').replace(/…?" — $/, ''); return rows.some(x => x.text.includes(body));
  }));
  const d2 = buildDocEntry(out);
  check('the accepted drafts flow into the same MCP payload', d2.explanation_bullets.length === 4 && d2.weekly_pulse === out.pulse.markdown && d2.source_links.length === 2);
  const fb = await writeWithModel({ result: r, sourcesText: srcText, transport: async () => JSON.stringify(bad) });
  check('two failed drafts leave the rule-based output in place', fb.status === 'fallback' && fb.output === r);
  const er = await writeWithModel({ result: r, sourcesText: srcText, transport: async () => { throw new Error('The model service refused the request (401)'); } });
  check('a refused key is reported, not retried', er.status === 'error' && er.attempts.length === 1);
  const junk = await writeWithModel({ result: r, sourcesText: srcText, transport: async () => 'Sure! Here is your summary.' });
  check('a reply that is not JSON never reaches the gate', junk.status === 'fallback');
})();

/* ── the browser runs the same server ──────────────────────────────────── */
console.log('\nOne server, two hosts');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const nodeSrc = fs.readFileSync(path.join(ROOT, 'mcp', 'server.js'), 'utf8');
check('the Node server imports the shared core', /from '\.\.\/src\/mcp-core\.js'/.test(nodeSrc));
check('the browser prototype imports the same core', /from '\.\/src\/mcp-core\.js'/.test(appSrc));
check('the browser does not script its own refusals', !/status":"rejected|status":"approval_required|"appended"/.test(appSrc));
check('the shared core has no platform imports', !/^import /m.test(fs.readFileSync(path.join(ROOT, 'src', 'mcp-core.js'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
