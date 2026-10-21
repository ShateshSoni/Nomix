#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Drives mcp/server.js over stdio and prints every JSON-RPC message, so the
   approval gate is visible rather than asserted. It runs the pipeline, asks
   for both actions, is refused, shows what would be written, asks the person
   at the terminal, and only then calls again with the token.

     node mcp/client-demo.js            # asks for approval on the terminal
     node mcp/client-demo.js --approve  # answers yes for you (CI, demos)
     node mcp/client-demo.js --reject   # answers no, to show nothing is written
   ────────────────────────────────────────────────────────────────────────── */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { parseCSV, runPipeline, buildDocEntry, buildEmailDraft } from '../src/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auto = process.argv.includes('--approve') ? true : process.argv.includes('--reject') ? false : null;

const C = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m` };

/* ── a minimal MCP client ───────────────────────────────────────────────── */
const proc = spawn('node', [path.join(ROOT, 'mcp', 'server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
const pending = new Map();
let buf = '';
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', c => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    console.log(C.dim('  ← ' + line.slice(0, 220) + (line.length > 220 ? ' …' : '')));
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

const rpc = (method, params) => new Promise(res => {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  console.log(C.dim('  → ' + line.slice(0, 220) + (line.length > 220 ? ' …' : '')));
  pending.set(id, res);
  proc.stdin.write(line + '\n');
});

/** Notifications carry no id and get no reply, so they are never awaited. */
const notify = (method, params) => {
  const line = JSON.stringify({ jsonrpc: '2.0', method, params });
  console.log(C.dim('  → ' + line));
  proc.stdin.write(line + '\n');
};
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result?.structuredContent;

const ask = q => auto !== null ? Promise.resolve(auto) : new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(C.y(q + ' [y/N] '), a => { rl.close(); res(/^y(es)?$/i.test(a.trim())); });
});

/* ── run ────────────────────────────────────────────────────────────────── */
console.log(C.b('\n1. Pipeline'));
const rows = parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'reviews.csv'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corpus-meta.json'), 'utf8'));
const result = runPipeline(rows, { asOf: meta.window.to, totalInWindow: meta.reviews_in_window_all, lastChecked: meta.pulled_on });
console.log(`   ${result.meta.corpusSize} reviews analysed, top theme "${result.topThemes[0].label}", fee issue "${result.feeSignal.label}"`);
console.log(`   pulse ${result.pulse.words} words, explainer ${result.explainer.bullets.length} bullets`);

console.log(C.b('\n2. Connect'));
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'soapbox-demo', version: '2.0.0' } });
console.log(`   ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
notify('notifications/initialized', {});
const list = await rpc('tools/list', {});
console.log('   tools: ' + list.result.tools.map(t => t.name).join(', '));

const docArgs = buildDocEntry(result);
const mailArgs = buildEmailDraft(result);

console.log(C.b('\n3. Request both actions without approval'));
const g1 = await call('notes.append_entry', docArgs);
const g2 = await call('email.create_draft', mailArgs);
if (g1.status !== 'approval_required' || g2.status !== 'approval_required') {
  console.error(C.r('\nFAIL: a tool ran without approval.')); proc.kill(); process.exit(1);
}
console.log(C.g('   both blocked, server returned approval_required with a token'));

console.log(C.b('\n4. Human decision'));
console.log(C.dim('   ' + g1.what_will_happen + '\n   ' + g2.what_will_happen));
const ok = await ask('   Approve both actions?');

if (!ok) {
  console.log(C.r('\n   Rejected. Nothing was written.'));
  const forged = await call('notes.append_entry', { ...docArgs, approval_token: 'not-a-real-token' });
  console.log('   A forged token is refused too: ' + C.dim(forged.reason));
  proc.kill(); process.exit(0);
}

console.log(C.b('\n5. Approved, calling again with the token'));
const r1 = await call('notes.append_entry', { ...docArgs, approval_token: g1.approval_token });
const r2 = await call('email.create_draft', { ...mailArgs, approval_token: g2.approval_token });
console.log(C.g(`   ${r1.status}: ${r1.file} (+${r1.bytes_added} bytes)`));
console.log(C.g(`   ${r2.status}: ${r2.file}, sent=${r2.sent}`));

console.log(C.b('\n6. Replay check'));
const again = await call('notes.append_entry', { ...docArgs, approval_token: g1.approval_token });
console.log(again.status === 'rejected' ? C.g('   single-use approval held: ' + again.reason) : C.r('   FAIL: token was reusable'));

proc.kill();
console.log('');
process.exit(again.status === 'rejected' ? 0 : 1);
