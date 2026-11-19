# RecallDesk — Concept

**ContextCon (HackerEarth / YugabyteDB Meko) — Theme 02: Agentic support — "Never Solve It Twice"**

## The problem

Every support team re-solves the same issues. A customer reports "login hangs on slow network" in March; another reports "can't sign in, screen just hangs" in April. A human agent who remembers the March fix answers in a minute. An AI agent without shared memory starts from zero — it re-reads the runbooks, re-diagnoses, re-writes the same fix, and burns the same tokens. Multiply by every repeated issue and you pay for the same thinking forever.

## The idea

**RecallDesk** is a support-desk team of three agents that share **one Meko datapack** as their single memory:

- **Triage** — reads the ticket, searches Meko *before* anyone solves anything: `context_search` (memory + knowledge + past conversations), a direct `knowledgebase_search`, and the list of **promoted fixes**. If the team already knows this fix, the ticket never gets re-solved.
- **Resolver** — solves from the runbook when the fix is new, or **answers from shared memory** when it is known — citing the earlier ticket, with the token savings shown.
- **Reviewer** — checks the proposed fix against the verified runbook. Approved fixes wait in a **promotion queue**; a human clicks **Promote** and the fix moves from private memory into shared knowledge (`memory_promote`), where every agent can retrieve it.

## Why this wins on the judging weights

- **Meko use (30%)** — Meko is not a side feature; it is the product. Every ticket runs `context_search`, `memory_search`, `knowledgebase_search`, `memory_add`, `memory_promote`, `knowledgebase_upload_document`, `conversation_add_message` (with reasoning + plan, i.e. decision traces), `artifact_add`, and `datapack_metrics`. No ticket can be solved without touching Meko.
- **Impact (25%)** — the token-savings meter is the impact, measured live: a recalled ticket costs ~65–90% fewer tokens than a cold solve (verified in the demo: 69% on the first recall run, 65% on the clean re-run). In a real desk, that is money and latency on every repeated issue.
- **Technical (20%)** — real MCP client over SSE/JSON, real Groq model, zero-dependency Node server, 6 automated tests against the live Meko engine.
- **Innovation (15%)** — the promotion gate: private memory → human review → shared knowledge. Fixes are not auto-trusted; they are earned, and the trace shows exactly why.
- **Presentation (10%)** — a guided 4-step demo in the UI: seed → cold solve → promote → recall. The whole story in under two minutes.

## The demo story (60–90 seconds)

1. **Seed** — three verified runbooks (login timeout, stale notifications, dashboard counts) go into the shared datapack.
2. **Ticket #1** — "Login page times out on slow network." Cold solve: triage finds no memory, resolver fixes it from the runbook, reviewer approves, the fix sits in the promotion queue.
3. **Promote** — one click moves the fix into shared knowledge.
4. **Ticket #2** — "Users can't sign in — the login screen just hangs." Same root cause, different words. Triage finds the promoted fix, resolver answers from memory, **no new fix is written**, token savings shown: ~65%.

## Architecture

```
browser UI (public/index.html)
   │  REST
Node server (server.js, no deps)
   ├─ agents.js — RecallDesk: triage / resolver / reviewer
   ├─ meko.js   — MCP client (SSE + JSON) to Meko Local or Meko Cloud
   └─ groq.js   — Groq chat (free openai/gpt-oss-20b)
Meko datapack "recalldesk-demo" — memories, knowledge, traces, artifacts
```

## What is fictional, what is real

- **Real:** every Meko call, every Groq call, every token count, every trace line, the promotion, the recall, the savings meter. The tests run against the live engine.
- **Fictional:** the product ("Northwind"), the tickets, the runbooks. They are realistic support content, not a real company's data.

## Costs

$0. Meko Local is free, Meko Cloud has a free tier, Groq `openai/gpt-oss-20b` is free. No paid keys anywhere.
