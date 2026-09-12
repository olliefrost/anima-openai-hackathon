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

- **Check one patient**: enter a patient ID (e.g. `SIM-000001`). Careloop
  looks up their latest discharge summary from Hospital EPR documents,
  passes the free-text sections to the care-decision agent, reads what
  Community Care has booked for them, and shows whether the booking matches
  the decision.
- **Full sweep**: runs the same check for every patient who has a hospital
  discharge summary, and lists them with a status:
  - **Matches** — booked community care lines up with the decision.
  - **Flagged** — care was decided as needed but nothing matching was
    found booked after discharge.
  - **Needs review** — the agent's decision was ambiguous, or the booked
    care couldn't be confidently matched against the decided care type.
    This is a "look at this yourself" signal, not a claimed match or gap.

A patient with no discharge summary at all is skipped by the sweep and shown
as "No discharge summary found" for a direct check.

A patient whose check couldn't be completed (a transient NHS-SIM error that
outlasted the built-in retries, or an agent failure) shows as "Check failed"
with the reason, instead of failing the whole sweep — re-run the sweep, or
check that one patient directly, to retry it.

For example, a discharge note whose follow-up section says "a physiotherapy
appointment request is pending acknowledgement" decides `careType:
physiotherapy`; if Community Care has no matching booking for that patient,
that's a **Flagged** result, with the specific missing care type in the
reason. A note with no community follow-up mentioned at all decides `careNeeded:
false` and is **Matches** regardless of what else is booked for that patient —
this tool checks the discharge decision against bookings, not the other way
around.

Care-type matching is text-based (keywords against a booking's title/kind),
not exact. A manually scheduled visit with a bare title like "home visit
follow-up" matches; one titled just "hi" or "moni" — real examples from
NHS-SIM test data — won't, even if it's the right visit. Treat a **Flagged**
result as "worth a human look," not a confirmed miss.

Every discrepancy (a **Flagged** or **Needs review** result) also carries an
urgency score, shown as a badge (e.g. "Urgent gap · 100"). It's driven mainly
by the clinical urgency the agent read from the discharge note, not by how
sure the reconciliation is that there's a gap — an urgent note still ranks
above a routine one even when the best the reconciliation could do is "needs
review" rather than a confirmed flag. A full sweep is sorted by this score,
highest first, so the most urgent discrepancies are at the top of the table
without any extra filtering. A single check just shows its own score; there's
nothing to rank against. A **Matches** result always scores 0 — there's no
discrepancy to triage.

## What it doesn't do

Careloop only reads from NHS-SIM (`hospital` documents, `community`
bookings, and patient lookups) — it never books, cancels, edits, or messages
a service on your behalf. A flag is a starting point for a human to check,
not a confirmed missed handoff: missing a matching booking doesn't prove
care wasn't arranged some other way.

Run `npm test` to check the reconciliation and care-type matching rules, and
`npm run build` to create the production frontend in `dashboard/dist`. After
building, `npm start` serves the complete app through the Node server at
http://localhost:3000. Both development servers bind to loopback only. API
reference: https://sim.animahacks.com/docs/explorer/.
