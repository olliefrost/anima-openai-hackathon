# AGENTS.md

## Project overview

This repository contains **Careloop**, a local tool focused on one thing:
does this patient need a home visit booked, and if so, get it booked. For a
given patient ID it:

1. Reads the patient's latest hospital discharge summary from NHS-SIM.
2. Uses an Anima ADK agent (backed by an OpenAI model) to structure the
   free-text discharge note and decide whether community follow-up care is
   needed and, if so, which single category best fits (of 8 — see
   `careTypes` in `src/model.js`) — flagging the decision itself as
   ambiguous rather than guessing when the note doesn't say enough. The same
   call also writes a short plain-language summary of the note, and, only
   when the decided type is home-visit, drafts a booking title/text.
3. Reads what community services actually have booked for that patient and
   reconciles it against the decision: care needed but nothing booked
   (`flag`), a booking that doesn't match the decided type (`flag`), an
   ambiguous decision or an unverifiable match (`review`), or a match
   (`ok`) — each carrying an urgency score for triage.
4. **When (and only when) the decision is home-visit, needed, not
   ambiguous, and nothing matching is booked**, shows the drafted booking as
   an editable form. A human can edit it, then explicitly confirm to book
   it via NHS-SIM's `schedule_visit` action, or dismiss it. Nothing is ever
   booked without that click. As part of that same confirmed action — not a
   separate, independently-triggered write — Careloop also sends the patient
   an SMS (via the GP site's `messaging_action`) telling them the date and
   time their visit is booked for.

Every other care type, and every other NHS-SIM interaction (hospital
documents, patient lookups, community bookings), stays **read-only** — this
tool never books, cancels, or edits anything else, and never contacts
community services outside of that one confirmed action.

This end-to-end flow has been run live against NHS-SIM and a real OpenAI
model (not just unit-tested): fetch discharge note → agent decision → fetch
booked care → reconcile → (when applicable) book a home visit via a real
`schedule_visit` call, confirmed against the live OpenAPI spec at
`/api/openapi.json`. See the API and agent notes below for real bugs and
findings that surfaced during that work and how they were handled.

A prior version of this tool covered all 8 care types symmetrically and
included a "full sweep" view checking every discharged patient at once,
ranked by urgency. That view and its `/api/sweep` route were removed when
the UI was refocused specifically on home visits and booking — the
reconciliation logic for all care types stays in `model.js` (still fully
tested) since the agent still needs it to decide what a note is asking for,
but only home-visit is actionable from the UI today. Re-introducing a
multi-patient sweep is a reasonable future feature, not a regression to
"fix."

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
- `dashboard/src/App.jsx` — React UI: connect to a team, check one patient by ID, view the discharge summary/original note/decision, and — for a home-visit gap — review, edit, and confirm a booking.
- `dashboard/src/model.js` — pure reconciliation rules (`reconcile`, `bookingsToEvaluate`, `evaluateBookings`) and the `careTypes` vocabulary. Still covers all 8 care types even though only home-visit is bookable from the UI — the agent needs the full vocabulary to classify a note correctly.
- `dashboard/src/model.test.js` — Node test coverage for the reconciliation rules.
- `dashboard/vite.config.js` — Vite build and Node development proxy.
- `dashboard/server.js` — loopback-only Node static server, the read-only NHS-SIM proxy (`/api/connect`, `/api/check`), and the one write route, `/api/book-home-visit`, gated on an explicit UI confirmation — it both schedules the visit and sends the patient a confirmation SMS as one operation.
- `dashboard/careAgent.js` — the ADK agent that turns discharge-note sections into a structured care decision, a plain-language summary, and (when applicable) a draft home-visit booking.
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
`/api/openapi.json`.

- **Auth**: `Authorization: Bearer <SIM_API_KEY>` on every request.
- **Sites in scope for this tool**: `hospital` (discharge documents),
  `community` (bookings, and the `schedule_visit` write), `gp` (the
  `messaging_action` SMS confirmation sent after a booking succeeds).
  `pharmacy`, `diagnostics`, `referrals`, `wearables` also exist but aren't
  used by this tool.
- **`POST /api/sites/{site}/actions`** — the one write endpoint in the whole
  API (confirmed against the live `/api/openapi.json`); every action type
  (`create_task`, `book_appointment`, `schedule_visit`, `draft_prescription`,
  `messaging_action`, etc. — over 40 in total) goes through this single
  generic route, keyed by a `type` field in the body, not a dedicated
  endpoint per action. Careloop makes exactly two calls through it, both
  from `scheduleHomeVisit()` in `server.js`, both firing only from the one
  explicit UI confirmation (see clinical guardrails below):
  1. `site: 'community'`, `type: 'schedule_visit'`:
     ```json
     { "type": "schedule_visit", "patientId": "SIM-000006", "title": "Post-discharge home visit", "text": "Community nursing review following hospital discharge." }
     ```
     The 200 response is a `Resource` (id, kind, title, status, patientId,
     `dueAt`/`createdAt`, `data`) — normalize it with
     `normalizeCommunityResource()` (also used for read results) so a freshly
     booked visit looks identical to one that was already there.
  2. `site: 'gp'`, `type: 'messaging_action'`, fired immediately after (1)
     succeeds, using the booked visit's `dueAt` to tell the patient when
     their visit is booked for:
     ```json
     { "type": "messaging_action", "patientId": "SIM-000006", "messagingCommand": { "kind": "create", "subject": "Home visit booked", "body": "Your home visit has been booked for 13 September 2026, 14:00.", "channel": "sms", "allowReply": true } }
     ```
  3. `site: 'gp'`, `type: 'messaging_action'` again, with the `delivery`
     command, fired immediately after (2) succeeds. **A `create` only
     *queues* the message.** Confirmed live: NHS-SIM's patient-facing view
     (`/wearables/messages/`) lists a conversation only once its outgoing
     entry is marked `delivered` — every seeded message that shows there is
     `queued > delivered`, and one seeded `queued > failed` message does not
     show. Without this third call the SMS sits in the GP mailbox and the
     patient never sees it:
     ```json
     { "type": "messaging_action", "resourceId": "r-4225", "expectedVersion": 1, "messagingCommand": { "kind": "delivery", "entryId": "r-4225-1", "status": "delivered" } }
     ```
     `entryId` is the **outgoing entry inside the conversation**
     (`data.entries`), not the conversation's own id, and `expectedVersion`
     is the conversation version returned by (2). The valid kind is
     `delivery`, not `deliver`, and `entryId`/`status` are both required —
     `status` is one of `delivered`/`failed`. The same command is also
     available on the dedicated `POST /api/sites/gp/messages` route, where
     the field is `command` rather than `messagingCommand`; it is **not**
     accepted on `/api/sites/patient/messages`, which only takes
     `patient_create` and `reply`.

     A failure at (2) or (3) does not fail or retry the booking, which
     already succeeded — `scheduleHomeVisit()` reports it back as
     `notified: false` instead, so the UI can tell the reviewer to notify the
     patient another way, without risking a duplicate visit from an automatic
     retry. `notified: true` means the patient can actually see the message,
     so a create that never delivers counts as false.
  All three calls send an `Idempotency-Key` header (a stable string per
  attempted write, e.g. `home-visit-<patientId>-<timestamp>-<random>`, with
  `-notify` and `-deliver` appended for the second and third calls) — NHS-SIM's own docs say to reuse it when
  retrying an uncertain response and use a new one for a genuinely new
  action; the shared `postAction()` helper retries transient failures
  (network error, 502/503/504) with the same key for exactly this reason,
  the same transient set `upstream()` retries for reads. Other action
  `type`s exist (task creation, referrals, prescriptions, appointments,
  etc.) but none are called by this tool — adding another is a deliberate
  scope change, same as these two were (see clinical guardrails below).
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
  Reconciliation uses a second ADK agent (`evaluateCareMatch` in
  `careAgent.js`) to return a matches/no-match/ambiguous verdict and reason
  per eligible booking. Too-terse evidence must remain ambiguous. One match
  is enough for ok; all non-matches yield flag; otherwise review. These are
  judgments for human review, not proof of delivered or omitted care.
- **`GET /api/sites/{site}/patients?q=<id>&offset=0`** — patient search/read,
  used as a fallback when a patient isn't in the discharge-documents response.
- **Available but unused by this tool**: `referrals` site / `GET
  /api/nhs/ers` ("Create, read, accept and reject referrals" per the
  catalogue) — referral resources carry a `status`
  (`accepted`/`rejected`/pending) and a `visibleTo` list; this was once
  flagged as the likely mechanism for a future write path, but the actual
  write path that shipped (`schedule_visit` via `/api/sites/{site}/actions`,
  above) didn't need it. `eps` (prescriptions), `pds`/`ods` (FHIR
  demographics/org lookups), and `pathology`/`radiology` are also available.
  None of these are called today; wiring one up is a deliberate scope
  change (see clinical guardrails below), not a drive-by addition.
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
- **Writes are far slower than reads, and the timeouts differ accordingly.**
  Measured live: `POST /api/sites/community/actions` with `schedule_visit`
  took 19.0s and 13.2s to answer, while `GET /api/team` took 240ms. Writes
  therefore use `WRITE_TIMEOUT_MS` (45s) and reads `READ_TIMEOUT_MS` (20s).
  Don't collapse these back into one value: at a shared 20s cutoff a booking
  aborted mid-flight, counted as a transient failure, and was re-sent —
  making one ~15s call take ~34s, or fail after ~61s with a false "Cannot
  reach NHS-SIM" against a simulator that was reachable and just slow.
