// RecallDesk agent team: triage + resolver + reviewer, sharing ONE Meko datapack.
// Flow per ticket:
//   1. Triage: context_search (memory + knowledge + conversations, one call).
//   2. Strong memory hit  -> resolve FROM MEMORY, citing the earlier fix.
//      No hit              -> resolver solves (Groq, runbook context only),
//                             saves the fix as a memory + conversation + artifact.
//   3. Reviewer checks the new fix; if approved it waits for a human to
//      promote it into shared knowledge (memory_promote, one-way gate).
// Every turn is stored in Meko as a conversation with reasoning + plan, so
// the decision trace is auditable in the datapack itself.
'use strict';

const fs = require('fs');
const path = require('path');
const { chat, estimateTokens } = require('./groq');

const AGENTS = { triage: 'recalldesk:triage', resolver: 'recalldesk:resolver', reviewer: 'recalldesk:reviewer' };
const SEED_DIR = path.join(__dirname, 'seed');
const RUNBOOKS = ['RB-1-login-timeout.md', 'RB-2-stale-notifications.md', 'RB-3-dashboard-counts.md'];
const MEMORY_HIT_SCORE = 0.45; // min score for "we already know this fix"
const STOPWORDS = new Set(('a an the and or of to in on for with after before users user customer report reported issue problem please help can cannot cant just very more than then that this it is are was were be been has have had do does did will would should could there here what when where which who whom how all any some no not only also just hangs hang screen page app web our their his her its they them we you i me my'.split(' ')));

