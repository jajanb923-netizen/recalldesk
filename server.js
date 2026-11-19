// RecallDesk server — plain node:http, no dependencies.
// Serves the demo UI + JSON API backed by Meko (shared memory) + Groq.
// Env: PORT (default 8787), MEKO_URL, MEKO_API_KEY, GROQ_MODEL.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { MekoClient } = require('./meko');
const { RecallDesk } = require('./agents');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml' };

const meko = new MekoClient();
const desk = new RecallDesk(meko);
let ready = null;

function send(res, code, obj, type = 'application/json') {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('bad JSON body')); } });
    req.on('error', reject);
  });
}

async function ensureReady() {
  if (!ready) ready = desk.init();
  return ready;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/api/health') {
      const info = await ensureReady().catch((e) => ({ error: e.message }));
      return send(res, info.error ? 500 : 200, { ok: !info.error, mekoUrl: process.env.MEKO_URL || 'http://127.0.0.1:7777/mcp', cloud: !!process.env.MEKO_API_KEY, ...info });
    }

    if (p === '/api/seed' && req.method === 'POST') {
      await ensureReady();
      return send(res, 200, await desk.seed());
    }

    if (p === '/api/tickets' && req.method === 'GET') {
      desk.loadState();
      return send(res, 200, { tickets: desk.state.tickets, seeded: desk.state.seeded });
    }

    if (p === '/api/tickets' && req.method === 'POST') {
      await ensureReady();
      const body = await readBody(req);
      if (!body.title) return send(res, 400, { error: 'title is required' });
      const ticket = await desk.runTicket({ title: body.title, body: body.body || '', reporter: body.reporter || 'customer' });
      return send(res, 200, { ticket });
    }

    const runMatch = p.match(/^\/api\/tickets\/(\d+)\/run$/);
    if (runMatch && req.method === 'POST') {
      await ensureReady();
      const id = Number(runMatch[1]);
      const t = desk.state.tickets.find((x) => x.id === id);
      if (!t) return send(res, 404, { error: `no ticket #${id}` });
      // Re-run the same ticket text as a fresh ticket (the "next day" replay).
      const ticket = await desk.runTicket({ title: t.title, body: t.body, reporter: t.reporter });
      return send(res, 200, { ticket });
    }

    const promMatch = p.match(/^\/api\/tickets\/(\d+)\/promote$/);
    if (promMatch && req.method === 'POST') {
      await ensureReady();
      return send(res, 200, await desk.promote(Number(promMatch[1])));
    }

    if (p === '/api/memory' && req.method === 'GET') {
      await ensureReady();
      return send(res, 200, await desk.memoryPanel());
    }

    const traceMatch = p.match(/^\/api\/tickets\/(\d+)\/trace$/);
    if (traceMatch && req.method === 'GET') {
      await ensureReady();
      const id = Number(traceMatch[1]);
      const t = desk.state.tickets.find((x) => x.id === id);
      if (!t || !t.conversationId) return send(res, 404, { error: `no trace for ticket #${id}` });
      return send(res, 200, await meko.conversationGet(t.conversationId, { includeMessages: true }));
    }

    // Static files.
    let file = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return send(res, 404, { error: 'not found' }, 'text/plain');
    }
    return send(res, 200, fs.readFileSync(full, 'utf8'), MIME[path.extname(full)] || 'text/plain');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`RecallDesk on http://127.0.0.1:${PORT} (Meko: ${process.env.MEKO_URL || 'http://127.0.0.1:7777/mcp'})`);
});
