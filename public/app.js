// RecallDesk UI — talks only to this server's /api (which talks to Meko + Groq).
'use strict';

const $ = (s) => document.querySelector(s);
let tickets = [];
let selectedId = null;
let busy = false;

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function badge(t) {
  if (t.status === 'resolved-from-memory') return '<span class="badge memory">resolved from memory</span>';
  if (t.status === 'resolved-new') return '<span class="badge new">solved new</span>';
  return `<span class="badge">${esc(t.status)}</span>`;
}

function renderTickets() {
  const ul = $('#ticket-list');
  if (!tickets.length) { ul.innerHTML = '<li class="muted">No tickets yet.</li>'; return; }
  ul.innerHTML = tickets.map((t) => `<li data-id="${t.id}" class="${t.id === selectedId ? 'sel' : ''}"><b>#${t.id} ${esc(t.title)}</b><br>${badge(t)} <span class="muted">${esc(t.reporter)} · ${new Date(t.createdAt).toLocaleString()}</span></li>`).join('');
  ul.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => { selectedId = Number(li.dataset.id); renderTickets(); renderDetail(); }));
}

function renderDetail() {
  const t = tickets.find((x) => x.id === selectedId);
  const d = $('#detail');
  if (!t) { d.hidden = true; return; }
  d.hidden = false;
  $('#d-title').textContent = `#${t.id} — ${t.title}`;
  $('#d-badge').outerHTML = `<span id="d-badge">${badge(t)}${t.promotion ? ` <span class="badge ${t.promotion}">${t.promotion === 'promoted' ? 'shared knowledge' : 'promotion ' + t.promotion}</span>` : ''}</span>`;
  $('#d-meta').textContent = `${t.reporter} · ${new Date(t.createdAt).toLocaleString()} · conversation ${t.conversationId || '—'}`;
  $('#d-answer').textContent = t.answer || '(no answer yet)';
  $('#d-trace').innerHTML = t.trace.map((s) => {
    const src = s.sources ? Object.entries(s.sources).map(([k, arr]) => arr.length ? `<div class="src"><b>${esc(k)}:</b> ${arr.map((h) => `<code>score ${Number(h.score).toFixed(2)}</code> ${esc((h.text || '').slice(0, 160))}`).join('<br>')}</div>` : '').join('') : '';
    const tok = s.tokens ? `<div class="src">Groq tokens: ${s.tokens.total} (prompt ${s.tokens.prompt}, completion ${s.tokens.completion})</div>` : '';
    return `<li><span class="who">${esc(s.agent)}</span> — ${esc(s.action)} <span class="muted">(${s.ms} ms)</span><br>${esc(s.detail)}${src}${tok}</li>`;
  }).join('');
  const tk = t.tokens;
  $('#d-tokens').innerHTML = tk
    ? `<p>Context sent to the model: <b>${tk.slice} tokens</b> vs <b>${tk.baseline} tokens</b> if the whole corpus had been stuffed into the prompt.</p>
       <div class="bar"><div style="width:${Math.max(2, Math.round(100 * tk.slice / Math.max(1, tk.baseline)))}%"></div></div>
       <p><b>${tk.savedPct}% fewer tokens</b> thanks to Meko retrieval · Groq used ${tk.groqTotal || tk.groq.total} tokens in total for this ticket.</p>`
    : '<p class="muted">Token data appears after the agent team runs.</p>';
}

