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

**Full sweep** (`POST /api/sweep`) checks the latest discharge summary for
each patient, with up to twelve patient evaluations running concurrently.
Hospital documents and community bookings are fetched once each, in parallel,
and shared across the sweep. This avoids waiting for every model call in
sequence; total time still depends on model latency and rate limits. Results
arrive when the sweep finishes. The results show the successful-check count
and list failed patient IDs for individual retry; failed checks are not matches.
While running, the page explains that model evaluations can take several minutes.
Sweeps are read-only and never book visits.

Unchanged model decisions are reused for up to five minutes across sweeps and
individual checks. The cache is isolated by team key and the complete agent
input, capped at 500 entries, held only in server memory, and cleared on restart.
Its lookup keys are hashes; it does not store credentials or discharge inputs.
Changed notes or patient context trigger a new evaluation, and failed evaluations
are retried. Bookings are fetched fresh and reconciliation runs again on every
check, including when the decision is reused. First-run speed still depends on
model latency and rate limits; repeat sweeps avoid unchanged model calls.

Enter a patient ID (e.g. `SIM-000001`) and Careloop:

1. Looks up their latest discharge summary from Hospital EPR documents.
2. Passes the free-text sections to the care-decision agent, which decides
   whether follow-on community care is needed and, if so, which single
   category best fits (only one of which — `home-visit` — this tool can act
   on directly; see below). The agent also writes a short plain-language
   **summary** of the note for a non-clinical reviewer.
3. Reads what Community Care has actually booked for that patient and shows
   whether it matches the decision: **Matches**, **Flagged** (care needed,
   nothing matching booked after discharge), or **Needs review** (an
   ambiguous decision, or a booked care type that can't be confidently
   matched by text).

The care-decision detail is not displayed. A compact **Full discharge summary
letter** disclosure expands to show every raw note section together (Reason
for admission, Hospital course, Results, Diagnoses, Medication changes,
Follow-up, GP actions). NHS-SIM's camelCase keys are reformatted into these
readable headings.

Care-type matching against bookings is text-based (keywords against a
booking's title/kind), not exact. A manually scheduled visit with a title
like "home visit follow-up" matches; one titled just "hi" or "moni" — real
examples from NHS-SIM test data — won't, even if it's the right visit. Treat
a **Flagged** result as "worth a human look," not a confirmed miss.

## Booking a home visit

When the decision is **home-visit**, care is needed, the decision isn't
ambiguous, and no matching booking was found, Careloop drafts a booking —
title and a short note for the community team, written by the same agent
call from the note's specific detail — and shows it as an editable form. You
can:

- Edit the title or note text.
- Click **Book this visit** to send it, or **Not now** to leave it unbooked.

Confirming calls NHS-SIM's `schedule_visit` action
(`POST /api/sites/community/actions`) with an idempotency key, so a retried
request after a network blip doesn't create a duplicate booking. As part of
that same click, Careloop also sends the patient an SMS confirming the date
and time, via NHS-SIM's `messaging_action` on the GP site — so they don't
have to hear about the visit from anyone but their own care team. If the SMS
can't be sent, the booking still stands (it's already been made); Careloop
tells you so you can let the patient know another way. These two calls are
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
