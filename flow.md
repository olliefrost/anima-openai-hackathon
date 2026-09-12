# Careloop — intended workflow

This document traces the exact, current end-to-end flow: what the browser
does, what the Node server does, what it calls on NHS-SIM and the OpenAI
model, and how a result is decided and rendered. It complements
[`AGENTS.md`](./AGENTS.md) (conventions, guardrails, API handoff notes) —
this file is about *sequence and decisions*, not conventions.

Careloop is **read-only**: every NHS-SIM call is a `GET`. Nothing here ever
books, cancels, or edits a record, or contacts a community service.

## Actors

| Actor | Where |
|---|---|
| Browser UI | `dashboard/src/App.jsx` (React) |
| Local Node server | `dashboard/server.js` — loopback-only, proxies NHS-SIM and hosts the built frontend |
| Care-decision & care-match agents | `dashboard/careAgent.js` — two Anima ADK agents backed by an OpenAI model |
| Reconciliation rules | `dashboard/src/model.js` — pure functions, no I/O |
| External simulator | `https://sim.animahacks.com` (NHS-SIM) |

In dev (`npm run dev`), Vite serves the UI at `:5173` and proxies `/api/*` to
the Node server at `:8000`. In production (`npm run build && npm start`),
one Node process on `:3000` serves the built `dashboard/dist` and the same
`/api/*` routes — the flow below is identical either way.

## 1. Startup and connecting to NHS-SIM

1. The server loads `.env` from the repo root via `process.loadEnvFile`
   (`server.js`) — `SIM_API_KEY` for NHS-SIM, `OPENAI_API_KEY` for both agents.
   A variable already exported in the shell silently wins over `.env`.
2. On mount, `App.jsx` fires one `POST /api/connect` with an empty `key`
   (guarded by a ref so React StrictMode's double-invoke in dev doesn't fire
   it twice).
3. `resolveKey()` in `server.js` uses `payload.key` if non-empty, else falls
   back to `process.env.SIM_API_KEY`. So if `SIM_API_KEY` is set, the app
   connects automatically with no dialog; if not, `/api/connect` 401s and
   the UI opens **Connect simulator** for the user to paste a team key by
   hand.
4. `handleConnect` calls `upstream(key, '/api/team')` (`GET`, `Authorization:
   Bearer <key>`) and returns `{ team }`. The UI shows "Connected ·
   `{team.world}`" and keeps `key` only in React state for the lifetime of
   the tab — never persisted, never logged.
5. `OPENAI_API_KEY` is never sent to or seen by the browser at any point; it
   is read only inside `careAgent.js`, server-side.

Every route in `server.js` checks the request's `Host` header against
`localhost`/`127.0.0.1` (loopback only) and, when a browser `Origin` header
is present, against an allowlist of the dev/prod ports — a same-machine
script (curl, tests) has no `Origin` and is already covered by the loopback
check.

## 2. Check one patient

Triggered by submitting a patient ID in the "Check one patient" view.

```
Browser                    Node server                         NHS-SIM / OpenAI
   │  POST /api/check           │
   │  { key, patientId }        │
   ├───────────────────────────►│
   │                            │  GET /api/sites/hospital/documents
   │                            ├─────────────────────────────────►│
   │                            │◄─────────────────────────────────┤ { resources, patients }
   │                            │  (pick latest discharge-summary per patient by sentAt)
   │                            │
   │                            │  GET /api/sites/community/view
   │                            ├─────────────────────────────────►│
   │                            │◄─────────────────────────────────┤ { resources }
   │                            │
   │                            │  app.run(decisionAgent, prompt)  ── discharge sections + patient context
   │                            ├─────────────────────────────────►│ (OpenAI model via ADK)
   │                            │◄─────────────────────────────────┤ structured decision (zod-validated)
   │                            │
   │                            │  bookingsToEvaluate(decision, bookings, dischargeAt)   [pure, local]
   │                            │
   │                            │  app.run(matchAgent, prompt)  ── decided care type + rationale + bookings
   │                            ├─────────────────────────────────►│ (OpenAI model via ADK — skipped if
   │                            │◄─────────────────────────────────┤  bookingsToEvaluate returned none)
   │                            │  structured per-booking verdicts (zod-validated)
   │                            │
   │                            │  reconcile(decision, bookings, dischargeAt, matchVerdicts)   [pure, local]
   │◄───────────────────────────┤  { patientId, patientName, dischargeSummary, decision, bookings, reconciliation }
   │  render ResultDetail       │
```

Server-side, in order (`handleCheck` → `runCheck` in `server.js`):

1. **`hospitalDischarges(key)`** — `GET /api/sites/hospital/documents`
   (`offset: 0, limit: 500`). Filters resources to `kind ===
   'discharge-summary'`, groups by `patientId`, and keeps the one with the
   latest `data.sentAt` (falling back to `createdAt`) — a patient can have
   more than one discharge episode, and `version` does not track recency.
   Also returns the `patients` directory from the same response.
