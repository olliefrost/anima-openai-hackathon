# AGENTS.md

## Project overview

This repository contains **Careloop**, a local tool that checks whether a
patient's hospital discharge care decision was actually followed up by
community services. For a given patient (or every discharged patient at
once) it:

1. Reads the patient's latest hospital discharge summary from NHS-SIM.
2. Uses an Anima ADK agent (backed by an OpenAI model) to structure the
   free-text discharge note and decide whether community follow-up care is
   needed, and if so what kind — flagging the decision itself as ambiguous
   rather than guessing when the note doesn't say enough.
3. Reads what community services actually have booked for that patient.
4. Reconciles the two and flags a gap: care needed but nothing booked, or a
   booking that doesn't match the decided care type — ranked by an urgency
   score so a full sweep surfaces the most urgent discrepancies first (a
   single check just carries its own score).

Careloop is **read-only**: it never books, cancels, or edits a NHS-SIM
record, and it never contacts community services directly. Its output is a
worklist for a human to review, not an automated action.

This end-to-end flow has been run live against NHS-SIM and a real OpenAI
model (not just unit-tested): fetch discharge note → agent decision → fetch
booked care → reconcile, producing correct `ok`/`flag`/`review` outcomes for
distinct patients. See the API and agent notes below for the two real bugs
that surfaced during that check and how they were fixed.

## Tech stack

| Layer | Technology | Where |
|---|---|---|
| Frontend | React 19, Vite 7, ES modules | `dashboard/src/` |
| Backend | Node built-in `http`, ES modules | `dashboard/server.js` |
| Care-decision agent | `@animahealth/adk` + OpenAI model, structured (zod) output | `dashboard/careAgent.js` |
| Domain logic | Framework-free JS functions | `dashboard/src/model.js` |
| Tests | Node built-in test runner (`node --test`) | `dashboard/src/model.test.js` |
| Dev orchestration | `concurrently` (runs Vite + the Node server together) | `package.json` |
| External data | NHS-SIM simulator (read-only HTTP API) | `dashboard/server.js` |

There is no separate state-management library, CSS framework, or ORM — keep
it that way unless the user explicitly asks for one. Prefer the platform and
existing dependencies over adding new ones.

## Coding principles

These apply to every change in this repository:

- **Simplicity first.** Solve the problem asked, not a generalized version of
  it. Don't add abstractions, config flags, or framework layers for
  hypothetical future needs. Three similar lines beat a premature helper.
- **Explainable code over comments.** Prefer clear names and small, single-
  purpose functions so the code reads on its own. Add a comment only when the
  *why* isn't obvious from the code — a non-obvious constraint, an upstream
  API quirk, a subtle invariant — never to restate *what* the code does.
- **Match existing style.** Follow the conventions already used in the file
  you're editing (naming, formatting, module structure). Don't reformat
  unrelated code.
