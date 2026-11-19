// Full RecallDesk flow test: seed -> cold solve -> promote -> recall.
// Proves "never solve it twice" against real Meko + real Groq.
// Run: node --test tests/
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MekoClient } = require('../meko');
const { RecallDesk } = require('../agents');

process.env.MEKO_DATAPACK = 'recalldesk-test-flow';

let meko;
let desk;
const TEST_STATE = path.join(__dirname, 'state.test.json');

async function getDesk() {
  if (desk) return desk;
  meko = new MekoClient();
  desk = new RecallDesk(meko, TEST_STATE);
  await desk.init();
  return desk;
}

after(async () => {
  try {
    const d = await getDesk();
    await meko.callTool('datapack_delete', { datapack_id: d.datapackId, conversation_id: d.controlConversationId });
  } catch (_) { /* already gone */ }
  try { fs.unlinkSync(TEST_STATE); } catch (_) { /* no state */ }
});

test('flow: seed, cold solve, promote, recall', async () => {
  const d = await getDesk();
  // Fresh state for this datapack.
  d.state = { seeded: false, seq: 0, tickets: [] };
  d.saveState();

  const seed = await d.seed();
  assert.equal(seed.seeded, true);
  assert.equal(seed.uploaded.length, 3, 'three runbooks uploaded');

  const t1 = await d.runTicket({
    title: 'Login page times out on slow network',
    body: 'Reported by QA: the login page hangs for more than 30 seconds on a slow 3G connection and eventually times out.',
    reporter: 'QA team',
  });
  assert.equal(t1.status, 'resolved-new', 'first ticket is a cold solve');
  assert.ok(t1.memoryId, 'fix saved as a memory');
  assert.ok(t1.trace.some((s) => s.action === 'context_search'), 'triage searched Meko');
  assert.ok(t1.sources.some((s) => s.kind === 'knowledge'), 'resolver used a runbook passage');
  assert.equal(t1.promotion, 'pending', 'reviewer approved the fix for promotion');

  const p = await d.promote(t1.id);
  assert.equal(p.promoted, true);
  assert.equal(p.ticket.promotion, 'promoted');

  const t2 = await d.runTicket({
    title: "Users can't sign in — the login screen just hangs",
    body: 'Several users on slow connections cannot sign in at all; the login screen hangs and never completes.',
    reporter: 'Support inbox',
  });
  assert.equal(t2.status, 'resolved-from-memory', 'second ticket resolves from shared knowledge');
  assert.ok(t2.sources.some((s) => s.kind === 'shared-knowledge'), 'recall cites shared knowledge');
  assert.ok(t2.answer.toLowerCase().includes('timeout'), 'answer reuses the remembered fix (timeout)');
  assert.ok(/retry|45|back-off|backoff/.test(t2.answer.toLowerCase()), 'answer reuses the remembered fix (retry/45s)');
  assert.ok(t2.tokens.savedPct > 0, 'token savings recorded');
  assert.equal(t2.promotion, null, 'recall path writes no new fix');
});
