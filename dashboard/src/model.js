// Pure, testable rules for deciding whether booked community care matches a
// discharge decision. No I/O, no framework — see careAgent.js (server-side)
// for the LLM calls that produce a `decision` and, per booking, a match
// verdict, and server.js for the NHS-SIM fetches that produce `bookings`.

export const careTypes = [
  'home-visit',
  'district-nursing',
  'physiotherapy',
  'occupational-therapy',
  'social-care',
  'mental-health-support',
  'medication-review',
  'other',
];

// A booking or discharge time that's missing or unparseable counts as "not
// provably before discharge" rather than being excluded — the guardrail
// here is to under-flag on missing data, not over-flag on it.
function isAfterDischarge(booking, dischargeAt) {
  return !Number.isFinite(dischargeAt) || !Number.isFinite(booking.startsAt) || booking.startsAt >= dischargeAt;
}

// Which post-discharge bookings are actually worth asking the care-match
// agent about (see careAgent.js's evaluateCareMatch). An ambiguous decision
// or "no care needed" already means there's nothing to check a booking
// against — see evaluateBookings below — so callers shouldn't spend an
// agent call on those cases.
export function bookingsToEvaluate(decision, bookings, dischargeAt) {
  if (decision.ambiguous || !decision.careNeeded || !decision.careType) return [];
  return bookings.filter((booking) => isAfterDischarge(booking, dischargeAt));
}

// Per-booking breakdown behind the reconciliation status — every booking
// gets a verdict and a plain-text reason, even ones that didn't end up
// affecting the outcome (booked before discharge, or nothing to check
// against), so a reviewer can see exactly what was and wasn't counted.
//
// `matchVerdicts` is a Map<bookingId, { verdict: 'matches'|'no-match'|
// 'ambiguous', reason }> from evaluateCareMatch(), covering exactly the
// bookings bookingsToEvaluate() would return for this same decision. A
// booking excluded before that point (booked before discharge, ambiguous
// decision, no care needed) never reaches the agent and gets its own reason
// here instead — it's never looked up in the map.
export function evaluateBookings(decision, bookings, dischargeAt, matchVerdicts = new Map()) {
  return bookings.map((booking) => {
    const afterDischarge = isAfterDischarge(booking, dischargeAt);
    if (!afterDischarge) {
      return { id: booking.id, afterDischarge, matches: null, reason: 'Booked before discharge — not counted as follow-up care.' };
    }
    if (decision.ambiguous) {
      return { id: booking.id, afterDischarge, matches: null, reason: 'The care decision itself was ambiguous, so this booking was not checked against a care type.' };
    }
    if (!decision.careNeeded || !decision.careType) {
      return { id: booking.id, afterDischarge, matches: null, reason: 'No follow-on care was identified as needed, so this booking was not checked against a care type.' };
    }
    const verdict = matchVerdicts.get(booking.id);
    if (!verdict) {
      return { id: booking.id, afterDischarge, matches: null, reason: 'Not evaluated against the decided care type.' };
    }
    const matches = verdict.verdict === 'matches' ? true : verdict.verdict === 'no-match' ? false : null;
    return { id: booking.id, afterDischarge, matches, reason: verdict.reason };
  });
}

function outcomeFor(decision, evaluations) {
  if (decision.ambiguous) {
    return { status: 'review', reason: 'The discharge note decision was ambiguous and needs a human read.' };
  }

  if (!decision.careNeeded) {
    return { status: 'ok', reason: 'No follow-on community care identified as needed from the discharge note.' };
  }

  // A booking or the discharge note can be missing a usable timestamp (NHS-SIM
  // doesn't guarantee one on every resource). Treat "unknown" as "can't prove
  // it was before discharge" rather than excluding it — the guardrail here is
  // to under-flag on missing data, not to over-flag on it.
  const postDischarge = evaluations.filter((evaluation) => evaluation.afterDischarge);

  if (postDischarge.length === 0) {
    return { status: 'flag', reason: `Discharge note calls for ${decision.careType || 'follow-up care'}, but no community booking was found after discharge.` };
  }

  const checks = postDischarge.map((evaluation) => evaluation.matches);

  if (checks.some((check) => check === true)) {
    return { status: 'ok', reason: `Booked community care matches the recommended ${decision.careType}.` };
  }

  if (checks.every((check) => check === false)) {
    return { status: 'flag', reason: `Booked community care does not appear to match the recommended ${decision.careType}.` };
  }

  // No confirmed match, but not every booking was a confirmed non-match
  // either — at least one came back `ambiguous` from the care-match agent
  // (it couldn't tell from the booking's text either way). That's a genuine
  // "needs a human read", not a confident flag.
  return {
    status: 'review',
    reason: `Booked community care for ${decision.careType} could not be confidently matched — needs a human read.`,
  };
}

// Triage score for ranking discrepancies, highest first, in a full sweep (a
// single check just shows its own score). Clinical urgency from the note
// dominates over how *sure* the reconciliation is that there's a gap: an
// urgent case still needs eyes on it quickly even when the best we could do
// is "needs review", not a confirmed "flag". `ok` and a missing discharge
// summary aren't discrepancies at all, so they always score 0 — there's
// nothing to triage. Deliberately doesn't factor in `decision.confidence`;
// that's a statement about how sure the *decision* is, not how urgently a
// human should look at it, and stays a separate, visible field in the UI.
const URGENCY_SCORES = {
  flag: { urgent: 100, routine: 50 },
  review: { urgent: 80, routine: 30 },
};

// Returns the score plus the one-line reasoning behind it — which band
// (flag/review) and which half of it (urgent/routine note) produced this
// number, so the score is never just an unexplained badge.
function urgencyScoreFor(decision, status) {
  const band = URGENCY_SCORES[status];
  if (!band) return { score: 0, explanation: 'No discrepancy identified — nothing to triage.' };
  const urgent = decision.urgency === 'urgent';
  const score = urgent ? band.urgent : band.routine;
  const certainty = status === 'flag' ? 'a confirmed gap' : 'an unconfirmed, needs-review gap';
  const notedUrgency = urgent ? 'urgent' : 'routine';
  return { score, explanation: `${certainty} on a note marked ${notedUrgency} → ${score}.` };
}

// Human-readable version of the score above, for display next to it.
export function urgencyLabel(score) {
  if (score >= 100) return 'Urgent gap';
  if (score >= 80) return 'Urgent — needs review';
  if (score >= 50) return 'Needs follow-up';
  if (score >= 30) return 'Needs review';
  return 'None';
}

// decision: { careNeeded, careType, urgency, ambiguous } from careAgent.js
// bookings: normalized community records for this patient, each with a
//           `startsAt` timestamp where known
// dischargeAt: timestamp the discharge note was sent, for "booked after
//              discharge" comparisons
// matchVerdicts: Map<bookingId, verdict> from careAgent.js's
//                evaluateCareMatch(), for the bookings bookingsToEvaluate()
//                selected — omitted when there was nothing to evaluate.
export function reconcile(decision, bookings, dischargeAt, matchVerdicts = new Map()) {
  const bookingEvaluations = evaluateBookings(decision, bookings, dischargeAt, matchVerdicts);
  const outcome = outcomeFor(decision, bookingEvaluations);
  const { score, explanation } = urgencyScoreFor(decision, outcome.status);
  return { ...outcome, urgencyScore: score, scoreExplanation: explanation, bookingEvaluations };
}
