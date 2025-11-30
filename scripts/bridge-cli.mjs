#!/usr/bin/env node
/**
 * Codex Agent Bridge runner (CLI mode)
 *
 * Contract:
 * - Reads a single JSON blob from stdin: { model, messages, temperature }
 * - Writes a single UTF-8 string (assistant text) to stdout
 * - Exits 0 on success; non-zero on failure
 *
 * Wire this to your Codex CLI agent or custom bridge. Examples:
 * - Use an external CLI: set env BRIDGE_RUN_CMD and BRIDGE_RUN_ARGS to invoke it,
 *   or modify this file to shell out to your tool of choice.
 *
 * By default, this is a placeholder that fails until configured.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString('utf8');

let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch (e) {
  console.error('Invalid JSON payload on stdin');
  process.exit(2);
}

// Minimal pretty prompt joiner (if your CLI expects plain text)
function messagesToPlain(messages = []) {
  return messages
    .map((m) => `[[${m.role.toUpperCase()}]]\n${m.content}`)
    .join('\n\n');
}

// Placeholder behavior: require user to configure this runner.
const model = (process.env.BRIDGE_MODEL && process.env.BRIDGE_MODEL !== 'auto') ? process.env.BRIDGE_MODEL : null;
const promptText = messagesToPlain(payload.messages);

function tmpFile(prefix = 'codex-out-', suffix = '.txt') {
  const rnd = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `${prefix}${rnd}${suffix}`);
}


function resolveCodexInvocation() {
  // On Windows, always prefer codex.js via node to avoid PowerShell shim issues
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA; // e.g., C:\Users\<user>\AppData\Roaming
    if (appdata) {
      const jsPath = path.join(appdata, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(jsPath)) {
        return { cmd: process.execPath, args: [jsPath] };
      }
    }
    // Fallback: try plain 'node codex.js' from PATH if installed globally
    return { cmd: 'codex', args: [] };
  }
  // Non-Windows: allow override via CODEX_CMD, else call 'codex'
  const custom = process.env.CODEX_CMD;
  if (custom) {
    const parts = custom.split(' ');
    return { cmd: parts[0], args: parts.slice(1) };
  }
  return { cmd: 'codex', args: [] };
}

const { cmd, args } = resolveCodexInvocation();
const fullArgs = [
  ...args,
  'exec',
  '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '--color', 'never',
  '--experimental-json',
  ...(model ? ['-m', model] : []),
  '-', // read prompt from stdin
];

const child = spawn(cmd, fullArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.write(promptText);
child.stdin.end();

let lastAssistant = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt?.type === 'item.completed' && evt?.item?.item_type === 'assistant_message') {
        lastAssistant = evt.item.text || '';
      }
    } catch {
      // ignore non-JSON noise
    }
  }
});

let errBuf = '';
child.stderr.on('data', (d) => { errBuf += d.toString(); });

child.on('error', (e) => {
  console.error(String(e?.message || e));
  process.exit(3);
});

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`codex exited with ${code}: ${errBuf}`.trim());
    process.exit(code || 1);
  }
  const out = (lastAssistant || '').trim();
  process.stdout.write(out || '');
  process.exit(0);
});
