# Careloop

Install dependencies and start the dev servers from the repository root:

```sh
npm install
npm run dev
```

Then open http://localhost:5173. Vite serves the React frontend and proxies `/api` requests to the Node API on http://localhost:8000.

If startup reports `EADDRINUSE`, another Careloop dev session is already using ports 5173 and 8000. Use that session or stop it before running `npm run dev` again. Vite intentionally does not switch to another port because the API only accepts requests from the configured local frontend origin.

If `SIM_API_KEY` is set in the root `.env`, the dashboard connects to it automatically on load — no dialog needed. Without one set, it opens **Connect simulator** for you to paste your NHS-SIM team API key by hand. The care-decision agent needs `OPENAI_API_KEY` set in the same `.env`; this is a separate key from `SIM_API_KEY` and is only ever read on the server.

## What it does

**Full sweep** (`POST /api/sweep`) checks the latest filed discharge summary for
each patient, with up to twelve patient evaluations running concurrently.
Hospital documents and community bookings are fetched once each, in parallel,
and shared across the sweep. This avoids waiting for every model call in
sequence; total time still depends on model latency and rate limits. The route
streams progress as newline-delimited JSON, and the UI shows the completed and
total patient counts while results are running. Results arrive when the sweep
finishes. The results show the successful-check count
and list failed patient IDs for individual retry; failed checks are not matches.
Select any flagged, review, or matching patient in the sweep to open the same
patient-detail view used by an individual check, without running the model again.
While running, the page explains that model evaluations can take several minutes.
Running a sweep is read-only. A home visit can only be booked after selecting a
patient and explicitly confirming the editable draft in their patient view.

Unchanged model decisions are reused for up to five minutes across sweeps and
individual checks. The cache is isolated by team key and the complete agent
input, capped at 500 entries, held only in server memory, and cleared on restart.
Its lookup keys are hashes; it does not store credentials or discharge inputs.
Changed notes or patient context trigger a new evaluation, and failed evaluations
are retried. Bookings are fetched fresh and reconciliation runs again on every
check, including when the decision is reused. First-run speed still depends on
model latency and rate limits; repeat sweeps avoid unchanged model calls.

Enter a patient ID (e.g. `SIM-000001`) and Careloop:

1. Looks up their latest filed discharge summary from Hospital EPR documents.
   Only documents with `status: "filed"` are eligible; drafts, sent documents,
   and other statuses are excluded before selecting the latest summary.
   Patients without a filed summary are reported as having no discharge summary
   in individual checks and are omitted from the sweep.
2. Passes the free-text sections to the care-decision agent, which decides
   whether follow-on community care is needed and, if so, which single
   category best fits (only one of which — `home-visit` — this tool can act
   on directly; see below). The agent also writes a short plain-language
   **summary** of the note for a non-clinical reviewer.
3. Reads what Community Care has actually booked for that patient and shows
   whether it matches the decision: **Matches**, **Flagged** (care needed,
   nothing matching booked after discharge), or **Needs review** (an
   ambiguous decision, or a booked care type that can't be confidently
   matched by the care-match agent).

The care-decision detail is not displayed. A compact **Full discharge summary
letter** disclosure expands to show every raw note section together (Reason
for admission, Hospital course, Results, Diagnoses, Medication changes,
Follow-up, GP actions). NHS-SIM's camelCase keys are reformatted into these
readable headings.

Care matching uses a second ADK agent, given the decided care type and rationale
plus each eligible booking's title, kind, status, and details. It returns a
`matches`, `no-match`, or `ambiguous` verdict and a reason for each booking.
The matcher does not see the raw discharge note. Terse titles such as "hi" or
"moni" should produce ambiguity when the remaining details cannot establish a
match. One confirmed match is enough for **Matches**; all confirmed non-matches
produce **Flagged**; otherwise the result is **Needs review**. Missing verdicts
cannot count as matches. Treat these judgments as prompts for human review.

Only bookings not provably before discharge are evaluated, and only when care
is needed, the decision is unambiguous, and a care type is present. Match
verdicts are evaluated afresh even when the discharge decision is cached, so
repeat checks with eligible bookings still make a model call. Both agents use
the server-side `OPENAI_API_KEY`. See [the full sequence](../flow.md).

## Booking a home visit

When the decision is **home-visit**, care is needed, the decision isn't
ambiguous, and no matching booking was found, Careloop drafts a booking —
title and a natural-language handover for the community team, written by the
same LLM call from the note's specific detail. An actionable home-visit
decision is rejected if that model output is missing or empty, rather than
falling back to generic booking text. Careloop shows the draft as an editable form. You
can:

- Edit the title or note text.
- Click **Book this visit** to send it, or **Not now** to leave it unbooked.

Booking uses the same in-memory simulator team key as the patient check.
An empty optional note is omitted to meet the simulator request schema.
Each transient POST retry gets a fresh timeout and reuses the same idempotency key.
Writes get a longer timeout than reads (45s vs 20s): the simulator's
`schedule_visit` takes 13-19s just to answer, so the shorter read timeout used
to abort a booking mid-flight and re-send it, or report an unreachable
simulator that was merely slow.

Confirming calls NHS-SIM's `schedule_visit` action
(`POST /api/sites/community/actions`) with an idempotency key, so a retried
request after a network blip doesn't create a duplicate booking. As part of
that same click, Careloop sends a simulated SMS confirming the visit, via NHS-SIM's `messaging_action` on the GP site. This takes two commands: a
`create`, which only *queues* the message, then a `delivery` marking that
message delivered. Both are needed — NHS-SIM's patient-facing view
(`/wearables/messages/`) lists a message only once it is delivered, so a
queued-but-undelivered SMS is invisible to the patient. NHS-SIM never sends a
real SMS.
The message uses the confirmed visit `dueAt` in Europe/London time; when
no visit time is returned, it says the community team will confirm it separately.
Record creation time is never presented as the appointment time. If the SMS
can't be sent *or* can't be delivered, the booking still stands (it's already
been made); Careloop reports `notified: false` so you can let the patient know
another way — "notified" means the patient can actually see the message, not
merely that it was queued. These three calls are
the **only** writes Careloop performs — every other care type and every
other NHS-SIM interaction stays read-only, and nothing is ever booked (or
messaged) without an explicit click. See `AGENTS.md`'s clinical guardrails
for the full policy.

If a home visit is already booked, or the decision needs a human read first
(ambiguous, or an unverifiable match), Careloop shows that state instead of
a form — there's nothing to book yet, or it's already done.

## What it doesn't do

Every care type other than home-visit, and every other NHS-SIM interaction
(reading hospital documents, patient lookups, community bookings), stays
read-only — Careloop never books, cancels, edits, or messages on behalf of
those. A **Flagged** result for those types is a starting point for a human
to arrange care through the usual process, not a confirmed missed handoff:
missing a matching booking doesn't prove care wasn't arranged some other way.

Run `npm test` to check the reconciliation and care-type matching rules, and
`npm run build` to create the production frontend in `dashboard/dist`. After
building, `npm start` serves the complete app through the Node server at
http://localhost:3000. Both development servers bind to loopback only. API
reference: https://sim.animahacks.com/docs/explorer/.
