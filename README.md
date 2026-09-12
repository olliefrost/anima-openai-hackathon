# Careloop

Careloop is a local dashboard that gives NHS-SIM GP, pharmacy, and community-care
staff one merged, patient-linked worklist instead of three separate systems to
check. It pulls read-only data from the NHS-SIM simulator, deduplicates records
that appear in more than one service, and flags items that look overdue,
blocked, or stale so nothing sits unnoticed across a handoff.

Careloop is a **review aid, not a clinical decision maker** — see the
guardrails in [`AGENTS.md`](./AGENTS.md) before changing any status or
attention logic.

This repository also contains a small, unrelated Anima ADK/OpenAI CLI example
in [`agent.js`](./agent.js), kept separate from the dashboard.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 7 (`dashboard/src`) |
| Backend | FastAPI (Python) serving the built frontend and proxying NHS-SIM (`dashboard/server.py`) |
| Domain logic | Plain JS functions, framework-free, in `dashboard/src/model.js` |
| Tests | Node's built-in test runner (`node --test`) against `model.js` |
| Dev orchestration | `concurrently` runs Vite and Uvicorn together (`npm run dev`) |
| CLI example | `agent.js` — `@animahealth/adk` with an OpenAI model backend |

## Getting started

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
npm install
npm run dev        # Vite dev server at :5173, FastAPI at :8000
```

Then open http://localhost:5173. See [`dashboard/README.md`](./dashboard/README.md)
for full setup, environment variables, and the behavior of the simulator
connection, review flags, and attention heuristics.

For the OpenAI-backed CLI example:

```sh
npm run agent -- "your prompt"
```

## Repository layout

```
dashboard/            Careloop application (frontend + backend)
  src/App.jsx         React UI, filtering, flags, notes, simulator connection
  src/model.js         Pure aggregation, dedup, and attention rules
  src/model.test.js    Tests for model.js
  server.py            Loopback-only FastAPI static server + NHS-SIM proxy
  README.md            Dashboard-specific setup and behavior notes
agent.js              Standalone Anima ADK/OpenAI CLI example
AGENTS.md             Conventions, guardrails, and commands for AI coding agents
CLAUDE.md             Points Claude Code at AGENTS.md
```

## Contributing / working with AI agents

This repo is developed with AI coding assistants. Before making changes, read
[`AGENTS.md`](./AGENTS.md) — it documents the required coding principles,
environment/secrets handling, clinical-product guardrails, and testing
expectations that apply to every change.