function keywords(text) {
  return new Set((text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

function keywordOverlap(a, b) {
  const ka = keywords(a);
  const kb = keywords(b);
  const shared = [...ka].filter((w) => kb.has(w));
  return { count: shared.length, words: shared };
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v.hits)) return v.hits;
  return [];
}

function hitText(h) {
  if (typeof h === 'string') return h;
  return h.memory || h.chunk_text || h.text || h.content || h.chunk || h.title || JSON.stringify(h);
}

function hitScore(h) {
  if (typeof h === 'number') return h;
  if (h.rerank_score !== undefined && h.rerank_score !== null) return Number(h.rerank_score);
  if (h.distance !== undefined && h.distance !== null) return Math.max(0, 1 - Number(h.distance));
  return Number(h.score ?? h.relevance ?? h.similarity ?? 0);
}

function normBuckets(result) {
  // context_search returns { results: { memory, knowledge_base, conversation },
  //   token_savings }. Buckets live under `results`, not the top level.
  const out = { memory: [], knowledge: [], conversation: [], matchQuality: null, agentHint: null, tokenSavings: null, raw: result };
  if (!result || typeof result !== 'object') return out;
  const r = result.results || result;
  out.matchQuality = result.match_quality || result.matchQuality || r.match_quality || null;
  out.agentHint = result.agent_hint || result.agentHint || r.agent_hint || null;
  out.tokenSavings = result.token_savings || result.tokenSavings || null;
  const mem = r.memory || r.memories;
  const kb = r.knowledge_base || r.knowledgeBase || r.knowledge;
  const conv = r.conversation || r.conversations;
  out.memory = asArray(mem).map((h) => ({ text: hitText(h), score: hitScore(h), id: h.id || h.memory_id || null, raw: h }));
  out.knowledge = asArray(kb).map((h) => ({ text: hitText(h), score: hitScore(h), id: h.id || h.document_id || null, raw: h }));
  out.conversation = asArray(conv).map((h) => ({ text: hitText(h), score: hitScore(h), id: h.id || h.conversation_id || null, raw: h }));
  return out;
}

class RecallDesk {
  constructor(meko, statePath) {
    this.meko = meko;
    this.datapackId = null;
    this.controlConversationId = null;
    this.statePath = statePath || path.join(__dirname, 'data', 'state.json');
    this.state = { seeded: false, seq: 0, tickets: [] };
  }

  loadState() {
    try { this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch (_) { /* fresh */ }
    return this.state;
  }

  saveState() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  async init() {
    await this.meko.initialize();
    // A conversation must exist first: the server requires a conversation_id
    // on nearly every call (even when the tool schema does not list it).
    const conv0 = await this.meko.conversationCreate('RecallDesk control', AGENTS.triage);
    this.controlConversationId = conv0.id || conv0.conversation_id;
    const list = await this.meko.callTool('datapack_list', { conversation_id: this.controlConversationId });
    const packs = asArray(list.datapacks || list);
    const wanted = process.env.MEKO_DATAPACK || '';
    // Datapack objects use datapack_id / datapack_name keys.
    const pickId = (p) => p.datapack_id || p.id;
    const pickName = (p) => p.datapack_name || p.name;
    let def = wanted
      ? packs.find((p) => pickName(p) === wanted || pickId(p) === wanted)
      : packs.find((p) => /default/i.test(pickName(p) || '')) || packs[0];
    if (!def && wanted) {
      const created = await this.meko.callTool('datapack_create', { name: wanted, conversation_id: this.controlConversationId });
      const c = (created && created.datapack) || created;
      if (!pickId(c)) throw new Error(`datapack_create failed: ${JSON.stringify(created).slice(0, 200)}`);
      def = c;
    }
    if (!def) throw new Error('Meko returned no datapacks');
    this.datapackId = pickId(def);
    this.datapackName = pickName(def);
    this.loadState();
    return { datapackId: this.datapackId, datapackName: this.datapackName, packs: packs.length };
  }

  kbCorpusText() {
    return RUNBOOKS.map((f) => fs.readFileSync(path.join(SEED_DIR, f), 'utf8')).join('\n');
  }

  async seed() {
    if (this.state.seeded) return { seeded: true, already: true, uploaded: [] };
    const uploaded = [];
    for (const f of RUNBOOKS) {
      const full = path.join(SEED_DIR, f);
      const r = await this.meko.knowledgeUploadDocument(full, this.controlConversationId, { datapackId: this.datapackId });
      uploaded.push({ file: f, result: r && (r.key || r.state || 'ok') });
    }
    // One charter memory so the desk's purpose is itself remembered.
    await this.meko.memoryAdd(
      'RecallDesk charter: this support desk never solves the same issue twice. When an agent fixes an issue, the fix is saved as a memory; after review it is promoted to shared knowledge so every agent can reuse it.',
      this.controlConversationId,
      { agentId: AGENTS.triage, datapackId: this.datapackId },
    );
    this.state.seeded = true;
    this.saveState();
    return { seeded: true, already: false, uploaded };
  }

  async stuffingBaselineTokens() {
    let text = this.kbCorpusText();
    try {
      const all = await this.meko.memoryGetAll(this.controlConversationId, { datapackId: this.datapackId, pageSize: 100 });
      for (const m of asArray(all.memories || all)) text += '\n' + hitText(m);
    } catch (_) { /* baseline without memories */ }
    return estimateTokens(text);
  }

  async runTicket({ title, body, reporter }) {
    const n = ++this.state.seq;
    const ticket = {
      id: n, title, body: body || '', reporter: reporter || 'customer',
      status: 'new', createdAt: new Date().toISOString(),
      trace: [], answer: null, sources: [], tokens: null, promotion: null,
      memoryId: null, conversationId: null, artifact: null,
    };
    const t0 = Date.now();
    const step = (agent, action, detail, extra = {}) => {
      const s = { agent, action, detail, at: new Date().toISOString(), ms: Date.now() - t0, ...extra };
      ticket.trace.push(s);
      return s;
    };

    // 1. Ticket conversation + triage search.
    const conv = await this.meko.conversationCreate(`Ticket #${n} — ${title}`, AGENTS.triage);
    ticket.conversationId = conv.id || conv.conversation_id;
    const query = `${title}\n${ticket.body}`.trim();
    const search = await this.meko.contextSearch(query, ticket.conversationId, { agentId: AGENTS.triage, datapackId: this.datapackId, limit: 5 });
    const buckets = normBuckets(search);
    // Promoted fixes live in shared knowledge: context_search's knowledge
    // bucket can miss them, so search the knowledge base directly too.
    let kbDirect = [];
    try {
      const kb = await this.meko.knowledgeSearch(query, ticket.conversationId, this.datapackId, { agentId: AGENTS.triage, limit: 5 });
      kbDirect = normBuckets({ results: { knowledge_base: kb } }).knowledge;
    } catch (_) { /* knowledge search is a bonus, not a blocker */ }
    const bestMemory = [...buckets.memory].sort((a, b) => b.score - a.score)[0];
    const bestKb = [...buckets.knowledge, ...kbDirect].sort((a, b) => b.score - a.score)[0];
    const promotedFix = kbDirect.find((h) => /first solved in ticket #\d+/.test(h.text) && h.score >= MEMORY_HIT_SCORE);
    // Third signal: list Meko's promoted fixes directly and match by keyword
    // overlap. Vector search is wording-sensitive; the promoted list is the
    // authoritative "what the team already knows".
    let promotedMatch = null;
    try {
      const fixes = await this.promotedFixes();
      let best = null;
      for (const f of fixes) {
        const ov = keywordOverlap(query, f.text);
        if (!best || ov.count > best.overlap.count) best = { fix: f, overlap: ov };
      }
      if (best && best.overlap.count >= 2) {
        promotedMatch = { text: best.fix.text, id: best.fix.id, score: Math.min(0.95, 0.5 + 0.1 * best.overlap.count), overlap: best.overlap };
      }
    } catch (_) { /* promoted list is a bonus signal */ }
    step('triage', 'context_search', `Searched shared memory, knowledge base and past conversations for "${title}", plus a direct knowledge-base search and the promoted-fixes list.${promotedMatch ? ` Promoted list match: keyword overlap ${promotedMatch.overlap.count} (${promotedMatch.overlap.words.join(', ')}) with an earlier fix.` : ' No promoted fix matched this ticket.'}`, {
      sources: {
        memory: buckets.memory.map((m) => ({ score: m.score, text: m.text.slice(0, 200) })),
        knowledge: [...buckets.knowledge, ...kbDirect].map((k) => ({ score: k.score, text: k.text.slice(0, 200) })),
        conversation: buckets.conversation.map((c) => ({ score: c.score, text: c.text.slice(0, 200) })),
      },
      matchQuality: buckets.matchQuality, agentHint: buckets.agentHint,
      tokenSavings: buckets.tokenSavings,
    });
    await this.meko.conversationAddMessage(ticket.conversationId,
      `New ticket #${n}: ${title} — ${ticket.body}`,
      `Triage searched Meko: ${buckets.memory.length} memory hit(s), ${buckets.knowledge.length} knowledge hit(s), ${buckets.conversation.length} conversation hit(s). Best memory score ${bestMemory ? bestMemory.score.toFixed(2) : 'n/a'}.`,
      { agentId: AGENTS.triage, reasoning: 'Search before solving: if shared memory already holds this fix, reuse it instead of re-solving.', plan: ['context_search', 'route to recall or solve'] });

    const baselineTokens = await this.stuffingBaselineTokens();
    const fromMemory = bestMemory && bestMemory.score >= MEMORY_HIT_SCORE;
    const fromShared = !fromMemory && (promotedFix || promotedMatch);
    const recallHit = fromMemory ? bestMemory : (fromShared ? (promotedFix || promotedMatch) : null);
    const recallKind = fromMemory ? 'memory' : (fromShared ? 'shared-knowledge' : null);

    if (recallHit) {
      // 2a. RECALL PATH — resolve from shared memory, cite the original fix.
      const slice = `Earlier fix (${recallKind === 'memory' ? 'shared memory' : 'shared knowledge, promoted after review'}, score ${recallHit.score.toFixed(2)}):\n${recallHit.text}\nRelated runbook passage:\n${bestKb && bestKb !== recallHit ? bestKb.text.slice(0, 800) : '(same source)'}`;
      const prompt = `You are a support agent on RecallDesk. A customer reports:\n"${title}\n${ticket.body}"\n\nShared context already holds a fix for this exact issue:\n${slice}\n\nReply in exactly this format:\nANSWER: <2-4 sentences for the customer, using the remembered fix and saying it was solved before>\nCITATION: <which earlier fix, in one line>`;
      const r = await chat({ prompt, maxTokens: 1024 });
      const m = /ANSWER:\s*([\s\S]*?)\nCITATION:\s*(.*)/.exec(r.text);
      ticket.answer = m ? m[1].trim() : r.text;
      ticket.sources = [{ kind: recallKind, score: recallHit.score, text: recallHit.text, id: recallHit.id },
        ...(bestKb && bestKb !== recallHit ? [{ kind: 'knowledge', score: bestKb.score, text: bestKb.text.slice(0, 300) }] : [])];
      ticket.status = 'resolved-from-memory';
      ticket.tokens = { groq: r.usage, slice: estimateTokens(slice), baseline: baselineTokens, savedPct: Math.max(0, Math.round(100 * (1 - estimateTokens(slice) / Math.max(1, baselineTokens)))) };
      step('resolver', 'resolve-from-memory', `Answered from ${recallKind} (score ${recallHit.score.toFixed(2)}) — no re-solve, no new fix written. Cited: ${(m && m[2].trim()) || 'earlier fix'}.`, { tokens: r.usage });
      await this.meko.conversationAddMessage(ticket.conversationId, `Resolver: recall path for ticket #${n}`,
        ticket.answer, { agentId: AGENTS.resolver, reasoning: `${recallKind === 'memory' ? 'Shared memory' : 'Shared knowledge'} hit (score ${recallHit.score.toFixed(2)}) — reuse the remembered fix instead of solving again.`, plan: ['cite earlier fix', 'answer customer'] });
    } else {
      // 2b. SOLVE PATH — resolver solves from runbook context, then learns.
      const kbText = buckets.knowledge.map((k) => k.text).join('\n---\n').slice(0, 3000) || '(no runbook passage found)';
      const prompt = `You are a support agent on RecallDesk. A customer reports:\n"${title}\n${ticket.body}"\n\nRelevant runbook passages from the knowledge base:\n${kbText}\n\nNo earlier fix exists in shared memory — solve it now. Reply in exactly this format:\nDIAGNOSIS: <one line>\nFIX:\n- <step>\n- <step>\n- <step>\nVERIFY: <how to check the fix worked>`;
      const r = await chat({ prompt, maxTokens: 2048 });
      const d = /DIAGNOSIS:\s*(.*)/.exec(r.text);
      const f = /FIX:\s*([\s\S]*?)\nVERIFY:/.exec(r.text);
      const v = /VERIFY:\s*(.*)/.exec(r.text);
      const fixText = `FIX for "${title}": ${d ? d[1].trim() : ''} ${(f ? f[1].replace(/\n/g, ' ').trim() : r.text.replace(/\n/g, ' ').slice(0, 400))} Verify: ${v ? v[1].trim() : ''} (first solved in ticket #${n})`;
      ticket.answer = r.text;
      ticket.sources = buckets.knowledge.map((k) => ({ kind: 'knowledge', score: k.score, text: k.text.slice(0, 300) }));
      ticket.status = 'resolved-new';
      ticket.tokens = { groq: r.usage, slice: estimateTokens(kbText), baseline: baselineTokens, savedPct: Math.max(0, Math.round(100 * (1 - estimateTokens(kbText) / Math.max(1, baselineTokens)))) };
      step('resolver', 'solve-new', `No memory hit — solved from runbook context. Diagnosis: ${d ? d[1].trim() : '(see answer)'}.`, { tokens: r.usage });
      await this.meko.conversationAddMessage(ticket.conversationId, `Resolver: solve path for ticket #${n}`, r.text,
        { agentId: AGENTS.resolver, reasoning: 'No shared-memory hit, so solve from the runbook and then learn the fix so the next agent does not repeat this work.', plan: ['solve from runbook', 'save fix as memory', 'review + promote'] });

      // 3. Learn: save the fix as a memory + artifact, then review.
      const mem = await this.meko.memoryAdd(fixText, ticket.conversationId, { agentId: AGENTS.resolver, datapackId: this.datapackId, metadata: { ticket: n, kind: 'fix' } });
      const memRows = asArray((mem && mem.results) || mem);
      ticket.memoryId = (memRows[0] && memRows[0].id) || null;
      const report = `# Fix report — Ticket #${n}: ${title}\n\nReporter: ${ticket.reporter}\nDate: ${ticket.createdAt}\n\n## Diagnosis\n${d ? d[1].trim() : ''}\n\n## Fix\n${f ? f[1].trim() : r.text}\n\n## Verify\n${v ? v[1].trim() : ''}\n\n## Sources\n${ticket.sources.map((s) => `- [${s.kind} score ${s.score.toFixed(2)}] ${s.text.slice(0, 160)}`).join('\n')}\n\n## Tokens\nGroq: ${r.usage.total} total (prompt ${r.usage.prompt}, completion ${r.usage.completion}). Context sent: ${ticket.tokens.slice} tokens vs ${ticket.tokens.baseline} if the whole corpus had been stuffed (${ticket.tokens.savedPct}% saved).\n`;
      const art = await this.meko.artifactPut(`fix-report-ticket-${n}.md`, report, ticket.conversationId, { agentId: AGENTS.resolver, datapackId: this.datapackId });
      ticket.artifact = (art && (art.content_hash || art.hash || art.key)) || `fix-report-ticket-${n}.md`;
      step('resolver', 'learn-fix', `Saved the fix as a private memory${ticket.memoryId ? ` (${ticket.memoryId})` : ''} and stored the fix report as an artifact. It is NOT shared yet — promotion needs review.`, {});

      const rev = await chat({
        prompt: `You are a support reviewer on RecallDesk. A resolver fixed this ticket:\n"${title}\n${ticket.body}"\n\nThe verified runbook says:\n${kbText}\n\nProposed fix:\n${r.text}\n\nCompare the proposed fix with the runbook's verified fix. APPROVED if it matches the runbook fix, is a reasonable equivalent, or is safe and specific even without an exact match. NEEDS_WORK only if it contradicts the runbook, misses the root cause, or is unsafe or vague. Reply in exactly this format:\nVERDICT: APPROVED or NEEDS_WORK\nREASON: <one line>`,
        maxTokens: 512,
      });
      const verdict = /VERDICT:\s*(APPROVED|NEEDS_WORK)/.exec(rev.text);
      const reason = /REASON:\s*(.*)/.exec(rev.text);
      const approved = verdict && verdict[1] === 'APPROVED';
      ticket.promotion = approved ? 'pending' : 'rejected';
      const reasonText = reason ? reason[1].trim() : rev.text.replace(/VERDICT:\s*(APPROVED|NEEDS_WORK)\s*/i, '').trim().slice(0, 160);
      step('reviewer', 'review-fix', `Reviewer verdict: ${approved ? 'APPROVED' : 'NEEDS_WORK'} — ${reasonText}. ${approved ? 'Fix waits in the promotion queue for a human to promote it to shared knowledge.' : 'Fix stays private; it will not be promoted.'}`, { tokens: rev.usage });
      await this.meko.conversationAddMessage(ticket.conversationId, `Reviewer: ${approved ? 'APPROVED' : 'NEEDS_WORK'} ticket #${n}`,
        rev.text, { agentId: AGENTS.reviewer, reasoning: 'A fix only becomes shared knowledge after review — the promotion gate keeps bad fixes out of the shared store.', plan: ['review fix', approved ? 'queue for promotion' : 'keep private'] });
      if (ticket.tokens) ticket.tokens.groqTotal = r.usage.total + rev.usage.total;
    }

    this.state.tickets.push(ticket);
    this.saveState();
    return ticket;
  }

  async promote(ticketId) {
    const ticket = this.state.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new Error(`no ticket #${ticketId}`);
    if (!ticket.memoryId) throw new Error(`ticket #${ticketId} has no saved memory to promote`);
    if (ticket.promotion === 'promoted') return { already: true, ticket };
    const r = await this.meko.memoryPromote([ticket.memoryId], ticket.conversationId, { agentId: AGENTS.reviewer, datapackId: this.datapackId });
    ticket.promotion = 'promoted';
    ticket.trace.push({ agent: 'human', action: 'promote-to-shared', detail: 'Human approved: the fix moved from private memory into shared knowledge — every agent can now retrieve it.', at: new Date().toISOString(), ms: 0 });
    this.saveState();
    return { promoted: true, result: r, ticket };
  }

  async promotedFixes() {
    const res = await this.meko.memoryGetAll(this.controlConversationId, { datapackId: this.datapackId, promoted: true, pageSize: 100 });
    const rows = asArray(res.promoted_memories || res.memories || res);
    return rows.map((m) => {
      let o = m;
      if (typeof o === 'string') { try { o = JSON.parse(o); } catch (_) { o = { data: m }; } }
      return { id: o.id || o.memory_id, text: o.data || o.memory || o.text || '' };
    }).filter((f) => f.text);
  }

  async memoryPanel() {
    const all = await this.meko.memoryGetAll(this.controlConversationId, { datapackId: this.datapackId, pageSize: 100 });
    const promoted = await this.meko.memoryGetAll(this.controlConversationId, { datapackId: this.datapackId, promoted: true, pageSize: 100 });
    let metrics = null;
    try { metrics = await this.meko.metrics(30, this.controlConversationId); } catch (_) { /* metrics optional */ }
    const norm = (res) => asArray(res.memories || res).map((m) => {
      // memory_get_all returns each memory as a JSON *string* of the object.
      let o = m;
      if (typeof o === 'string') { try { o = JSON.parse(o); } catch (_) { o = { data: m }; } }
      return { id: o.id || o.memory_id, text: o.data || o.memory || o.text || '', created: o.created_at || o.createdAt || null };
    });
    return { memories: norm(all), promoted: norm(promoted), metrics, datapackId: this.datapackId };
  }
}

module.exports = { RecallDesk, AGENTS, RUNBOOKS };
