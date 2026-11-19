// Minimal MCP client for Meko (Streamable HTTP). No dependencies.
// Works against Meko Local (http://127.0.0.1:7777/mcp, no auth) and
// Meko Cloud (https://mcp.mekodata.ai/mcp + Bearer API key) — same protocol.
// Env: MEKO_URL, MEKO_API_KEY.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = process.env.MEKO_URL || 'http://127.0.0.1:7777/mcp';
const DEFAULT_KEY = process.env.MEKO_API_KEY || '';

function parseMcpBody(text, contentType) {
  const t = (text || '').trim();
  if (!t) return null;
  if ((contentType || '').includes('text/event-stream') || t.startsWith('event:') || t.startsWith('data:')) {
    // SSE: take the last `data:` line that parses as JSON with a result.
    let last = null;
    for (const line of t.split('\n')) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      try { const j = JSON.parse(m[1]); if (j.result || j.error) last = j; } catch (_) { /* not json */ }
    }
    if (last) return last;
  }
  try { return JSON.parse(t); } catch (_) { return { raw: t }; }
}

class MekoClient {
  constructor(url = DEFAULT_URL, apiKey = DEFAULT_KEY) {
    this.url = url;
    this.apiKey = apiKey;
    this.sessionId = null;
    this._id = 0;
  }

  headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
      h['User-Agent'] = 'recalldesk/1.0';
    }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async rpc(method, params = {}) {
    const id = ++this._id;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`Meko HTTP ${res.status}: ${text.slice(0, 400)}`);
    const body = parseMcpBody(text, res.headers.get('content-type') || '');
    if (!body) throw new Error('Meko returned an empty response');
    if (body.error) throw new Error(`Meko ${method} error ${body.error.code}: ${body.error.message}`);
    return body.result;
  }

  async initialize() {
    return this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'recalldesk', version: '1.0.0' },
    });
  }

  // Call one MCP tool. Returns the parsed result: usually an object parsed
  // from the tool's text content; raw text otherwise. Throws on isError.
  async callTool(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const parts = (result && result.content) || [];
    const texts = parts.filter((p) => p.type === 'text').map((p) => p.text);
    let joined = texts.join('\n');
    if (!joined && result && result.structuredContent !== undefined) {
      const sc = result.structuredContent;
      joined = typeof sc === 'string' ? sc : JSON.stringify(sc);
    }
    if (result && result.isError) throw new Error(`Meko tool ${name} failed: ${joined.slice(0, 500)}`);
    if (!joined) return null;
    try { return JSON.parse(joined); } catch (_) { return joined; }
  }

  // Convenience wrappers -------------------------------------------------
  async listDatapacks() {
    return this.callTool('datapack_list', {});
  }

  async metrics(days = 30, conversationId) {
    return this.callTool('datapack_metrics', { days, ...(conversationId ? { conversation_id: conversationId } : {}) });
  }

  async contextSearch(query, conversationId, opts = {}) {
    return this.callTool('context_search', {
      query, conversation_id: conversationId, agent_id: opts.agentId || 'recalldesk:triage',
      ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.forceSource ? { force_source: opts.forceSource } : {}),
    });
  }

  async memorySearch(query, conversationId, opts = {}) {
    return this.callTool('memory_search', {
      query, conversation_id: conversationId, agent_id: opts.agentId || 'recalldesk:triage',
      ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
  }

  async memoryAdd(text, conversationId, opts = {}) {
    return this.callTool('memory_add', {
      text, conversation_id: conversationId, agent_id: opts.agentId || 'recalldesk:resolver',
      ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  async memoryGetAll(conversationId, opts = {}) {
    return this.callTool('memory_get_all', {
      conversation_id: conversationId, agent_id: opts.agentId || 'recalldesk:triage',
      ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
      ...(opts.promoted !== undefined ? { promoted: opts.promoted } : {}),
      page: opts.page || 1, page_size: opts.pageSize || 100,
    });
  }

  async memoryPromote(memoryIds, conversationId, opts = {}) {
    return this.callTool('memory_promote', {
      memory_ids: memoryIds, conversation_id: conversationId,
      agent_id: opts.agentId || 'recalldesk:reviewer',
      ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
    });
  }

  async knowledgeSearch(query, conversationId, datapackId, opts = {}) {
    return this.callTool('knowledgebase_search', {
      query, conversation_id: conversationId, datapack_id: datapackId,
      agent_id: opts.agentId || 'recalldesk:triage',
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
  }

  // knowledgebase_upload_document: request a presigned URL, PUT the exact
  // bytes, then poll the document status until indexed. Works on Local
  // (upload_file needs a client token there) and on Cloud.
  async knowledgeUploadDocument(filePath, conversationId, opts = {}) {
    const crypto = require('crypto');
    const bytes = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const head = bytes.subarray(0, 3072).toString('base64');
    const req = await this.callTool('knowledgebase_upload_document', {
      filename: path.basename(filePath), size: bytes.length, content_hash: hash,
      content_head_base64: head, conversation_id: conversationId,
      agent_id: opts.agentId || 'recalldesk:seed',
      ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
    });
    if (req && req.already_uploaded) return { already: true, key: req.key };
    const url = req.upload_url || req.url || req.presigned_url;
    const key = req.key || req.document_key;
    if (!url) throw new Error(`knowledge upload: no upload URL in response: ${JSON.stringify(req).slice(0, 300)}`);
    // Local Meko's upload endpoint takes multipart/form-data with the file
    // as field "file" (S3-style presigned POST is not what it serves).
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'text/markdown' }), path.basename(filePath));
    const put = await fetch(url, { method: 'POST', body: form, duplex: 'half' });
    if (!put.ok) throw new Error(`knowledge upload POST failed: HTTP ${put.status}: ${(await put.text()).slice(0, 300)}`);
    // Poll until indexed (up to ~45s).
    const started = Date.now();
    for (;;) {
      const st = await this.callTool('knowledgebase_document_status', {
        document_key: key, conversation_id: conversationId,
        ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
      });
      const state = st.state || st.status;
      if (state === 'completed') return { key, state };
      if (state === 'failed' || state === 'abandoned' || state === 'oversized') {
        throw new Error(`knowledge upload ${path.basename(filePath)} ended ${state}: ${st.message || ''}`);
      }
      if (Date.now() - started > 45000) throw new Error(`knowledge upload ${path.basename(filePath)} still ${state} after 45s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async conversationCreate(title, agentId) {
    return this.callTool('conversation_create', { title, agent_id: agentId || 'recalldesk:triage' });
  }

  async conversationAddMessage(conversationId, input, output, opts = {}) {
    return this.callTool('conversation_add_message', {
      conversation_id: conversationId, input, output,
      agent_id: opts.agentId || 'recalldesk:triage',
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.plan ? { plan: opts.plan } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  async conversationGet(conversationId, opts = {}) {
    return this.callTool('conversation_get', {
      conversation_id: conversationId, agent_id: opts.agentId || 'recalldesk:triage',
      include_messages: opts.includeMessages !== false, limit: opts.limit || 100,
    });
  }

  async artifactPut(filename, text, conversationId, opts = {}) {
    return this.callTool('artifact_put', {
      filename, content_base64: Buffer.from(text, 'utf8').toString('base64'),
      content_type: opts.contentType || 'text/markdown',
      conversation_id: conversationId, agent_id: opts.agentId || 'recalldesk:resolver',
      ...(opts.datapackId ? { datapack_id: opts.datapackId } : {}),
    });
  }
}

module.exports = { MekoClient, DEFAULT_URL };
