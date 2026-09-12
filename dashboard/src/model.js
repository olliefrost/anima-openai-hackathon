// Pure, testable rules for deciding whether booked community care matches a
// discharge decision. No I/O, no framework — see careAgent.js (server-side)
// for the LLM call that produces a `decision`, and server.js for the NHS-SIM
// fetches that produce `bookings`.

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

// Keyword sets used to recognise a booked resource as satisfying a given
// care type. `other` has no keywords on purpose: it is a catch-all the model
// can pick when nothing else fits, and we can't verify a catch-all against
// booked text without risking a false "match".
const careTypeKeywords = {
  'home-visit': ['home visit', 'home-visit', 'welfare check', 'home care visit'],
  'district-nursing': ['district nurs', 'community nurs', 'wound care', 'dressing change'],
  physiotherapy: ['physio'],
  'occupational-therapy': ['occupational therapy', 'ot review', 'ot assessment', 'equipment assessment'],
  'social-care': ['social care', 'social worker', 'care package', 'carer visit'],
  'mental-health-support': ['mental health', 'wellbeing support', 'psych'],
  'medication-review': ['medication review', 'medicines review', 'pharmacist review'],
};

// Keyword matching only sees whatever text NHS-SIM records for a booking.
// A manually scheduled community visit can have a title as bare as "moni" or
// "hi" (seen in live testing) with no clinical detail at all — that will
// legitimately fail every keyword set even when it's the right care type.
// This is a known precision limit of text matching, not a bug to "fix" by
// guessing; see the `review` fallback below for how ambiguous cases surface.
function bookingText(booking) {
  return [booking.title, booking.kind, booking.status, JSON.stringify(booking.data || {})]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

// Same check as matchesCareType(), but with the reasoning spelled out so the
// UI can show, per booking, exactly why it counted as a match, a non-match,
// or unverifiable — this is what makes a reconciliation result auditable
// instead of a black box.
export function matchExplanation(booking, careType) {
  const keywords = careTypeKeywords[careType];
  if (!keywords) {
    return { matches: null, reason: `"${careType}" has no defined keyword set, so a booking can't be verified against it by text.` };
  }
  const haystack = bookingText(booking);
  const hit = keywords.find((keyword) => haystack.includes(keyword));
  if (hit) return { matches: true, reason: `Booking text matched the "${hit}" keyword for ${careType}.` };
  return { matches: false, reason: `No keyword for ${careType} (e.g. "${keywords[0]}") appears in this booking's title, kind, status, or data.` };
}

// Returns true/false when the care type has a known keyword set, or null
// when the type can't be checked this way (currently only `other`).
export function matchesCareType(booking, careType) {
  return matchExplanation(booking, careType).matches;
}

// Per-booking breakdown behind the reconciliation status — every booking
// gets a verdict and a plain-text reason, even ones that didn't end up
// affecting the outcome (booked before discharge, or nothing to check
// against), so a reviewer can see exactly what was and wasn't counted.
export function evaluateBookings(decision, bookings, dischargeAt) {
  return bookings.map((booking) => {
    // See the comment in outcomeFor() below: missing timestamps count as
    // "not provably before discharge" rather than being excluded.
    const afterDischarge = !Number.isFinite(dischargeAt) || !Number.isFinite(booking.startsAt) || booking.startsAt >= dischargeAt;
    if (!afterDischarge) {
      return { id: booking.id, afterDischarge, matches: null, reason: 'Booked before discharge — not counted as follow-up care.' };
    }
    if (decision.ambiguous) {
      return { id: booking.id, afterDischarge, matches: null, reason: 'The care decision itself was ambiguous, so this booking was not checked against a care type.' };
    }
    if (!decision.careNeeded || !decision.careType) {
      return { id: booking.id, afterDischarge, matches: null, reason: 'No follow-on care was identified as needed, so this booking was not checked against a care type.' };
    }
    const { matches, reason } = matchExplanation(booking, decision.careType);
    return { id: booking.id, afterDischarge, matches, reason };
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

  // matchExplanation() only ever returns null for *every* booking in this
  // list, or for *none* of them: it depends solely on whether careTypeKeywords
  // has an entry for decision.careType (constant across this whole check),
  // not on anything booking-specific. So after "some confirmed match" and
  // "every confirmed non-match" are ruled out, the only case left is every
  // check being null — the care type itself (currently only `other`) has no
  // keyword set to check bookings against, which is worth its own
  // self-explanatory reason rather than a generic "couldn't confirm" one.
  const checks = postDischarge.map((evaluation) => evaluation.matches);

  if (checks.some((check) => check === true)) {
    return { status: 'ok', reason: `Booked community care matches the recommended ${decision.careType}.` };
  }

  if (checks.every((check) => check === false)) {
    return { status: 'flag', reason: `Booked community care does not appear to match the recommended ${decision.careType}.` };
  }

  return {
    status: 'review',
    reason: `"${decision.careType}" has no defined keyword set to check booked care against, so this can't be confirmed automatically — needs a human read.`,
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
export function reconcile(decision, bookings, dischargeAt) {
  const bookingEvaluations = evaluateBookings(decision, bookings, dischargeAt);
  const outcome = outcomeFor(decision, bookingEvaluations);
  const { score, explanation } = urgencyScoreFor(decision, outcome.status);
  return { ...outcome, urgencyScore: score, scoreExplanation: explanation, bookingEvaluations };
}
