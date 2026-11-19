# RecallDesk — Never Solve It Twice

A support-desk agent team that remembers. Built for **ContextCon** (HackerEarth / YugabyteDB Meko) — Theme 02: *Agentic support*.

If one agent fixed an issue yesterday, every agent knows it today — because all of them share **one Meko datapack** as their memory.

[![ContextCon](https://img.shields.io/badge/ContextCon-2027-blue)](https://www.hackerearth.com/lp/challenges/contextcon)
[![Meko](https://img.shields.io/badge/context-Meko-7c3aed)](https://mekodata.ai)
[![Model](https://img.shields.io/badge/model-Groq%20gpt--oss--20b-orange)](https://groq.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The demo (90 seconds)

1. **Seed** — three verified runbooks go into the shared Meko datapack.
2. **Ticket #1** — "Login page times out on slow network." Cold solve: triage finds no memory, the resolver fixes it from the runbook, the reviewer approves, the fix waits in the promotion queue.
3. **Promote** — one click moves the fix from private memory into shared knowledge (`memory_promote`).
4. **Ticket #2** — "Users can't sign in — the login screen just hangs." Same root cause, different words. Triage finds the promoted fix, the resolver answers from memory, **no new fix is written**. Token savings: ~65%.

## How it works

Three agents, one shared datapack:

| Agent | Job |
|---|---|
| **Triage** | Searches Meko *before* anyone solves: `context_search` (memory + knowledge + conversations), a direct `knowledgebase_search`, and the promoted-fixes list. |
| **Resolver** | Solves from the runbook when the fix is new; answers **from shared memory** when it is known — citing the earlier ticket. |
| **Reviewer** | Checks the fix against the verified runbook. Approved fixes wait for a human to promote them. |

The **promotion gate** is the point: a fix is private memory until a human promotes it into shared knowledge. Fixes are earned, not auto-trusted — and every step is recorded as a decision trace in Meko (`conversation_add_message` with reasoning + plan).

## Meko calls used

`context_search` · `memory_add` · `memory_search` · `memory_get_all` · `memory_promote` · `knowledgebase_upload_document` · `knowledgebase_search` · `knowledgebase_document_status` · `conversation_create` · `conversation_add_message` · `artifact_add` · `datapack_list` · `datapack_create` · `datapack_metrics`

## Run it

```bash
# 1. Meko Local (free, no account) — https://mekodata.ai
curl -fsSL https://mekodata.ai/install.sh -o /tmp/meko-install.sh
bash /tmp/meko-install.sh
meko start

# 2. A free Groq key — https://console.groq.com
export GROQ_API_KEY=gsk_...

# 3. RecallDesk (Node 20+, zero dependencies)
node server.js
# open http://localhost:8787 — click Seed, then run the guided demo
```

Config: `MEKO_URL` (default `http://127.0.0.1:7777/mcp`), `MEKO_API_KEY` (Meko Cloud, optional), `MEKO_DATAPACK` (default `recalldesk-demo`), `PORT` (default `8787`), `GROQ_MODEL` (default `openai/gpt-oss-20b`).

## Tests

```bash
node --test tests/meko.test.js tests/flow.test.js
```

6 tests against the live Meko engine + live Groq, in scratch datapacks (deleted afterwards): MCP round-trips, memory add/search, knowledge upload/search, promote, and the full seed → cold solve → promote → recall flow.

## Files

- `server.js` — plain `node:http` server, no dependencies
- `agents.js` — the three-agent RecallDesk team + promotion gate + token meter
- `meko.js` — MCP client (SSE + JSON) for Meko Local / Cloud
- `groq.js` — Groq chat client (free `openai/gpt-oss-20b`)
- `public/` — the demo UI (vanilla HTML/CSS/JS)
- `seed/` — three fictional runbooks
- `tests/` — automated tests

## License

MIT — see [LICENSE](LICENSE).
