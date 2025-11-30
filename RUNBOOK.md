Meeting Assistant — Runbook

Purpose
- Start the live transcript + AI meeting copilot quickly and reliably, any time.

What’s included
- Web UI (Vite + React) on http://127.0.0.1:5173
- Server (Node/Express) on http://127.0.0.1:8787 with a 10s heartbeat and “fresh 20s” summaries
- Codex CLI bridge (no HTTP API) for AI suggestions and final skims
- Optional tab/system audio capture → local ASR via whisper.cpp (see below)

One‑time requirements
- Node.js 18+ in PATH (node -v)
- Codex CLI installed and logged in (`codex -V`, `codex login` if needed)
- Optional ASR: ffmpeg in PATH and whisper.cpp binary (see Configuration)

Quick start (recommended)
- From this folder, run: `./start-meeting-assistant.ps1`
  - Installs dependencies on first run
  - Starts server + web dev servers
  - Opens the web UI in your default browser

Usage flow
- In the UI, click “Start Mic” (auto-creates session, applies your prompt, connects the stream)
- Talk or type; suggestions appear every ~10s as fresh-only summaries
- Adjust the “Tick Prompt,” click “Apply Prompt,” and continue
- Click “Finalize” to produce a concise executive skim
- Optional: “Capture Tab Audio” to transcribe system/tab audio (requires whisper.cpp and ffmpeg)

Configuration
- Server env file: `server/.env` (copied from `.env.example` on first run)
  - `TICK_INTERVAL_MS=10000` (default 10s)
  - `FRESH_MS=20000` (fresh window for summary)
  - `WINDOW_MS=60000` (context window for decisions/actions)
  - `BRIDGE_MODEL=auto` (let Codex choose a supported model)
  - ASR (optional): set paths for tab/system audio transcription
    - `WHISPER_BIN=C:\\tools\\whisper.cpp\\main.exe` (or your whisper.cpp binary)
    - `FFMPEG_BIN=ffmpeg` (must be in PATH or set full path)

Scripts
- `start-meeting-assistant.ps1` — safe to run anytime; kills previous dev processes, starts up clean, and opens the browser

Troubleshooting
- UI shows “waiting for fresh speech”: speak or type a new sentence; the system only emits when there’s new text in the last 20s
- “Cannot GET /” on 8787: server is API-only; use 5173 for the UI
- No suggestions: ensure Codex CLI works (`codex exec --experimental-json - <<<'hello'` should output JSON). If needed, restart with the start script
- Tab audio: if POST /audio returns asr_not_configured, set `WHISPER_BIN` and ensure `ffmpeg` is installed/in PATH
- Logs:
  - Server: `server/server-out.log` and `server/server-err.log`
  - Web/Vite: `web/vite-out.log` and `web/vite-err.log`

Notes
- Advanced “20s Windows” panel is available under “Show Advanced” for manual window selection and summarization.
- The system uses “fresh-only” summaries to avoid carrying over stale content between ticks.

