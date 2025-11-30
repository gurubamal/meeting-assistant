/**
 * Gemini CLI Bridge (Keyless/Local Mode)
 * 
 * This script wraps the local 'gemini' CLI tool, allowing the Meeting Assistant
 * to function without a direct API KEY in the server's .env file.
 * It relies on the 'gemini' CLI being authenticated in the system.
 */

import { spawn } from 'node:child_process';

// Read stdin (JSON payload from server)
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

// Convert structured messages to a plain text prompt
// The Gemini CLI (v0.17.x) typically takes a prompt string.
function messagesToPlain(messages = []) {
  // We just join them with headers. 
  // System instructions are prepended.
  return messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : 'Model';
      return `[${role}]: ${m.content}`;
    })
    .join('\n\n');
}

const prompt = messagesToPlain(payload.messages);

// Spawn the 'gemini' CLI process.
// We do NOT pass the model flag (-m) by default because the CLI's model names
// (e.g. gemini-1.5-flash) might differ from what the server requests or 
// cause 404s if not enabled for the specific CLI user/project.
// We rely on the CLI's default configured model.
const args = ['--output-format', 'text'];

// If you really want to try passing the model:
// if (payload.model) args.push('--model', payload.model);

const child = spawn('gemini', args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true // Required on Windows to resolve .cmd/.ps1 shims
});

let out = '';
let err = '';

child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });

child.on('close', (code) => {
  // The CLI might print "Loaded cached credentials." to stdout. We filter it.
  const cleanOutput = out
    .split('\n')
    .filter(line => !line.includes('Loaded cached credentials.'))
    .join('\n')
    .trim();

  if (code !== 0) {
    // If it failed, output stderr so the server logs it
    console.error(`Gemini CLI exited with ${code}: ${err}`);
    // If we have partial output, maybe show it? No, safer to fail.
    process.exit(code);
  }

  if (!cleanOutput) {
    // Sometimes success but empty?
    console.error('Gemini CLI returned empty output.');
    if (err) console.error('Stderr:', err);
    process.exit(1);
  }

  process.stdout.write(cleanOutput);
  process.exit(0);
});

child.on('error', (e) => {
  console.error('Failed to spawn gemini CLI:', e);
  process.exit(1);
});

// Write prompt to stdin
child.stdin.write(prompt);
child.stdin.end();