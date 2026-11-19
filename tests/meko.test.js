// RecallDesk tests — hit the real Meko Local server + real Groq (both free).
// Uses a scratch datapack "recalldesk-test", deleted afterwards.
// Run: node --test tests/
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MekoClient } = require('../meko');
const { chat } = require('../groq');
const { RecallDesk } = require('../agents');

process.env.MEKO_DATAPACK = 'recalldesk-test-meko';

let meko;
let convId;
let dpId;
const DP = 'recalldesk-test-meko';

before(async () => {
  meko = new MekoClient();
  await meko.initialize();
  const c = await meko.conversationCreate('tests', 'recalldesk:test');
  convId = c.id || c.conversation_id;
  assert.ok(convId, 'control conversation created');
  // Create the scratch datapack if it does not exist yet; keep its UUID
  // (Meko tools want the id, not the name).
  const list = await meko.callTool('datapack_list', { conversation_id: convId });
  const packs = Array.isArray(list) ? list : (list.datapacks || []);
  const existing = packs.find((p) => (p.datapack_name || p.name) === DP);
  if (existing) {
    dpId = existing.datapack_id || existing.id;
  } else {
    const created = await meko.callTool('datapack_create', { name: DP, conversation_id: convId });
    dpId = (created && (created.datapack_id || created.id)) || null;
  }
  assert.ok(dpId, 'scratch datapack id');
});

after(async () => {
  try { await meko.callTool('datapack_delete', { datapack_id: dpId, conversation_id: convId }); } catch (_) { /* already gone */ }
});

test('meko: initialize + datapack list', async () => {
  const list = await meko.callTool('datapack_list', { conversation_id: convId });
  const packs = Array.isArray(list) ? list : (list.datapacks || []);
  assert.ok(packs.length >= 1, 'at least one datapack exists');
});

test('groq: chat returns text + usage', async () => {
  const r = await chat({ prompt: 'Reply with exactly: OK', maxTokens: 128 });
  assert.match(r.text, /OK/);
  assert.ok(r.usage.total > 0, 'usage reported');
});

test('meko: memory round-trip (add -> search)', async () => {
  const marker = `TESTMARKER-${Date.now()}`;
  await meko.memoryAdd(`Test fact ${marker}: the test depot is on level three.`, convId, { agentId: 'recalldesk:test', datapackId: dpId });
  const found = await meko.memorySearch(`test depot ${marker}`, convId, { agentId: 'recalldesk:test', datapackId: dpId });
  const rows = found.results || [];
  assert.ok(rows.some((m) => (m.memory || m.text || '').includes(marker)), 'memory_search finds the added fact');
});

test('meko: knowledge upload + search', async () => {
  const tmp = path.join(__dirname, 'kb-probe.md');
  fs.writeFileSync(tmp, '# Probe doc\n\nThe zebra crossing code is ZEBRA-42. Never paint it blue.\n');
  try {
    const up = await meko.knowledgeUploadDocument(tmp, convId, { datapackId: dpId });
    assert.ok(up.key || up.state === 'completed', 'upload completed');
    const hits = await meko.knowledgeSearch('zebra crossing code', convId, dpId, { agentId: 'recalldesk:test' });
    const rows = hits.results || [];
    assert.ok(rows.some((h) => (h.chunk_text || '').includes('ZEBRA-42')), 'knowledge search finds the uploaded doc');
  } finally { fs.unlinkSync(tmp); }
});

test('meko: promote moves a memory to shared knowledge', async () => {
  const added = await meko.memoryAdd('Test promotion fact: the vault code is VAULT-7.', convId, { agentId: 'recalldesk:test', datapackId: dpId });
  const rows = added.results || [];
  assert.ok(rows[0] && rows[0].id, 'memory_add returns an id');
  await meko.memoryPromote([rows[0].id], convId, { agentId: 'recalldesk:test', datapackId: dpId });
  const desk = new RecallDesk(meko);
  desk.datapackId = dpId;
  desk.controlConversationId = convId;
  const fixes = await desk.promotedFixes();
  assert.ok(fixes.some((f) => f.text.includes('VAULT-7')), 'promoted fix appears in the promoted list');
});
