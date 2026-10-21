#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Soapbox MCP server — stdio, JSON-RPC 2.0, no dependencies.

   Two tools, both gated. Calling either one without an approval token does
   not perform the action: the server returns the exact payload it would
   write, plus a one-time token. The action happens only on a second call
   that carries that token, and a token is good for one call on one payload
   (it is an HMAC of the arguments, so an approved payload cannot be swapped
   for a different one before the write).

     notes.append_entry   → appends a dated entry to docs/product-pulse-log.md
     email.create_draft   → writes an .eml draft to out/ (never sends)

   The tools, the gate and the handler live in src/mcp-core.js; this file
   adds the stdio transport, Node's HMAC and the filesystem. The browser
   prototype runs the same core with Web Crypto and localStorage.

   Run:  node mcp/server.js
   Try:  node mcp/client-demo.js
   Env:  SOAPBOX_DOC=<path>  SOAPBOX_OUT=<dir>   (where to write; eval uses these)
   ────────────────────────────────────────────────────────────────────────── */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createServer } from '../src/mcp-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.resolve(ROOT, process.env.SOAPBOX_DOC || path.join('docs', 'product-pulse-log.md'));
const OUT = path.resolve(ROOT, process.env.SOAPBOX_OUT || 'out');
const DRAFT = path.join(OUT, 'email-draft.eml');
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

const server = createServer({
  secret: crypto.randomBytes(16).toString('hex'),                 // new each process
  hmacHex: (secret, msg) => crypto.createHmac('sha256', secret).update(msg).digest('hex'),
  store: {
    docPath: rel(DOC),
    draftPath: rel(DRAFT),
    readDoc: () => (fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : null),
    writeDoc: text => { fs.mkdirSync(path.dirname(DOC), { recursive: true }); fs.writeFileSync(DOC, text); },
    writeDraft: eml => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(DRAFT, eml); }
  }
});

/* ── JSON-RPC over stdio, one message per line ─────────────────────────── */

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
let buf = '';
let chain = Promise.resolve();          // answer in the order asked

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    chain = chain.then(async () => { const res = await server.handle(msg); if (res) send(res); });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
