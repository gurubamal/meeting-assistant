Meeting Assistant (Web + Server + CLI)

Live transcript + AI suggestions every 20 seconds, powered by a Codex Bridge (OpenAI-compatible). Includes a finalize step that produces a concise executive skim.

Features
- Live transcript in the browser (Web Speech API)
- 20s heartbeat: rolling AI suggestions without clicks
- Custom prompts saved across meetings
- Finalize: short executive skim (TL;DR, Decisions, Actions, Risks, Follow-ups)
- CLI agent: same 20s loop from the command line (reads stdin or a file)

Structure
- `server/` Node/Express API + 20s scheduler + SSE stream
- `web/` Vite + React app (transcript + prompts + suggestions)
- `scripts/cli-agent.mjs` optional CLI agent (no web needed)

Requirements
- Node.js 18+
- Codex Agent Bridge (CLI) available locally, or customize `scripts/bridge-cli.mjs` to call your agent

Quick Start
1) Configure env
   - Copy `server/.env.example` to `server/.env`
   - Set: `BRIDGE_BASE_URL`, `BRIDGE_API_KEY`, `BRIDGE_MODEL` (e.g., `gpt-4o-mini`)
   - Optional: `TICK_INTERVAL_MS` (default 20000)

2) Install deps
   - In `server/`: `npm i`
   - In `web/`: `npm i`

3) Run
   - In `server/`: `npm i && npm run dev`
   - In `web/`: `npm i && npm run dev` (open http://localhost:5173)

4) CLI agent (optional)
   - From repo root: `node scripts/cli-agent.mjs --file -` then paste transcript lines; Ctrl-C to finalize
   - Or: `node scripts/cli-agent.mjs --file path/to/transcript.txt`

Configuration
- Server env (`server/.env`):
  - `BRIDGE_MODEL=gpt-4o-mini` (label only)
  - `TICK_INTERVAL_MS=20000`
  - `BRIDGE_RUN_CMD=node` (or your CLI, e.g., `codex`)
  - `BRIDGE_RUN_ARGS=scripts/bridge-cli.mjs` (or args for your CLI)

Endpoints (server)
- `POST /api/session/start` → `{ sessionId }`
- `POST /api/session/:id/append` body `{ text, timestampMs }` or `{ segments: [{ text, timestampMs }] }`
- `POST /api/session/:id/prompt` body `{ prompt }` (sets the rolling tick prompt)
- `GET  /api/session/:id/stream` SSE; emits `{ type: "suggestion", text, at }`
- `GET  /api/session/:id/finalize` → `{ summary }`

Notes
- This project shells out to a CLI “bridge runner” (no HTTP calls). You can point it to your Codex Agent Bridge CLI.
- Default runner is a placeholder; edit `scripts/bridge-cli.mjs` or set `BRIDGE_RUN_CMD/BRIDGE_RUN_ARGS`.
- Server relays suggestions per 20s tick via SSE. In-memory session store.

Codex Agent Bridge wiring (examples)
- If your CLI supports reading a prompt from stdin and returns assistant text to stdout, set:
  - `BRIDGE_RUN_CMD=codex`
  - `BRIDGE_RUN_ARGS=agent --bridge-config path/to/bridge.yaml --stdin --stdout`
- Or implement the spawn logic directly in `scripts/bridge-cli.mjs`.