async function refreshMemory() {
  try {
    const p = await api('/api/memory');
    $('#mem-count').textContent = `(${p.memories.length} memories · ${p.promoted.length} promoted)`;
    const m = p.metrics;
    const ce = m && m.context_efficiency;
    $('#metrics').innerHTML = ce
      ? `<div><b>${ce.saved_pct}%</b>Meko token savings</div><div><b>${Number(ce.tokens_saved || 0).toLocaleString()}</b>tokens saved</div><div><b>${p.memories.length}</b>memories · <b>${p.promoted.length}</b> promoted</div>`
      : `<div><b>${p.memories.length}</b>memories</div><div><b>${p.promoted.length}</b>promoted to shared knowledge</div>`;
    $('#memory-list').innerHTML = p.memories.length
      ? p.memories.slice(0, 12).map((x) => `<li>${esc(x.text.slice(0, 220))}</li>`).join('')
      : '<li class="muted">No memories yet — seed the desk first.</li>';
    const pending = tickets.filter((t) => t.promotion === 'pending');
    $('#promo-list').innerHTML = pending.length
      ? pending.map((t) => `<li>#${t.id} ${esc(t.title)} <button data-promote="${t.id}">Approve &amp; promote</button></li>`).join('')
      : '<li class="muted">Nothing waiting for promotion.</li>';
    document.querySelectorAll('[data-promote]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      await api(`/api/tickets/${b.dataset.promote}/promote`, 'POST');
      await loadTickets(); await refreshMemory();
    }));
  } catch (e) { $('#metrics').textContent = 'Memory panel failed: ' + e.message; }
}

async function loadTickets() {
  const j = await api('/api/tickets');
  tickets = j.tickets || [];
  renderTickets();
  if (selectedId) renderDetail();
  $('#btn-promote').disabled = !tickets.some((t) => t.promotion === 'pending');
}

async function runTicket(title, body, reporter) {
  if (busy) return null;
  busy = true;
  $('#form-status').textContent = 'Agent team is working — triage → search → resolve → review…';
  try {
    const j = await api('/api/tickets', 'POST', { title, body, reporter });
    await loadTickets();
    selectedId = j.ticket.id;
    renderTickets(); renderDetail(); await refreshMemory();
    $('#form-status').textContent = `Ticket #${j.ticket.id}: ${j.ticket.status.replace(/-/g, ' ')}.`;
    return j.ticket;
  } catch (e) { $('#form-status').textContent = 'Failed: ' + e.message; return null; }
  finally { busy = false; }
}

$('#btn-seed').addEventListener('click', async () => {
  $('#seed-status').textContent = 'Seeding…';
  try {
    const j = await api('/api/seed', 'POST');
    $('#seed-status').textContent = j.already ? 'Already seeded.' : `Seeded ${j.uploaded.length} runbooks into Meko's knowledge base.`;
    await refreshMemory();
  } catch (e) { $('#seed-status').textContent = 'Seed failed: ' + e.message; }
});

$('#btn-t1').addEventListener('click', () => runTicket('Login page times out on slow network', 'Reported by QA: the login page hangs for more than 30 seconds on a slow 3G connection and eventually times out.', 'QA team'));

$('#btn-promote').addEventListener('click', async () => {
  const t = tickets.find((x) => x.promotion === 'pending');
  if (!t) return;
  await api(`/api/tickets/${t.id}/promote`, 'POST');
  await loadTickets(); await refreshMemory();
});

$('#btn-t2').addEventListener('click', () => runTicket("Users can't sign in — the login screen just hangs", 'Several users on slow connections cannot sign in at all; the login screen hangs and never completes.', 'Support inbox'));

$('#ticket-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#f-title').value.trim();
  if (!title) return;
  runTicket(title, $('#f-body').value.trim(), $('#f-reporter').value.trim() || 'customer');
  e.target.reset();
});

$('#btn-refresh-mem').addEventListener('click', refreshMemory);

(async () => {
  try {
    const h = await api('/api/health');
    $('#health').textContent = h.error ? 'Meko: error' : `Meko: ${h.cloud ? 'Cloud' : 'Local'} · datapack ${h.datapackName || h.datapackId || '?'}`;
    $('#health').classList.toggle('bad', !!h.error);
  } catch (e) { $('#health').textContent = 'Meko: unreachable'; $('#health').classList.add('bad'); }
  await loadTickets();
  await refreshMemory();
})();
