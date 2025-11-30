import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { asrConfigured, transcribeWebmOpus } from './asr.js';

dotenv.config();

const PORT = process.env.PORT || 8787;
const BRIDGE_MODEL = process.env.BRIDGE_MODEL || 'gpt-4o-mini';
// GEMINI_API_KEY is expected in process.env for the bridge script
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS || 10000);
const FRESH_MS = Number(process.env.FRESH_MS || 20000);
const WINDOW_MS = Number(process.env.WINDOW_MS || 60000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultBridgePath = path.resolve(__dirname, '../../scripts/bridge-cli.mjs');
const geminiBridgePath = path.resolve(__dirname, '../../scripts/bridge-gemini.mjs');

const BRIDGE_RUN_CMD = process.env.BRIDGE_RUN_CMD || 'node';
function resolveBridgeArgs() {
  const envArgs = process.env.BRIDGE_RUN_ARGS;
  if (!envArgs) return [defaultBridgePath];
  const parts = envArgs.split(' ').filter(Boolean);
  if (parts.length === 0) return [defaultBridgePath];
  let first = parts[0];
  if (!path.isAbsolute(first)) {
    const candidate = path.resolve(__dirname, '../../', first);
    if (fs.existsSync(candidate)) first = candidate;
  }
  if (!fs.existsSync(first)) {
    first = defaultBridgePath;
  }
  return [first, ...parts.slice(1)];
}
const BRIDGE_RUN_ARGS = resolveBridgeArgs();

console.log('[bridge] mode: CLI');
console.log(`[bridge] runner: ${BRIDGE_RUN_CMD} ${BRIDGE_RUN_ARGS.join(' ')}`);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));

// In-memory session store
const sessions = new Map();

function newSession({ provider = 'codex', model } = {}) {
  const id = uuidv4();
  const s = {
    id,
    startedAt: Date.now(),
    segments: [], // { text, timestampMs }
    lastTickIndex: 0,
    clients: new Set(), // SSE responses
    tickPrompt: null,
    interval: null,
    suggestions: [], // history of AI suggestions
    provider,
    model: model || (provider === 'gemini' ? GEMINI_MODEL : BRIDGE_MODEL)
  };
  sessions.set(id, s);
  return s;
}

function getSession(id) {
  return sessions.get(id);
}

function normalizeSegmentText(text) {
  try {
    let t = String(text || '')
    t = t.replace(/\s+/g, ' ').trim()
    // collapse repeated words: "how how how" -> "how"
    t = t.replace(/\b(\w[\w'-]*)\b(?:\s+\1\b){1,}/gi, '$1')
    // light de-dup of short repeated phrases (2–3 words)
    const dedupPhrase = (s, n) => s.replace(new RegExp(`\\b((?:\\w[\\w'-]*\\s+){${n-1}}\\w[\\w'-]*)\\b(?:\\s+\\1\\b){1,}`, 'gi'), '$1')
    t = dedupPhrase(t, 2)
    t = dedupPhrase(t, 3)
    return t
  } catch {
    return String(text || '')
  }
}

function appendSegments(session, incoming) {
  const arr = Array.isArray(incoming) ? incoming : [incoming];
  for (const seg of arr) {
    if (!seg || !seg.text) continue;
    const cleaned = normalizeSegmentText(seg.text)
    if (!cleaned) continue;
    let ts;
    if (typeof seg.timestampMs === 'number') {
      // If client sent epoch ms, convert to session-relative
      if (seg.timestampMs > 1e11) {
        ts = seg.timestampMs - session.startedAt;
      } else {
        ts = seg.timestampMs;
      }
    } else {
      ts = Date.now() - session.startedAt;
    }
    session.segments.push({ text: cleaned, timestampMs: ts });
  }
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function runTick(session) {
  try {
    const nowElapsed = Date.now() - session.startedAt;
    const freshExcerpt = buildExcerpt(session, nowElapsed - FRESH_MS, nowElapsed);
    const contextExcerpt = buildExcerpt(session, nowElapsed - WINDOW_MS, nowElapsed);

    // Only fire when there's fresh content in the last FRESH_MS
    if (!freshExcerpt.trim()) return;

    const tickPrompt = session.tickPrompt || DEFAULT_TICK_PROMPT;
    const messages = buildTickMessages({ freshExcerpt, contextExcerpt, tickPrompt });
    const suggestion = await callAI(session, messages, { temperature: 0.2 });

    const payload = { type: 'suggestion', text: suggestion, at: Date.now() };
    session.suggestions.push(payload);

    for (const res of session.clients) {
      sseSend(res, 'suggestion', payload);
    }
    console.log(`[tick] session=${session.id} sent suggestion (${suggestion.length} chars)`);
  } catch (err) {
    console.error('[tick] error:', err);
  }
}

function startTicker(session) {
  if (session.interval) return;
  session.interval = setInterval(() => runTick(session), TICK_INTERVAL_MS);
}

function stopTicker(session) {
  if (session.interval) {
    clearInterval(session.interval);
    session.interval = null;
  }
}

// Routes
app.post('/api/session/start', (req, res) => {
  const { provider, model } = req.body || {};
  const s = newSession({ provider, model });
  console.log(`[session] started ${s.id} (provider=${s.provider}, model=${s.model})`);
  res.json({ sessionId: s.id });
});

app.post('/api/session/:id/append', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { text, timestampMs, segments } = req.body || {};
  if (segments && Array.isArray(segments)) {
    appendSegments(s, segments);
  } else if (text) {
    appendSegments(s, { text, timestampMs });
  }
  console.log(`[append] session=${s.id} totalSegments=${s.segments.length}`);
  res.json({ ok: true, total: s.segments.length });
});

app.post('/api/session/:id/prompt', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { prompt } = req.body || {};
  s.tickPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null;
  res.json({ ok: true, usingDefault: !s.tickPrompt });
});

app.get('/api/session/:id/stream', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  s.clients.add(res);
  console.log(`[sse] connect session=${s.id} clients=${s.clients.size}`);
  sseSend(res, 'ready', { ok: true, intervalMs: TICK_INTERVAL_MS });

  // if ticker not running, start it now
  startTicker(s);
  // attempt an immediate tick if buffered data exists
  runTick(s);

  req.on('close', () => {
    s.clients.delete(res);
    console.log(`[sse] disconnect session=${s.id} clients=${s.clients.size}`);
    if (s.clients.size === 0) {
      stopTicker(s);
    }
  });
});

app.get('/api/session/:id/finalize', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    const fullTranscript = s.segments.map(seg => `${formatTs(seg.timestampMs)} ${seg.text}`).join('\n');
    const messages = buildFinalMessages(fullTranscript);
    const summary = await callAI(s, messages, { temperature: 0.2 });
    res.json({ summary });
  } catch (err) {
    console.error('[finalize] error:', err);
    res.status(500).json({ error: 'finalize_failed', detail: String(err) });
  }
});

