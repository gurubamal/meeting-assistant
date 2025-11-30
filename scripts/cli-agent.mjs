#!/usr/bin/env node
/**
 * CLI agent: reads transcript from stdin or a file, runs a 20s loop using the same
 * bridge runner as the server, and prints suggestions live. Ctrl-C to finalize.
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]
  const v = process.argv[i + 1]
  if (k?.startsWith('--')) { args.set(k.slice(2), v); i++ }
}

const file = args.get('file')
const intervalMs = Number(process.env.TICK_INTERVAL_MS || 20000)
const BRIDGE_RUN_CMD = process.env.BRIDGE_RUN_CMD || 'node'
const BRIDGE_RUN_ARGS = (process.env.BRIDGE_RUN_ARGS || 'scripts/bridge-cli.mjs').split(' ')
const BRIDGE_MODEL = process.env.BRIDGE_MODEL || 'gpt-4o-mini'

let buffer = ''
let lastIndex = 0

function callBridge(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(BRIDGE_RUN_CMD, BRIDGE_RUN_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`runner_exit_${code}: ${err || out}`))
      resolve(out.trim())
    })
    const payload = { model: BRIDGE_MODEL, messages, temperature: 0.2 }
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

const TICK_PROMPT = `Key points from the last 20 seconds.\n- Decisions (only explicit)\n- Action items (Owner | Task | Due)\n- 3 sharp questions (<12 words)\nNo preamble.`

function buildTickMessages(excerpt) {
  return [
    { role: 'system', content: 'You are a concise meeting copilot. Output only bullets/tables.' },
    { role: 'user', content: `${TICK_PROMPT}\n\nRecent transcript:\n${excerpt}` }
  ]
}

function buildFinalMessages(full) {
  const FINAL = `Executive skim (max 300 words).\n- TL;DR — exactly 3 bullets\n- Decisions — up to 5 (rationale, timestamp)\n- Action Items — up to 8 (Owner | Task | Due | Timestamp)\n- Risks — up to 3\n- Follow-ups — up to 5\nOnly confirmed items.`
  return [
    { role: 'system', content: 'You are a crisp executive note-taker.' },
    { role: 'user', content: `${FINAL}\n\nFull transcript:\n${full}` }
  ]
}

function formatTs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

async function main() {
  if (file && file !== '-') {
    buffer = fs.readFileSync(file, 'utf8')
  } else {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { buffer += d })
  }

  console.log(`[cli] running 20s loop (interval=${intervalMs}ms). Press Ctrl-C to finalize.`)
  const int = setInterval(async () => {
    try {
      const lines = buffer.split(/\r?\n/)
      const newLines = lines.slice(lastIndex)
      if (newLines.length === 0) return
      lastIndex = lines.length
      const excerpt = newLines.join('\n')
      const msg = buildTickMessages(excerpt)
      const out = await callBridge(msg)
      const at = new Date().toLocaleTimeString()
      console.log(`\n[${at}] suggestion\n${out}\n`)
    } catch (e) {
      console.error('[tick:error]', e.message)
    }
  }, intervalMs)

  process.on('SIGINT', async () => {
    clearInterval(int)
    console.log('\n[cli] finalizing...')
    try {
      const full = buffer
      const out = await callBridge(buildFinalMessages(full))
      console.log('\n[final]\n' + out + '\n')
    } catch (e) {
      console.error('[final:error]', e.message)
    }
    process.exit(0)
  })
}

main().catch((e) => { console.error(e); process.exit(1) })

