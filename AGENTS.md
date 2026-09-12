# AGENTS.md

## Project overview

This repository contains **Careloop**, a local dashboard for reviewing patient-linked work across the NHS-SIM GP, pharmacy, and community-care services. It also contains a small, separate Anima ADK/OpenAI command-line example in `agent.js`.

Keep these concerns separate:

- `dashboard/` is the Careloop application. It uses React and Vite with a FastAPI backend.
- `agent.js` is an independent JavaScript ADK example.

## Repository map

- `dashboard/index.html` — Vite HTML entrypoint.
- `dashboard/style.css` — all dashboard styling and responsive rules.
- `dashboard/src/App.jsx` — React components, state, filtering, flags, notes, and simulator connection flow.
- `dashboard/src/model.js` — pure aggregation, deduplication, status, and attention rules.
- `dashboard/src/model.test.js` — Node test coverage for the model rules.
- `dashboard/vite.config.js` — Vite build and FastAPI development proxy.
- `dashboard/server.py` — loopback-only FastAPI static server and read-only NHS-SIM proxy.
- `dashboard/README.md` — user-facing setup and behavior notes.
- `agent.js` — Anima ADK/OpenAI CLI example.

## Commands

Run commands from the repository root:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
npm install
npm run dev       # Vite at :5173 and FastAPI at :8000
npm run build     # production frontend build
npm start         # production app at http://localhost:3000
npm test          # Node model tests
npm run agent -- "your prompt"
```

There is currently no lint or production-build script. Do not claim those checks passed unless a script is added and run.

## Environment and secrets

- Use a root `.env` for `SIM_API_KEY` and `OPENAI_API_KEY`.
- Never read, print, commit, expose to the browser, or include real keys in fixtures or error messages.
- Keep `.env` ignored. If documenting variables, use placeholders in an example file.
- `SIM_API_KEY` is for NHS-SIM; `OPENAI_API_KEY` is for `agent.js`. They are not interchangeable.
- Simulator credentials must remain in server memory or the server environment. Do not persist them in browser storage.

## Implementation conventions

- Use React components and ES modules. Keep domain calculations in `dashboard/src/model.js` as pure functions so they can be tested without a browser.
- Render upstream and user-provided content through React text interpolation; do not introduce `dangerouslySetInnerHTML`.
- Keep the server bound to `127.0.0.1` and retain its host/origin checks, request-size limit, timeouts, CSP, and `no-store` behavior.
- Keep NHS-SIM access read-only unless the user explicitly changes the product scope. The current server only calls `/api/team`, `/api/sites/{site}/view`, and `/api/sites/{site}/patients`.
- Preserve partial-source behavior: one failed service should be reported without discarding successful services.
- Deduplicate shared resources globally by resource ID, prefer the newest version, and retain every service in which the resource was seen.
- Use the simulator-provided clock for due-time decisions. Do not substitute the machine clock for live clinical data.
- Only patient-linked records belong in the worklist. Service inventory without a `patientId` must remain excluded.
- Browser flags and notes are local review aids, namespaced by simulator world. They must not imply that source records or clinical tasks were updated.
- Match existing code style in the file being edited. Avoid broad formatting-only changes.

## Clinical-product guardrails

Careloop is a review aid, not a clinical decision maker. Keep labels precise and avoid stronger claims than the available data supports:

- An explicit past `dueAt` can be labelled overdue.
- An undated open item older than 48 hours is only a review heuristic; do not call it overdue.
- Cross-service visibility does not prove that a handoff was received or completed.
- Missing data does not prove missing care.
- Surface partial or truncated data clearly; never silently mix synthetic demo records into a live response.
- Synthetic records must remain conspicuously labelled as demo data.

## Testing expectations

- Run `npm test` after changing aggregation, status handling, attention rules, or deduplication.
- Add or update focused cases in `dashboard/src/model.test.js` for every domain-rule change, including boundary conditions.
- For UI or server changes, also start `npm run dev` and manually verify the affected flow at desktop and narrow viewport widths.
- When changing simulator integration, verify invalid credentials, one-service failure, all-services failure, partial/truncated results, and successful refresh behavior without logging secrets or patient payloads.

## Documentation

Update `dashboard/README.md` when setup, environment variables, routes, user-visible heuristics, privacy behavior, or operating limitations change. Keep instructions runnable from the repository root.
