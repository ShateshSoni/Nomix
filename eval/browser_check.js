#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Drives the prototype in headless Chromium: lets it run on load, walks the
   views, reads the transcript the in-page MCP server produced, approves, and
   checks that the document in the browser grew by exactly one entry while
   the moved and replayed tokens were refused. Writes the README screenshots.

     node eval/browser_check.js                 # needs playwright + chromium
     node eval/browser_check.js --shots         # also refresh docs/screenshots

   Exits 1 on any failure, 0 otherwise; exits 0 with a note if Playwright is
   not installed, so eval/run_eval.js stays dependency-free.
   ────────────────────────────────────────────────────────────────────────── */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.argv.includes('--shots');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const LOG_KEY = 'soapbox.product-pulse-log.md', DRAFT_KEY = 'soapbox.email-draft.eml';

let pw;
try { pw = await import('playwright'); }
catch {
  try { pw = await import(path.join(process.env.NODE_TOOLS || '/opt/node-tools', 'node_modules', 'playwright', 'index.mjs')); }
  catch { console.log('playwright not installed; skipping the browser check (npm i -D playwright && npx playwright install chromium)'); process.exit(0); }
}

/* ── a static server for the repo root ─────────────────────────────────── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const entries = page => page.evaluate(k => ((localStorage.getItem(k) || '').match(/^## Week ending /gm) || []).length, LOG_KEY);
const waitConsole = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.querySelector('#console-out')?.textContent || ''), re.source, { timeout: 30000 });
const go = async (page, view) => { await page.evaluate(v => { location.hash = '#' + v; }, view); await page.waitForSelector(`#view-${view}:not([hidden])`); await page.waitForTimeout(150); };
const shot = (page, name) => SHOTS ? page.screenshot({ path: path.join(OUT, name), fullPage: false }) : Promise.resolve();

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

try {
  if (SHOTS) fs.mkdirSync(OUT, { recursive: true });
  console.log('\nPrototype in headless Chromium');
  await page.goto(base, { waitUntil: 'networkidle' });
  await waitConsole(page, /waiting for a human/);
  await page.waitForTimeout(200);

  /* overview */
  check('page ran the pipeline on load without errors', errors.length === 0, errors.join(' | '));
  check('five KPI tiles', (await page.$$('#kpis div')).length === 5);
  check('rating mix has five bars', (await page.$$('#rating-mix .bar')).length === 5);
  check('twelve weekly columns', (await page.$$('#weekly-volume .col')).length === 12);
  check('five themes listed', (await page.$$('#theme-list li')).length === 5);
  check('headline names the fee issue', /Brokerage|charge/i.test(await page.textContent('#headline-title')) && (await page.$$('#headline-facts div')).length === 4);
  check('sidebar badges filled', /\d/.test(await page.textContent('#n-reviews')) && (await page.textContent('#n-pending')).trim() === '2');
  check('run status reports the corpus', /reviews analysed/.test(await page.textContent('#run-status')));
  await shot(page, '1-overview.png');

  /* reviews */
  await go(page, 'reviews');
  const total = await page.textContent('#review-count');
  check('reviews view lists the corpus', /^3,2\d\d of 3,2\d\d reviews/.test(total.trim()), total.trim());
  check('first page shows 40 review cards', (await page.$$('#review-list .review')).length === 40);
  check('filter summary tiles render', (await page.$$('#rv-stats > div')).length === 4);
  await page.fill('#q', 'dp charge');
  await page.waitForTimeout(150);
  const n1 = await page.$$('#review-list .review');
  check('search narrows the list and highlights the term', n1.length > 0 && n1.length < 40 && (await page.$$('#review-list mark')).length > 0, `${n1.length} cards`);
  await shot(page, '2-reviews.png');
  await page.fill('#q', '');
  await page.click('#f-rating button[data-r="1"]');
  await page.waitForTimeout(150);
  check('rating filter applies', /1★/.test(await page.textContent('#review-count')) && (await page.$$('#review-list .review')).length > 0);
  await page.click('#f-rating button[data-r=""]');
  await page.click('#more');
  await page.waitForTimeout(150);
  check('show more appends a page', (await page.$$('#review-list .review')).length === 80);

  /* the sidebar search is a shortcut into the reviews view */
  await go(page, 'overview');
  await page.fill('#cmd', 'withdraw');
  await page.waitForSelector('#view-reviews:not([hidden])');
  await page.waitForTimeout(150);
  check('sidebar search opens reviews filtered', /"withdraw"/.test(await page.textContent('#review-count')) && (await page.$$('#review-list mark')).length > 0);
  await page.fill('#cmd', '');

  /* themes */
  await go(page, 'themes');
  check('five theme cards', (await page.$$('#theme-cards .theme-card')).length === 5);
  check('each theme card carries a sparkline', (await page.$$('#theme-cards .spark svg')).length === 5);
  check('three quotes rendered', (await page.$$('#quotes .quote')).length === 3);
  await shot(page, '3-themes.png');
  await page.click('#theme-cards [data-browse="charges"]');
  await page.waitForSelector('#view-reviews:not([hidden])');
  await page.waitForTimeout(150);
  check('a theme card opens the reviews view filtered', /Charges users did not expect/.test(await page.textContent('#review-count')));

  /* fee */
  await go(page, 'fee');
  check('fee table ranks six charges', (await page.$$('#fees tbody tr')).length === 6 && !!(await page.$('#fees tr.picked')));
  check('confused reviews listed as evidence', (await page.$$('#fee-evidence .review')).length > 5);
  await shot(page, '4-fee-issue.png');

  /* pulse and explainer */
  await go(page, 'pulse');
  check('pulse within budget', /^\d+ of 250 words$/.test((await page.textContent('#pulse-budget')).trim()) && !(await page.$('#pulse-budget.over')));
  check('pulse carries three quotes', (await page.$$('#pulse blockquote')).length === 3);
  check('pulse checks all pass', (await page.$$('#pulse-checks li')).length === 6 && (await page.$$('#pulse-checks li.no')).length === 0);
  await shot(page, '5-pulse.png');
  await go(page, 'explainer');
  check('explainer has six bullets and two links', (await page.$$('#explainer > ul > li')).length === 6 && (await page.$$('#explainer .srcs a')).length === 2);
  check('explainer carries Last checked', /Last checked: \d+ \w+ \d{4}/.test(await page.textContent('#explainer')));
  check('explainer checks all pass', (await page.$$('#exp-checks li')).length === 6 && (await page.$$('#exp-checks li.no')).length === 0);
  await shot(page, '6-explainer.png');

  /* the gate */
  await go(page, 'approve');
  const transcript1 = await page.textContent('#console-out');
  check('server initialised in-page', /serverInfo.*soapbox-mcp/.test(transcript1));
  check('both tools listed', /notes\.append_entry.*email\.create_draft/.test(transcript1));
  const tokens = [...transcript1.matchAll(/"approval_token":"([0-9a-f]{32})"/g)].map(m => m[1]);
  check('both calls refused with a computed token', tokens.length === 2 && tokens[0] !== tokens[1], tokens.map(t => t.slice(0, 8) + '…').join(' '));
  check('nothing written before approval', !/"status":"appended"/.test(transcript1));
  await shot(page, '7-approval-gate.png');

  const before = await entries(page);
  await page.click('#approve');
  await page.waitForSelector('#results:not([hidden])', { timeout: 30000 });
  await waitConsole(page, /written once|unexpected/);
  const transcript2 = await page.textContent('#console-out');
  const after = await entries(page);
  check('append succeeded once approved', /"status":"appended"/.test(transcript2));
  check('draft created, not sent', /"status":"draft_created".*"sent":false/.test(transcript2));
  check('the document in the browser grew by one entry', after === before + 1, `${before} → ${after}`);
  check('an approved token moved to an edited payload was refused', /does not match these arguments/.test(transcript2));
  check('a replayed approval was refused', /already used/.test(transcript2));
  check('log entry rendered', /Week ending/.test(await page.textContent('#logentry')));
  check('email draft rendered with the subject from the brief', /Weekly Product Pulse \+ Customer Clarification — /.test(await page.textContent('#mail')));
  check('.eml download carries X-Unsent', /X-Unsent: 1/.test(await page.evaluate(k => localStorage.getItem(k) || '', DRAFT_KEY)));
  check('no page errors during the walk', errors.length === 0, errors.join(' | '));
  if (SHOTS) {
    await page.$eval('#console', e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, '8-transcript.png') });
    await page.$eval('#results', e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, '9-logged-and-drafted.png') });
  }

  /* the reject path, on a fresh page, must leave the document alone */
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await page2.goto(base + '#approve', { waitUntil: 'networkidle' });
  await waitConsole(page2, /waiting for a human/);
  const b2 = await entries(page2);
  await page2.click('#reject');
  await waitConsole(page2, /no document was touched/);
  const a2 = await entries(page2);
  const t2 = await page2.textContent('#console-out');
  check('reject: forged token refused by the server', /does not match these arguments/.test(t2));
  check('reject: document unchanged', a2 === b2, `${b2} → ${a2}`);
  if (SHOTS) { await page2.$eval('#console', e => e.scrollIntoView({ block: 'start' })); await page2.screenshot({ path: path.join(OUT, '10-rejected.png') }); }

  /* write with AI: the model is intercepted, so no key and no network are needed */
  const page5 = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
  const errs5 = []; page5.on('pageerror', e => errs5.push(e.message));
  let modelCalls = 0, sawKeyInUrl = false, sentFeedback = false;
  await page5.route('https://generativelanguage.googleapis.com/**', async route => {
    const req = route.request();
    if (/key=/.test(req.url())) sawKeyInUrl = true;
    const body = JSON.parse(req.postData());
    const user = body.contents[0].parts[0].text;
    if (/previous draft failed/.test(user)) sentFeedback = true;
    const ctx = JSON.parse(user.slice(user.indexOf('{'), user.indexOf('\n\nWrite this week')));
    const neg = ctx.themes.find(t => t.avg_stars < 3);
    const draft = {
      observation: `Charges are the most fixable complaint: ${ctx.fee_issue.reviews_not_expecting_it} of ${ctx.fee_issue.reviews_naming_it} reviews naming brokerage did not expect the deduction, while ${neg.label} leads the negative themes.`,
      actions: ['Show the DP charge and GST on the order confirmation.', 'Show the rupee cost live as quantity is typed.', 'Use the explainer as the support reply for charge questions.'],
      quote_ids: [ctx.fee_issue.evidence[0].id, ctx.fee_issue.evidence[1].id, neg.evidence[0].id],
      explainer: { title: 'What is deducted when you sell', source_ids: ['S1', 'S3'], bullets: [
        'Brokerage is ₹20 or 0.1% of order value, whichever is lower, with a ₹5 minimum.',
        'A delivery sell has a DP charge of ₹16.50 from Groww and ₹3.50 from CDSL.',
        'GST of 18% applies on brokerage and DP charges.',
        modelCalls === 0 ? 'You should avoid small sells, which cost ₹25.' : 'Each line is itemised on the contract note.'] }
    };
    modelCalls++;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }] }) });
  });
  await page5.goto(base, { waitUntil: 'networkidle' });
  await waitConsole(page5, /waiting for a human/);
  await go(page5, 'ai');
  check('AI view shows what the model reads', (await page5.$$('#ai-ctx li')).length === 5 && /tokens/.test(await page5.textContent('#ai-ctx-size')));
  check('AI view starts on the rule-based writer', /rule-based/.test(await page5.textContent('#ai-writer')));
  await page5.click('#ai-go');
  check('no key, no call', modelCalls === 0 && /key/i.test(await page5.textContent('#ai-status')));
  await page5.fill('#ai-key', 'test-key-not-real');
  await page5.click('#ai-go');
  await page5.waitForSelector('#ai-use:not([hidden])', { timeout: 15000 });
  check('a failing first draft is sent back with its reasons', modelCalls === 2 && sentFeedback);
  check('both drafts show their checks', (await page5.$$('#ai-attempts > div')).length === 2 && (await page5.$$('#ai-attempts li.no')).length >= 2);
  check('the key never goes in a URL', !sawKeyInUrl);
  if (SHOTS) await page5.screenshot({ path: path.join(OUT, '12-write-with-ai.png'), fullPage: true });
  await page5.click('#ai-use');
  await page5.waitForSelector('#view-pulse:not([hidden])');
  check('the AI drafts become the pulse in use', /Written with Google Gemini/.test(await page5.textContent('#view-pulse [data-writer]')) && /most fixable complaint/.test(await page5.textContent('#pulse')));
  check('the pulse checks still pass on the AI draft', (await page5.$$('#pulse-checks li.no')).length === 0);
  await go(page5, 'explainer');
  check('the explainer checks still pass on the AI draft', (await page5.$$('#exp-checks li.no')).length === 0);
  await go(page5, 'approve');
  await waitConsole(page5, /waiting for a human/);
  check('the gate holds the AI drafts until approval', /most fixable complaint/.test(await page5.textContent('#pay-mail')) && (await entries(page5)) === 0);
  await page5.click('#approve');
  await waitConsole(page5, /draft_created/);
  check('approving logs the AI drafts', (await entries(page5)) === 1 && /most fixable complaint/.test(await page5.evaluate(k => localStorage.getItem(k), LOG_KEY)));
  check('no page errors in the AI walk', errs5.length === 0, errs5.join(' | '));
  await page5.close();

  /* bring-your-own CSV: the same file through the upload path must run end to end */
  const page4 = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await page4.goto(base, { waitUntil: 'networkidle' });
  await waitConsole(page4, /waiting for a human/);
  await page4.setInputFiles('#csv', path.join(ROOT, 'data', 'reviews.csv'));
  await page4.waitForFunction(() => document.querySelector('#ws-name')?.textContent === 'reviews', null, { timeout: 30000 });
  await page4.waitForFunction(() => /reviews analysed/.test(document.querySelector('#run-status')?.textContent || ''), null, { timeout: 60000 });
  check('an uploaded CSV runs through the same pipeline', (await page4.$$('#theme-cards .theme-card')).length === 5 && /\d{4}/.test(await page4.textContent('#hero-date')));
  await page4.close();

  /* phone width: no horizontal overflow */
  const page3 = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await page3.goto(base, { waitUntil: 'networkidle' });
  await waitConsole(page3, /waiting for a human/);
  const over = await page3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal scroll at phone width', over <= 0, `${over}px`);
  if (SHOTS) await page3.screenshot({ path: path.join(OUT, '11-phone.png') });
} catch (e) {
  check('browser run completed', false, e.message);
} finally {
  await browser.close();
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