- **No speculative error handling.** Validate at real boundaries (user input,
  the NHS-SIM response, the agent's output, request bodies) as this codebase
  already does; don't add defensive checks for conditions that can't occur
  internally.
- **Keep domain logic pure and testable.** The reconciliation rule (does
  booked care match the decision?) lives in `dashboard/src/model.js` as pure
  functions, not scattered into `App.jsx` or `server.js`, so it stays unit-
  testable without a browser, server, or model call.
- **Security is not optional.** Preserve the server's loopback binding,
  origin checks, request-size limit, timeouts, CSP headers, and `no-store`
  responses. Never introduce `dangerouslySetInnerHTML`, string-built SQL/HTML,
  or anything that would let upstream, patient, or model-generated content
  execute as code.
- **Document what changes.** If you add a route, environment variable,
  heuristic, or user-visible behavior, update the relevant README
  (`dashboard/README.md` for the dashboard, root `README.md` for repository-
  wide changes) in the same change — see "Documentation" below.
- **Verify before claiming done.** Run the tests and, for UI/server changes,
  actually start `npm run dev` and exercise the affected flow. Don't report a
  check as passed unless you ran it.

## Repository map

- `dashboard/index.html` — Vite HTML entrypoint.
- `dashboard/style.css` — all dashboard styling and responsive rules.
- `dashboard/src/App.jsx` — React UI: connect to a team, check one patient by ID, or sweep every discharged patient.
- `dashboard/src/model.js` — pure reconciliation rules (`reconcile`, `matchesCareType`) and the `careTypes` vocabulary.
- `dashboard/src/model.test.js` — Node test coverage for the reconciliation rules.
- `dashboard/vite.config.js` — Vite build and Node development proxy.
- `dashboard/server.js` — loopback-only Node static server, the read-only NHS-SIM proxy, and the `/api/connect`, `/api/check`, `/api/sweep` routes.
- `dashboard/careAgent.js` — the ADK agent that turns discharge-note sections into a structured care decision.
- `dashboard/README.md` — user-facing setup and behavior notes.

## Commands

Run commands from the repository root:

```sh
npm install
npm run dev       # Vite at :5173 and the Node API at :8000
npm run build     # production frontend build
npm start         # production app at http://localhost:3000
npm test          # Node model tests
```

There is currently no lint or production-build script beyond the Vite build.
Do not claim a lint check passed unless a script is added and run.

## Environment and secrets

- Use a root `.env` for `SIM_API_KEY` and `OPENAI_API_KEY`.
- Never read, print, commit, expose to the browser, or include real keys in fixtures or error messages.
- Keep `.env` ignored. If documenting variables, use placeholders in an example file.
- `SIM_API_KEY` is for NHS-SIM; `OPENAI_API_KEY` is for the care-decision agent in `dashboard/careAgent.js`. They are not interchangeable, and both keys are read server-side only — never sent to the browser.
- Simulator and model credentials must remain in server memory or the server environment. Do not persist them in browser storage.
- **Troubleshooting a `401`/`Incorrect API key` from the agent**: `process.loadEnvFile` does not override a variable already set in the shell. If `OPENAI_API_KEY` was previously exported to something else (e.g. copy-pasted from `SIM_API_KEY`), the `.env` value is silently ignored. Check with `env | grep OPENAI_API_KEY` before assuming the code is broken.

## NHS-SIM API reference (handoff notes)

This is what earlier exploration of `https://sim.animahacks.com` found. Full
reference: `GET /api/catalogue`, human docs at `/docs/explorer/`, OpenAPI at
`/api/openapi.json` (not yet pulled into this repo — check it before adding
any write call).

- **Auth**: `Authorization: Bearer <SIM_API_KEY>` on every request.
- **Sites in scope for this tool**: `hospital` (discharge documents),
  `community` (bookings). `gp`, `pharmacy`, `diagnostics`, `referrals`,
  `wearables` also exist but aren't read by this tool.
- **`GET /api/sites/hospital/documents`** — returns `{ resources, patients }`.
  A discharge summary resource looks like:
  ```json
  {
    "id": "discharge-summary-example",
    "kind": "discharge-summary",
    "owner": "hospital",
    "title": "Discharge summary · monitoring handover",
    "status": "sent",
    "version": 1,
    "createdAt": 1789200000000,
    "patientId": "SIM-000001",
    "visibleTo": ["hospital", "gp"],
    "data": {
      "stage": "sent",
      "sentAt": 1789200000000,
      "sentBy": "Dr Morgan Bell",
      "sections": {
        "course": "...", "reason": "...", "results": "...",
        "followUp": "...", "diagnoses": "...", "gpActions": "...",
        "medicationChanges": "..."
      }
    }
  }
  ```
  `data.sections` is the free text this tool structures. The same documents
  are mirrored to `gp` (`visibleTo` includes `"gp"`), but this tool reads
  them from `hospital` since that's the authoring site.
- **A patient can have more than one discharge document** — a seeded example
  alongside a batch-generated one, with different `id`s. Confirmed live: one
  patient had a `version: 1` document sent ~47 hours *after* a `version: 2`
  document. These are independent episodes, not edits of one record, so
  `version` does not track recency — `hospitalDischarges()` in `server.js`
  picks the latest by `data.sentAt`/`createdAt` instead. Don't reintroduce a
  version-based "latest" comparison here.
- **`patients` on that same response** carries the demographic context this
  tool passes to the agent: `{ id, name, birthDate, conditions, needs, goals,
  localIds }`. Use it instead of a second patient lookup when possible.
- **`GET /api/sites/community/view`** (paged, `offset`/`limit`) is what this
  tool reads for "what's actually booked" — confirmed live to contain
  patient-linked `visit`, `care-plan`, and `care-package` resources (also
  `observation`, `device`, `message`, `bed`, `capacity` — filtered out by
  `patientId`, not by `kind`, since a discharge note can call for any of
  them). **`GET /api/sites/community/appointments` is not a per-patient
  booking list** despite the name — it 400s with `"A valid date is
  required"` and returns one day's slot-capacity schedule
  (`{ appointments, patients, sessions }`) for whatever `date` you pass, not
  a patient's bookings. Don't add it back to `bookedCareFor()`.
- Booking titles can be free text with no clinical detail at all — confirmed
  live titles like `"moni"` and `"hi"` from manually scheduled test visits.
  Reconciliation matches on booking title/kind text via keywords in
  `model.js`, not an exact `kind` enum, and treats an unrecognised match as
  "needs review" rather than guessing — this also means a real match can be
  under-detected when the title is this terse. That's a known precision
  limit of text matching, not a bug to silently "fix" by guessing.
- **`GET /api/sites/{site}/patients?q=<id>&offset=0`** — patient search/read,
  used as a fallback when a patient isn't in the discharge-documents response.
- **Available but unused by this tool**: `referrals` site / `GET
  /api/nhs/ers` ("Create, read, accept and reject referrals" per the
  catalogue) models exactly the kind of approve/reject handshake a future
  "ping community services" write-flow would need — referral resources carry
  a `status` (`accepted`/`rejected`/pending) and a `visibleTo` list. `eps`
  (prescriptions), `pds`/`ods` (FHIR demographics/org lookups), and
  `pathology`/`radiology` are also available. None of these are called
  today; adding a write path is a deliberate scope change (see clinical
  guardrails below), not a drive-by addition.
- World state resets are possible between hackathon sessions — sample IDs
  above (e.g. `SIM-000001`) may not exist in every world; always resolve
  patients by whatever your connected team's `/api/team` world actually has.
- **The simulator sits behind a Caddy reverse proxy** (`via: 1.1 Caddy` on
  every response) that intermittently answers a healthy backend with a bare,
  empty-body `502`. Confirmed live: the same request failed, then succeeded
  seconds later with nothing else changed; a 60-request burst across
  `/api/team`, hospital documents, and community view came back 60/60 clean.
  `upstream()` in `server.js` retries a request up to 3 times on a thrown
  fetch error or a 502/503/504, and fails fast on everything else (401, 403,
  or any other status) — don't remove that retry as unnecessary complexity,
  and don't widen it to retry on non-transient statuses.
- **The community view (`/api/sites/community/view`) is fetched once per
  check or sweep, not once per patient.** `handleSweep` used to call
  `bookedCareFor()` — which fetched the whole view again — inside every
  per-patient `runCheck`, turning a sweep over ~60 patients into ~60 identical
  ~22KB requests. `communityResources()` now fetches it once and
  `bookedCareFor()` is a pure filter over the result; don't reintroduce a
  per-patient fetch here.

## Anima ADK usage notes (handoff notes)

- **`app.agent({ context: [...] })` needs `app.context.history()`, not just
  `app.context.system(...)`.** The system prompt alone does not include
  whatever you pass to `app.run(agent, prompt)` — without `history()` in the
  context array, the model never sees the prompt at all. Confirmed live: the
  agent consistently replied "no discharge note was provided" until
  `app.context.history()` was added to `dashboard/careAgent.js`. Any new
  ADK agent in this repo needs both.
- **`output: { schema }` still needs re-validation on the result.** ADK's
  structured output runs through a "forgiving" parser (coercion, partial
  matches), so `result.output.value` isn't a hard-guaranteed match for the
  zod schema — `careAgent.js` calls `decisionSchema.safeParse(...)` before
  trusting it, and that's the actual boundary check, not the `output` config.
- `app.run(agent, promptString)` (the string shorthand) is what this tool
  uses — no need for the `{ input: { message, state } }` form unless you
  need session state.

## Clinical-product guardrails

Careloop is a review aid, not a clinical decision maker or an approval
system. Keep labels precise and avoid stronger claims than the available
data supports:

- The care-decision agent must prefer `ambiguous: true` over guessing when
  the discharge note doesn't specify enough to pick a care type confidently.
  Reconciliation surfaces this as "needs review," not as a false match or a
  false gap.
- A care type that can't be checked against booked-care text with
  reasonable confidence (see `matchesCareType` in `model.js`) must also
  reconcile to "needs review," never a claimed "match."
- Missing a matching community booking does not prove a handoff failed —
  only that this tool couldn't find one. Phrase flags as something to check,
  not a confirmed care omission.
- The urgency score (`urgencyScore` in `reconcile()`'s result, `model.js`)
  ranks how urgently a discrepancy needs a human look, using the note's
  clinical urgency and whether the gap is confirmed (`flag`) or only
  suspected (`review`). It deliberately does not fold in `decision.confidence`
  — how sure the decision is and how urgently a gap needs checking are
  different questions, and confidence stays a separate, visible field rather
  than silently discounting the score.
- Keep NHS-SIM access read-only. This tool must never book, cancel, edit, or
  message on behalf of a service. If that changes, it's a deliberate,
  discussed scope change — see the referrals/`ers` note above for the likely
  mechanism.
- Synthetic records must remain conspicuously labelled as demo data; never
  silently mix synthetic and live data.

## Testing expectations

- Run `npm test` after changing reconciliation or care-type matching logic.
- Add or update focused cases in `dashboard/src/model.test.js` for every
  rule change, including boundary conditions (ambiguous decisions, no care
  needed, bookings before vs. after discharge, unverifiable care types).
- For UI or server changes, also start `npm run dev` and manually verify the
  single-patient check and the full sweep at desktop and narrow viewport
  widths.
- When changing simulator or agent integration, don't stop at unit tests —
  run an actual `/api/check` against a real patient ID with a real
  `SIM_API_KEY` and `OPENAI_API_KEY` and read the response. Unit tests
  can't catch a wrong upstream endpoint (see the `community/appointments`
  note above) or a misconfigured agent context (see the ADK notes above);
  both passed every unit test while silently returning wrong or empty
  results. Also verify invalid credentials, a missing discharge summary, and
  a missing `OPENAI_API_KEY`, without logging secrets or patient payloads.

## Documentation

Update `dashboard/README.md` when setup, environment variables, routes,
user-visible heuristics, privacy behavior, or operating limitations change.
Keep instructions runnable from the repository root.