// Manual tick for debug or immediate suggestion
app.post('/api/session/:id/tick', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try {
    await runTick(s);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tick:manual] error:', err);
    res.status(500).json({ error: 'tick_failed', detail: String(err) });
  }
});

// Return transcript windows of size `sizeMs` (default 20000)
app.get('/api/session/:id/windows', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const sizeMs = Number(req.query.sizeMs || 20000);
  const windows = computeWindows(s, sizeMs);
  res.json({
    sizeMs,
    latestWindowIndex: windows.length ? windows[windows.length - 1].index : -1,
    windows: windows.map(w => ({ index: w.index, startMs: w.startMs, endMs: w.endMs, text: w.text }))
  });
});

// Summarize selected windows
app.post('/api/session/:id/summarize-windows', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { windows = [], prompt } = req.body || {};
  if (!Array.isArray(windows) || windows.length === 0) return res.status(400).json({ error: 'no_windows_selected' });
  try {
    const sizeMs = Number(req.query.sizeMs || 20000);
    const all = computeWindows(s, sizeMs);
    const byIndex = new Map(all.map(w => [w.index, w]));
    const selected = windows
      .map(i => byIndex.get(Number(i)))
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);
    const combined = selected.map(w => `Window ${w.index} (${formatTs(w.startMs)}-${formatTs(w.endMs)}):\n${w.text}`).join('\n\n');
    const msg = buildWindowSummaryMessages(combined, prompt);
    const out = await callAI(s, msg, { temperature: 0.2 });
    res.json({ summary: out });
  } catch (err) {
    console.error('[summarize-windows] error:', err);
    res.status(500).json({ error: 'summarize_failed', detail: String(err) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Audio ingestion (tab/system audio via MediaRecorder webm/opus)
app.post('/api/session/:id/audio', express.raw({ type: '*/*', limit: '32mb' }), async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  if (!asrConfigured()) return res.status(501).json({ error: 'asr_not_configured', hint: 'Set WHISPER_BIN to whisper.cpp binary; optional FFMPEG_BIN for ffmpeg.' });
  try {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'empty_body' });
    const text = await transcribeWebmOpus(buf, {});
    if (text) {
      appendSegments(s, { text, timestampMs: Date.now() - s.startedAt });
      console.log(`[asr] appended ${text.length} chars`);
    }
    res.json({ ok: true, text });
  } catch (e) {
    console.error('[asr:error]', e.message || e);
    res.status(500).json({ error: 'asr_failed', detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});

// Helpers
function formatTs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function buildTickMessages(excerpt, tickPrompt) {
  const { freshExcerpt, contextExcerpt, tickPrompt: prompt } = excerpt?.freshExcerpt ? excerpt : { freshExcerpt: '', contextExcerpt: '', tickPrompt };
  const base = [
    {
      role: 'system',
      content:
        'You are a meeting copilot. Be concise and practical. Only output the requested structure. Do not invent owners or dates. '
        + 'Prefer short, scannable bullets.'
    },
    {
      role: 'user',
      content: `${prompt}\n\nFresh excerpt (last ~${Math.floor(FRESH_MS/1000)}s):\n${freshExcerpt}\n\nContext excerpt (last ~${Math.floor(WINDOW_MS/1000)}s):\n${contextExcerpt}`
    }
  ];
  return base;
}

function buildFinalMessages(fullTranscript) {
  const prompt = DEFAULT_FINAL_PROMPT;
  return [
    { role: 'system', content: 'You are a crisp executive note-taker. Be brief, structured, and accurate.' },
    { role: 'user', content: `${prompt}\n\nFull transcript:\n${fullTranscript}` }
  ];
}

function buildExcerpt(session, fromMs, toMs) {
  const start = Math.max(0, fromMs || 0);
  const end = Math.max(start, toMs || (Date.now() - session.startedAt));
  return session.segments
    .filter(seg => seg.timestampMs >= start && seg.timestampMs <= end)
    .map(seg => `${formatTs(seg.timestampMs)} ${seg.text}`)
    .join('\n');
}

function computeWindows(session, sizeMs = 20000) {
  const lastTs = session.segments.length ? session.segments[session.segments.length - 1].timestampMs : 0;
  const maxEnd = Math.ceil(lastTs / sizeMs) * sizeMs;
  const windows = [];
  for (let start = 0, idx = 0; start < maxEnd; start += sizeMs, idx++) {
    const end = start + sizeMs;
    const text = session.segments
      .filter(seg => seg.timestampMs >= start && seg.timestampMs < end)
      .map(seg => seg.text)
      .join('\n');
    windows.push({ index: idx, startMs: start, endMs: end, text });
  }
  return windows;
}

function buildWindowSummaryMessages(combined, userPrompt) {
  const p = userPrompt && userPrompt.trim() ? userPrompt.trim() : `
Summarize the selected windows only. Keep it fresh and concise:
- Key points — 2 bullets
- Decisions — only explicit
- Action Items — Table: Owner | Task | Due if stated | Timestamp
- 3 sharp next questions (<12 words)
No preamble; only bullets/tables.
`;
  return [
    { role: 'system', content: 'You are a concise meeting copilot. Output only the requested structure.' },
    { role: 'user', content: `${p}\n\nSelected windows:\n${combined}` }
  ];
}

async function callAI(session, messages, opts) {
  const provider = session.provider || 'codex'; // Default to codex if not set
  const model = session.model || BRIDGE_MODEL; // Default to BRIDGE_MODEL if not set

  if (provider === 'gemini') {
    // Use the specific Gemini bridge script
    const payload = { model: session.model || GEMINI_MODEL, messages, temperature: opts.temperature || 0.2 };
    return runBridgeProcess(payload, [geminiBridgePath]);
  } else {
    // legacy bridge for codex/openai models
    return callBridgeCLI(messages, { ...opts, model: model });
  }
}

async function callBridgeCLI(messages, { temperature = 0.2, model = BRIDGE_MODEL } = {}) {
  const payload = { model: model, messages, temperature };
  const output = await runBridgeProcess(payload);
  return output;
}

function runBridgeProcess(payload, customArgs = null) {
  return new Promise((resolve, reject) => {
    const args = customArgs ? [customArgs[0], ...customArgs.slice(1)] : BRIDGE_RUN_ARGS;
    // If customArgs is just the script path (e.g. '.../bridge-gemini.mjs'), we need to prepend 'node' or similar if BRIDGE_RUN_CMD expects it.
    // However, BRIDGE_RUN_CMD is 'node' by default.
    // If BRIDGE_RUN_ARGS is complex (e.g. "scripts/bridge-cli.mjs"), customArgs should be "scripts/bridge-gemini.mjs".
    
    const child = spawn(BRIDGE_RUN_CMD, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`bridge_runner_exit_${code}: ${err || out}`));
      }
      const text = out.trim();
      resolve(text);
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const DEFAULT_TICK_PROMPT = `
Return only the latest summary with no carryover. Use:
- Fresh 20s Summary — max 2 bullets (from Fresh excerpt only)
- Decisions — only explicit (from Context excerpt); if none, "None yet."
- Action Items — Table: Owner | Task | Due if stated | Timestamp. If none explicit, add up to 2 (suggested) with blank owner.
- 3 sharp next questions (<12 words) prioritized for decisions/delivery.
Do not repeat unchanged items from previous ticks. No preamble; bullets/tables only.
`;

const DEFAULT_FINAL_PROMPT = `
Executive skim (max 300 words). Use the following sections:
- TL;DR — exactly 3 bullets
- Decisions — up to 5, include rationale and timestamp if present
- Action Items — up to 8 (Owner | Task | Due if stated | Timestamp)
- Risks — up to 3 (Risk | Mitigation | Owner | Timestamp)
- Follow-ups — up to 5 (Question | Owner | Timestamp)
Only include confirmed items (no inference). Keep it concise.
`;
