// Groq chat. Two routes (in order):
//   1. The registered custom.groq connector helper (default here) — the helper
//      carries the credential, this file never sees or stores the real key.
//   2. GROQ_API_KEY env var (public-repo route): a free Groq key from
//      console.groq.com, called directly over HTTPS. No key? Route 1 only.
// Env: GROQ_MODEL (default openai/gpt-oss-20b), GROQ_HELPER path.
'use strict';

const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

const HELPER = process.env.GROQ_HELPER
  || path.join(os.homedir(), 'workspace/custom-connectors/custom.groq/bin/groq.py');
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

function parseUsage(stderr) {
  const m = /usage\s+prompt=(\d+)\s+completion=(\d+)\s+total=(\d+)/.exec(stderr || '');
  if (!m) return { prompt: 0, completion: 0, total: 0 };
  return { prompt: Number(m[1]), completion: Number(m[2]), total: Number(m[3]) };
}

// Rough token estimate for text we did NOT send to the model (baseline math).
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

async function chatViaApi({ model, prompt, maxTokens }) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`Groq API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return { text: (d.choices?.[0]?.message?.content || '').trim(), usage: d.usage || { prompt: 0, completion: 0, total: 0 }, model };
}

function chat({ model = DEFAULT_MODEL, prompt, maxTokens = 2048, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!prompt || !prompt.trim()) return reject(new Error('groq.chat: empty prompt'));
    if (process.env.GROQ_API_KEY) { chatViaApi({ model, prompt, maxTokens }).then(resolve, reject); return; }
    execFile('python3', [HELPER, 'chat', '--model', model, '--prompt', prompt, '--max-tokens', String(maxTokens)],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`groq.chat failed (${model}): ${err.message} :: ${(stderr || '').slice(0, 300)}`));
        resolve({ text: (stdout || '').trim(), usage: parseUsage(stderr || ''), model });
      });
  });
}

module.exports = { chat, estimateTokens, DEFAULT_MODEL };