- **`409 No service capacity`** is what `schedule_visit` returns when the
  community team has no slots left (`capacity-community` in the community
  view carries `{ total, remaining }`; confirmed live at `remaining: 0`,
  which blocks booking for *every* patient in that world). 409 is
  deliberately not retried — it's a real refusal, not a transient failure.
- **`communityResources()` fetches the whole community view once; `bookedCareFor()`
  is a pure filter over the result, not a fetch.** This split dates back to
  when `handleSweep` (since removed, see the project overview above) called
  `runCheck` once per patient in a loop — without it, each patient re-fetched
  the same ~22KB view, turning a sweep over ~60 patients into ~60 identical
  requests. `handleCheck` only ever checks one patient now, so the stakes are
  lower, but keep the split: don't inline the community-view fetch back into
  `bookedCareFor()` or `runCheck()`.

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
  reasonable confidence (see `evaluateCareMatch` in `careAgent.js`) must also
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
- **NHS-SIM access is read-only, with exactly two deliberate exceptions,
  both fired by one confirmed action**: booking a home visit via
  `schedule_visit`, and — as an inseparable part of that same booking, not a
  second independently-triggered write — sending the patient an SMS via the
  GP site's `messaging_action` telling them the date and time (see the API
  reference above). The SMS costs two calls rather than one (`create` then
  `delivery`) because NHS-SIM only queues a created message; that is one
  exception implemented in two steps, not a third exception. Both only ever happen when a human has explicitly
  confirmed the drafted form in the UI — never automatically on their own
  trigger, never from a sweep or batch context, and never for any other care
  type or action. This pair was discussed and scoped deliberately; widening
  it further (another action type, another site, an unconfirmed send
  detached from a booking) is itself a new deliberate, discussed scope
  change, not a natural extension of the one that's already there.
