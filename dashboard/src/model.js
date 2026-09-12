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

// Returns true/false when the care type has a known keyword set, or null
// when the type can't be checked this way (currently only `other`).
export function matchesCareType(booking, careType) {
  const keywords = careTypeKeywords[careType];
  if (!keywords) return null;
  const haystack = bookingText(booking);
  return keywords.some((keyword) => haystack.includes(keyword));
}

function outcomeFor(decision, bookings, dischargeAt) {
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
  const postDischarge = bookings.filter(
    (booking) => !Number.isFinite(dischargeAt) || !Number.isFinite(booking.startsAt) || booking.startsAt >= dischargeAt
  );

  if (postDischarge.length === 0) {
    return { status: 'flag', reason: `Discharge note calls for ${decision.careType || 'follow-up care'}, but no community booking was found after discharge.` };
  }

  // `matchesCareType` returns true, false, or null (unverifiable) per booking.
  // Any confirmed match is enough to call it ok; only when every booking is a
  // *confirmed* non-match do we flag a gap. A `null` in the mix (an
  // unverifiable care type, or — see `bookingText` above — a booking whose
  // title just doesn't say enough) means neither "ok" nor "flag" is honest,
  // so it falls through to "review" instead of guessing either way.
  const checks = postDischarge.map((booking) => matchesCareType(booking, decision.careType));

  if (checks.some((check) => check === true)) {
    return { status: 'ok', reason: `Booked community care matches the recommended ${decision.careType}.` };
  }

  if (checks.every((check) => check === false)) {
    return { status: 'flag', reason: `Booked community care does not appear to match the recommended ${decision.careType}.` };
  }

  return { status: 'review', reason: `Could not confidently match booked community care against the recommended ${decision.careType || 'care type'}; needs a human read.` };
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

function urgencyScoreFor(decision, status) {
  const band = URGENCY_SCORES[status];
  if (!band) return 0;
  return decision.urgency === 'urgent' ? band.urgent : band.routine;
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
  const outcome = outcomeFor(decision, bookings, dischargeAt);
  return { ...outcome, urgencyScore: urgencyScoreFor(decision, outcome.status) };
}
