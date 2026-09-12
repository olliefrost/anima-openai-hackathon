# Careloop flow

Careloop reviews synthetic NHS-SIM records. Decisions and match verdicts are
model judgments, not clinical approval or proof that care was delivered.

## Connect and fetch

1. The frontend posts to `/api/connect`, using the server's `SIM_API_KEY` by
   default or the manually supplied team key. The server reads `/api/team`.
   Keys are never stored in browser storage; `OPENAI_API_KEY` stays server-side.
2. `/api/check` validates a patient ID, reads hospital documents, then reads
   the paginated community view. `/api/sweep` reads both sources in parallel
   once, then runs up to twelve patient checks concurrently over shared data.
3. Only hospital discharge summaries with `status: "filed"` qualify. The
   latest is selected by `data.sentAt`/`createdAt`, never version. Patient
   context comes from the document response, with a patient-search fallback.
   A missing filed summary returns `no-discharge-summary` for a single check;
   that patient is omitted from a sweep.

## Two separate agent calls

1. `runCheck` asks `cachedDecision` for a discharge decision. The decision
   agent sees note sections and patient conditions/needs, never bookings.
   It returns care needed, one of eight care types, urgency, ambiguity,
   confidence, rationale, a plain-language summary, and a home-visit draft
   only for an unambiguous, needed home visit. Structured output is revalidated,
   including whether the draft is present exactly when required.
2. Decisions are reused for five minutes by hashed team key and complete
   input, with at most 500 entries in server memory. Failed calls are evicted;
   changed notes or context cause a new call. No credentials or input notes
   are retained as cache keys.
3. `bookedCareFor` filters the freshly fetched community resources by patient.
   Normalization uses `dueAt`/`createdAt` as the booking's `startsAt`.
4. `bookingsToEvaluate` selects bookings whose start is not before discharge.
   Missing/nonfinite times are included because they cannot establish that a
   booking preceded discharge. No bookings are selected if the decision is
   ambiguous, needs no care, or has no care type.
5. If any bookings qualify, `evaluateCareMatch` calls `care_booking_match`
   with the care type, rationale, and each booking's ID, title, kind, status,
   date, and details. It never sees the raw discharge note. It must prefer
   `ambiguous` to guessing from terse or generic evidence. Each booking gets
   `matches`, `no-match`, or `ambiguous` and a one-sentence reason.
6. Both agents share an ADK app and use system context plus history, so the
   prompt reaches the model. Both outputs are revalidated with zod. Match
   output must cover exactly the input booking IDs without duplicates or
   extras. Invalid output raises an agent error. Matching runs afresh on
   every check, even when the discharge decision is cached.

## Reconciliation and presentation

`reconcile` is pure: it consumes the decision, normalized bookings, discharge
 time, and a Map of match verdicts. Every booking gets an evaluation reason,
 including excluded bookings. Missing verdicts stay unchecked, never matched.

Rules are applied in this order:

| Condition | Status |
|---|---|
| Decision ambiguous | review |
| No care needed | ok |
| No booking eligible by discharge time | flag |
| Any eligible booking matches | ok |
| Every eligible booking is a confirmed non-match | flag |
| Otherwise, including ambiguous or missing verdicts | review |

One match is enough even alongside non-matching or ambiguous bookings.
A flag means no matching booking was found, not a proven failed handoff.

| Discrepancy | Urgent note | Routine note |
|---|---|---|
| flag | 100 | 50 |
| review | 80 | 30 |

An ok result scores zero; missing summaries have no discrepancy to triage.
Confidence is separate and does not discount urgency. The response includes
per-booking reasons and a score explanation. The current UI shows the plain
summary and expandable original letter; sweep entries open the same patient
view without rerunning the check.

## Human-confirmed home visit

Only an unambiguous, needed home-visit decision with a flagged reconciliation
can show the editable agent draft. Review states do not offer a booking form.
The reviewer can edit and confirm **Book this visit**, or choose **Not now**.

The confirmed `/api/book-home-visit` call schedules through the community site's
`schedule_visit` action. It then queues an SMS through the GP site's
`messaging_action`, using the returned visit's `dueAt` in Europe/London time.
Without a confirmed time, the SMS says the team will confirm it separately.
Creation time is never presented as appointment time. SMS failure returns
`notified: false` without failing or retrying the successful booking.
These are the only two simulator writes; sweep and check are read-only.

## Errors, retries, and security

Simulator reads and action writes retry network failures and HTTP 502/503/504
up to three attempts with backoff. Other statuses fail immediately. Each
write attempt has a fresh timeout and retries reuse the same idempotency key;
the SMS key is the booking key plus `-notify`.

Simulator and agent errors surface through the API; unexpected errors return
a generic internal error. Sweep failures are isolated per patient, listed for
individual retry, and never counted as matches. Matching failures do not
silently fall back to keyword matching or a booking opportunity.

The server remains loopback-only, with origin checks, request limits, timeouts,
CSP, and no-store responses. The community appointments endpoint is unused:
it represents daily capacity, not this patient's booked care. Keep this file
aligned with route, agent, reconciliation, and retry changes.
