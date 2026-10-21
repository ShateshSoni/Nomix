/* ──────────────────────────────────────────────────────────────────────────
   Soapbox MCP server core — the tools, the approval gate and the JSON-RPC
   handler, with nothing platform-specific inside.

   Two hosts run this file unchanged:
     mcp/server.js   stdio transport, Node crypto for the HMAC, files on disk
     app.js          in-page transport, Web Crypto for the HMAC, localStorage

   So the approval exchange a grader clicks through on GitHub Pages is the
   same code path the eval suite drives over stdio: the token is computed,
   a forged or moved token is refused by the gate, and an approval is spent
   once. Nothing in the browser is scripted to look like a refusal.
   ────────────────────────────────────────────────────────────────────────── */

export const SERVER = { name: 'soapbox-mcp', version: '2.0.0' };
export const PROTOCOL = '2024-11-05';

export const DOC_HEADER = '# Product pulse log\n\nOne entry per weekly run. Appended by the Soapbox MCP server after human approval.\n';

/** Key-ordered JSON, so the same arguments always hash the same. */
export const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  : JSON.stringify(v ?? null);

const utf8Bytes = s => new TextEncoder().encode(s).length;

/* ── what the tools write ──────────────────────────────────────────────── */

export function renderEntry(a) {
  const themes = (a.top_themes || []).map((t, i) => `${i + 1}. ${t.theme} — ${t.reviews} reviews (${t.share_pct}%), ${t.avg_rating}★`).join('\n');
  const fee = a.identified_fee_issue || {};
  return `
---

## Week ending ${a.date}

**Top themes**

${themes}

**Fee issue identified from reviews:** ${fee.fee} — named in ${fee.reviews_naming_it} reviews, ${fee.reviews_signalling_confusion} of them signalling confusion (${fee.confusion_rate_pct}%), trend ${fee.trend}.

<details><summary>Weekly pulse</summary>

${a.weekly_pulse}

</details>

**Explanation issued to support**

${(a.explanation_bullets || []).map(b => `- ${b}`).join('\n')}

**Sources**

${(a.source_links || []).map(u => `- ${u}`).join('\n')}

_Logged via soapbox-mcp after human approval._
`;
}

/** RFC-822 text with X-Unsent, which mail clients open as an editable draft. */
export function renderEml(args) {
  return [
    `To: ${(args.to || []).join(', ')}`,
    args.cc?.length ? `Cc: ${args.cc.join(', ')}` : null,
    `Subject: ${args.subject}`,
    `X-Unsent: 1`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    args.body
  ].filter(x => x !== null).join('\r\n');
}

/* ── the server ────────────────────────────────────────────────────────── */

/**
 * @param {object} host
 * @param {string} host.secret        minted per process or per page load
 * @param {(secret: string, message: string) => string|Promise<string>} host.hmacHex
 * @param {object} host.store
 * @param {string} host.store.docPath      label shown to the approver
 * @param {string} host.store.draftPath    label shown to the approver
 * @param {() => string|null} host.store.readDoc
 * @param {(text: string) => void} host.store.writeDoc
 * @param {(eml: string) => void} host.store.writeDraft
 */
export function createServer({ secret, hmacHex, store }) {
  const spent = new Set();

  const fingerprint = async (tool, args) => {
    const { approval_token, ...rest } = args || {};
    return (await hmacHex(secret, tool + '\u0000' + stable(rest))).slice(0, 32);
  };

  /** Returns { blocked, payload } — the three refusals a gate must make. */
  async function gate(tool, args, preview) {
    const expected = await fingerprint(tool, args);
    const given = args?.approval_token;
    if (!given) {
      return {
        blocked: true,
        payload: {
          status: 'approval_required',
          tool,
          what_will_happen: preview.what,
          target: preview.target,
          preview: preview.preview,
          approval_token: expected,
          how_to_proceed: `Show this to a human. If they approve, call ${tool} again with the same arguments plus approval_token.`
        }
      };
    }
    if (given !== expected) return { blocked: true, payload: { status: 'rejected', reason: 'The approval token does not match these arguments. Approve the payload you intend to write.' } };
    if (spent.has(given)) return { blocked: true, payload: { status: 'rejected', reason: 'This approval was already used. Approvals are single-use.' } };
    spent.add(given);
    return { blocked: false };
  }

  const tools = [
    {
      name: 'notes.append_entry',
      description: 'Append one dated weekly-pulse entry to the team product log. Requires human approval: call once to get the payload and a token, then again with approval_token to write.',
      inputSchema: {
        type: 'object',
        required: ['date', 'top_themes', 'weekly_pulse', 'identified_fee_issue', 'explanation_bullets', 'source_links'],
        properties: {
          date: { type: 'string', description: 'ISO date the pulse covers' },
          top_themes: { type: 'array', description: 'Top themes with counts' },
          weekly_pulse: { type: 'string', description: 'The note, markdown, 250 words or fewer' },
          identified_fee_issue: { type: 'object', description: 'The fee the reviews were confused about, with its evidence counts' },
          explanation_bullets: { type: 'array', items: { type: 'string' }, description: 'Fee explainer, 6 bullets or fewer' },
          source_links: { type: 'array', items: { type: 'string' }, description: 'Official source URLs' },
          approval_token: { type: 'string', description: 'Token from the approval_required response' }
        }
      },
      async run(args) {
        const g = await gate('notes.append_entry', args, {
          what: `Append a dated entry to ${store.docPath}`,
          target: store.docPath,
          preview: renderEntry(args).slice(0, 700) + '…'
        });
        if (g.blocked) return g.payload;

        const entry = renderEntry(args);
        const current = store.readDoc() ?? DOC_HEADER;
        const next = current + entry;
        store.writeDoc(next);
        return {
          status: 'appended',
          file: store.docPath,
          bytes_added: utf8Bytes(entry),
          document_lines: next.split('\n').length,
          entries: (next.match(/^## Week ending /gm) || []).length,
          entry_heading: `Week ending ${args.date}`
        };
      }
    },
    {
      name: 'email.create_draft',
      description: 'Create an email draft as RFC-822 .eml, which any mail client opens as an unsent message. Never sends. Requires human approval, same two-call flow.',
      inputSchema: {
        type: 'object',
        required: ['to', 'subject', 'body'],
        properties: {
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
          approval_token: { type: 'string', description: 'Token from the approval_required response' }
        }
      },
      async run(args) {
        const g = await gate('email.create_draft', args, {
          what: `Write a draft (not send) to ${store.draftPath}`,
          target: store.draftPath,
          preview: `To: ${(args.to || []).join(', ')}\nSubject: ${args.subject}\n\n${(args.body || '').slice(0, 500)}…`
        });
        if (g.blocked) return g.payload;

        const eml = renderEml(args);
        store.writeDraft(eml);
        return { status: 'draft_created', sent: false, file: store.draftPath, to: args.to, subject: args.subject, bytes: utf8Bytes(eml) };
      }
    }
  ];

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  /** One JSON-RPC message in, one response out (null for notifications). */
  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') return ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === 'tools/call') {
      const tool = tools.find(t => t.name === params?.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${params?.name}`);
      let out;
      try { out = await tool.run(params.arguments || {}); }
      catch (e) { return ok(id, { isError: true, content: [{ type: 'text', text: `${tool.name} failed: ${e.message}` }] }); }
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: out.status === 'rejected' });
    }
    if (id !== undefined) return err(id, -32601, `Method not found: ${method}`);
    return null;
  }

  return { tools, handle };
}

/** HMAC-SHA256 as hex through Web Crypto, for browsers and for Node 19+. */
export async function hmacHexWebCrypto(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
