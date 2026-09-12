# Careloop

Careloop checks whether a patient's hospital discharge decision was actually
followed up. For a patient ID (or every discharged patient at once) it reads
the hospital discharge summary from NHS-SIM, uses an Anima ADK agent to
structure the free-text decision into "is community follow-up care needed,
and what kind," reads what community services actually booked, and flags a
gap when the two don't line up.

Careloop is a **review aid, not a clinical decision maker** — it only reads
NHS-SIM data and never books, cancels, or edits anything. See the guardrails
in [`AGENTS.md`](./AGENTS.md) before changing the decision or reconciliation
logic.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 7 (`dashboard/src`) |
| Backend | Node (built-in `http`) serving the built frontend and proxying NHS-SIM (`dashboard/server.js`) |
| Care-decision & care-match agents | `@animahealth/adk` + an OpenAI model, structured output (`dashboard/careAgent.js`) |
| Domain logic | Plain JS functions, framework-free, in `dashboard/src/model.js` |
| Tests | Node's built-in test runner (`node --test`) against `model.js` |
| Dev orchestration | `concurrently` runs Vite and the Node server together (`npm run dev`) |

## Getting started

```sh
npm install
npm run dev        # Vite dev server at :5173, Node API at :8000
```

Then open http://localhost:5173. See [`dashboard/README.md`](./dashboard/README.md)
for full setup, environment variables, and the check/sweep flow, and
[`flow.md`](./flow.md) for the exact end-to-end sequence — what calls what,
in what order, and how a result is decided.

## Repository layout

```
dashboard/            Careloop application (frontend + backend)
  src/App.jsx         React UI — connect, check one patient, or sweep all
  src/model.js         Pure reconciliation rules (status + urgency from a match verdict)
  src/model.test.js    Tests for model.js
  server.js            Loopback-only Node static server + NHS-SIM proxy + API routes
  careAgent.js          ADK agents: discharge note -> care decision, decision+bookings -> match verdicts
  README.md            Dashboard-specific setup and behavior notes
AGENTS.md             Conventions, NHS-SIM API reference, guardrails, and commands for AI coding agents
flow.md               Exact end-to-end workflow: sequence, decision logic, error handling
CLAUDE.md             Points Claude Code at AGENTS.md
```

## Contributing / working with AI agents

This repo is developed with AI coding assistants. Before making changes, read
[`AGENTS.md`](./AGENTS.md) — it documents the required coding principles, the
NHS-SIM API reference gathered so far, environment/secrets handling,
clinical-product guardrails, and testing expectations that apply to every
change.