2. **`communityResources(key)`** — `GET /api/sites/community/view`
   (`offset: 0, limit: 500`), fetched once, filtered to this patient later.
3. **`runCheck(key, patientId, discharges, resources)`**:
   - If there's no discharge document for this patient → short-circuit with
     `{ status: 'no-discharge-summary' }`. No agent call, no reconciliation.
   - Resolve the patient record from the discharge-documents response, or
     `findPatientById()` as a fallback (`GET /api/sites/{hospital,gp,community}/patients?q=<id>`).
   - **`evaluateDischargeNote({ sections, patient })`** (`careAgent.js`):
     - Lazily builds one cached ADK `discharge_care_decision` agent on a
       shared `adk()` app: system prompt + `app.context.history()` (required
       for the model to actually see the prompt passed to `app.run`),
       `model: openai('gpt-5.6-luna')`, `output: { schema: decisionSchema }`.
       Throws `AgentError` up front if `OPENAI_API_KEY` is unset.
     - Formats the prompt as discharge-note sections plus the patient's
       known conditions/needs. **Never sees any booking data** — the
       decision is deliberately anchored only to the note, not to what's
       already booked.
     - Calls `app.run(agent, prompt)`, then **re-validates**
       `result.output.value` with `decisionSchema.safeParse` — ADK's
       structured output is a "forgiving" parser, not a hard schema gate, so
       this re-check is the actual boundary. A failed call or a bad shape
       both raise `AgentError`.
     - Returns `{ careNeeded, careType, urgency, ambiguous, confidence,
       rationale }`.
   - **`bookedCareFor(resources, patientId)`** — filters the community
     resources to this patient and normalizes each into `{ id, kind, title,
     status, startsAt: dueAt ?? createdAt, data }`.
   - **`bookingsToEvaluate(decision, bookings, dischargeAt)`** (`model.js`,
     pure) picks the subset worth asking the care-match agent about: none at
     all if the decision was ambiguous or no care was needed, otherwise the
     bookings dated after discharge.
   - **`evaluateCareMatch({ careType, rationale, bookings })`**
     (`careAgent.js`) — skipped entirely (no OpenAI call) when
     `bookingsToEvaluate` returned nothing. Otherwise:
     - Lazily builds a second cached ADK agent, `care_booking_match`, same
       app instance, its own system prompt + `output: { schema: matchSchema
       }` (an array of `{ id, verdict, reason }`, `verdict` one of
       `matches`/`no-match`/`ambiguous`).
     - Prompt is the decided care type, the decision's `rationale`, and each
       booking's id/title/kind/status/date/data — reasoning about whether
       the booking plausibly *delivers* that care type, not matching literal
       keywords. A booking too generic or terse to tell either way should
       come back `ambiguous`, the same "don't guess" principle as the
       decision agent.
     - Re-validates with `matchSchema.safeParse`, then confirms every
       booking id sent got a verdict back — the schema alone can't catch the
       model silently dropping one. Either failure raises `AgentError`.
   - **`reconcile(decision, bookings, dischargeAt, matchVerdicts)`**
     (`model.js`, pure — see §4 below) produces the final `{ status, reason,
     urgencyScore, scoreExplanation, bookingEvaluations }`.
4. The full result — discharge summary, decision, bookings, and
   reconciliation — goes back to the browser in one response and renders in
   `ResultDetail`: status + urgency badges, the reconciliation's own reason
   and score explanation, the discharge note's sections, the decision's
   fields and rationale, and every booking with its own match verdict and
   reason (§4 makes this list, not just the final status).

## 3. Full sweep

Triggered by "Run full sweep" in the sweep view. Same building blocks as a
single check, run over every patient with a discharge summary:

1. `handleSweep` fetches `hospitalDischarges()` and `communityResources()`
   **once each** for the whole sweep (not per patient — this used to be a
   per-patient re-fetch of the ~22KB community view and turned a ~60-patient
   sweep into ~60 duplicate requests).
2. Every patient ID in `discharges.latest` is checked via
   `runCheckTolerant`, batched `SWEEP_CONCURRENCY` (5) at a time with
   `Promise.all` — enough parallelism to not be serial, not so much that one
   sweep fires every OpenAI call at once.
3. `runCheckTolerant` wraps `runCheck`: a `SimulatorError` or `AgentError`
   for one patient (an outlasted-retry sim blip, a bad agent response)
   becomes that patient's own `{ status: 'check-failed', error }` row
   instead of failing the whole sweep. Any other (unexpected) error still
   rethrows and surfaces as a 500 — a real bug isn't silently swallowed
   per-patient.
4. The response is `{ results, checkedAt }`. The UI derives sweep-summary
   counts (`flag`/`review`/`ok`/`all`), filters by status and a text search,
   and **sorts by `reconciliation.urgencyScore` descending** — this ranking
   is the reason a sweep exists. A `check-failed` row has no reconciliation
   and sorts as `0`, alongside `ok`.