- The booking form is always pre-filled from the agent's own
  `homeVisitBooking` draft but is user-editable before sending, and the
  human can decline it ("Not now") — the UI must never auto-submit it. The
  SMS text is not user-editable; it's generated from the booked visit's
  confirmed date/time, not from free text a reviewer could alter.
- Use a fresh `Idempotency-Key` per booking attempt (see the API reference
  above) so a retried request after a transient failure can't create a
  duplicate visit for the same intent. The SMS reuses that key with a
  `-notify` suffix rather than getting its own independent one, so it stays
  traceable to the same booking intent.
- A failed SMS send *or delivery* must never fail, retry, or duplicate the booking itself
  — the booking already succeeded and is the higher-stakes write. Surface it
  to the reviewer (`notified: false`) so they know to tell the patient
  another way, instead of silently dropping it or risking a double booking.
- Synthetic records must remain conspicuously labelled as demo data; never
  silently mix synthetic and live data.

## Testing expectations

- Run `npm test` after changing reconciliation or care-type matching logic.
- Add or update focused cases in `dashboard/src/model.test.js` for every
  rule change, including boundary conditions (ambiguous decisions, no care
  needed, bookings before vs. after discharge, unverifiable care types).
- For UI or server changes, also start `npm run dev` and manually verify the
  single-patient check at desktop and narrow viewport widths.
- When changing simulator or agent integration, don't stop at unit tests —
  run an actual `/api/check` against a real patient ID with a real
  `SIM_API_KEY` and `OPENAI_API_KEY` and read the response. Unit tests
  can't catch a wrong upstream endpoint (see the `community/appointments`
  note above) or a misconfigured agent context (see the ADK notes above);
  both passed every unit test while silently returning wrong or empty
  results. Also verify invalid credentials, a missing discharge summary, and
  a missing `OPENAI_API_KEY`, without logging secrets or patient payloads.
- When changing anything on the `schedule_visit` write path, verifying it
  means actually calling `/api/book-home-visit` against the live simulator
  at least once, not just asserting the request shape — but because it
  creates a real (synthetic) resource in a shared team world, confirm with
  whoever's driving the session before firing that live call, the same as
  any other action with a side effect outside your local environment.

## Documentation

Update `dashboard/README.md` when setup, environment variables, routes,
user-visible heuristics, privacy behavior, or operating limitations change.
Keep instructions runnable from the repository root.

## Agent matching and current flow

The care-decision and care-booking-match agents share one ADK app, each with
system context, history, and revalidated structured output. Keep agent I/O in
`careAgent.js`; reconciliation consumes a fixed verdict Map and stays pure.
The matcher sees only the decided care type, rationale, and eligible bookings,
not the raw discharge note. Validate exactly one verdict per input booking ID.
Skip matching for ambiguous decisions, no care needed, no care type, or no
eligible bookings. Missing timestamps are not proof of a pre-discharge booking.

Current main has restored `/api/sweep`: twelve concurrent patient checks share
fresh hospital/community reads. Only filed summaries qualify. The five-minute
team-isolated decision cache remains; booking matches run fresh on each check.
The editable home-visit draft and confirmed booking/SMS operation remain intact.
An ambiguous booking match yields review and must not offer a booking form.

Update [`flow.md`](./flow.md) whenever routes, call ordering, decision branches,
or retry/error behavior change. Test reconciliation with fixed verdict Maps,
including mixed, ambiguous, and missing verdicts; verify agent integration live.