5. Clicking any row opens the same `ResultDetail` used for a single check.

## 4. Reconciliation decision logic (`model.js`, pure, unit-tested)

Matching is no longer keyword-based — it comes from the care-match agent's
per-booking `verdict` (§2 above). Everything in this section is pure and
unit-tested against a *fixed* verdict Map, not by actually calling the
agent (see §5 of `AGENTS.md`'s testing expectations).

Given `decision` (from the decision agent), `bookings` (from NHS-SIM),
`dischargeAt`, and `matchVerdicts` (from the care-match agent, covering
exactly the bookings `bookingsToEvaluate` selected):

**Per booking** (`evaluateBookings`), in order:
1. Is it dated after discharge? A booking or discharge date that's missing
   or unparseable counts as "not provably before discharge" (favors
   under-flagging over over-flagging on bad data), not excluded outright.
   If it's *provably* before discharge → `matches: null`, "booked before
   discharge."
2. If the decision itself was `ambiguous` → `matches: null`, "decision was
   ambiguous, not checked."
3. If no care was decided as needed → `matches: null`, "no care needed, not
   checked."
4. Otherwise, look up this booking's id in `matchVerdicts`: `verdict:
   'matches'` → `matches: true`; `'no-match'` → `matches: false`;
   `'ambiguous'` (the agent couldn't tell from the booking's text) →
   `matches: null`. The reason shown is the agent's own one-line
   explanation, not a keyword.

**Overall outcome** (`outcomeFor`), using only the *post-discharge*
bookings' verdicts:

```
decision.ambiguous?                → review  "decision was ambiguous"
!decision.careNeeded?               → ok      "no follow-on care identified as needed"
no post-discharge bookings?         → flag    "care decided as needed, nothing booked after discharge"
any post-discharge match=true?      → ok      "booked care matches the decision"
every post-discharge match=false?   → flag    "booked care doesn't match the decision"
otherwise (a false/ambiguous mix,
  or all ambiguous, no confirmed
  match)                            → review  "could not be confidently matched"
```

A mix of verdicts across a check's bookings is now a real possibility (the
agent judges each booking on its own merits, unlike the old keyword check,
which depended only on `decision.careType` and so was constant across a
whole check) — one confirmed match anywhere in the list is enough for `ok`,
even alongside other non-matching bookings for that same patient.

**Urgency score** (`urgencyScoreFor`) ranks *discrepancies* only —
`ok` and "no discharge summary" always score `0`, there's nothing to
triage:

| Outcome | Note marked `urgent` | Note marked `routine` |
|---|---|---|
| `flag` | 100 | 50 |
| `review` | 80 | 30 |

This deliberately ignores `decision.confidence` — how sure the *decision* is
and how urgently a *gap* needs a human look are different questions, and
confidence stays a separate, visible field rather than silently discounting
the score.

## 5. Error handling and retries

- **`upstream()`** (`server.js`) retries a NHS-SIM call up to 3 times, with
  increasing backoff, only on a thrown network error or a `502`/`503`/`504`
  (the simulator sits behind a Caddy proxy that occasionally returns a
  bare, empty-body `502` from an otherwise healthy backend). A `401`, `403`,
  or any other status fails immediately — a bad key shouldn't wait out three
  attempts.
- `SimulatorError` and `AgentError` carry user-safe messages and map to
  specific HTTP statuses (`401` bad key, `403` no access, `504` unreachable,
  `502` other upstream failure, or either agent's own error — a failed
  decision call, a failed match call, or a mismatched/incomplete response
  from either). Both are logged server-side (message only — never a key or
  patient payload) and returned to the client as `{ error }`.
- Any other, unexpected error is rethrown to the outer handler in
  `server.js`, logged with its stack, and returns a generic `{ error:
  'Internal server error.' }` with **no internal detail leaked** to the
  client.
- A sweep isolates per-patient failures (§3.3); a single check simply
  surfaces the error to the form.

## 6. What this flow deliberately does not do

- No write calls to NHS-SIM anywhere in this path — every fetch above is a
  `GET`. There is no code path that books, cancels, or edits a record, or
  messages a community service.
- No use of `GET /api/sites/community/appointments` — despite the name, it's
  a single day's slot-capacity schedule, not a per-patient booking list, and
  400s without a `date`.
- No caching or persistence of `SIM_API_KEY`/`OPENAI_API_KEY` beyond
  server-process memory and (for the sim key only) the browser tab's React
  state for the session.

See [`AGENTS.md`](./AGENTS.md) for the fuller NHS-SIM API reference, the ADK
integration pitfalls that produced some of the behavior above, and the
clinical-product guardrails this flow exists to satisfy. When this flow
changes, update this file in the same change.
