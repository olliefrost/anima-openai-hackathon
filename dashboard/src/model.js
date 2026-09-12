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

// decision: { careNeeded, careType, ambiguous } from careAgent.js
// bookings: normalized community records for this patient, each with a
//           `startsAt` timestamp where known
// dischargeAt: timestamp the discharge note was sent, for "booked after
//              discharge" comparisons
export function reconcile(decision, bookings, dischargeAt) {
  if (decision.ambiguous) {
    return { status: 'review', reason: 'The discharge note decision was ambiguous and needs a human read.' };
  }

  if (!decision.careNeeded) {
    return { status: 'ok', reason: 'No follow-on community care identified as needed from the discharge note.' };
  }

  const postDischarge = bookings.filter(
    (booking) => !Number.isFinite(dischargeAt) || !Number.isFinite(booking.startsAt) || booking.startsAt >= dischargeAt
  );

  if (postDischarge.length === 0) {
    return { status: 'flag', reason: `Discharge note calls for ${decision.careType || 'follow-up care'}, but no community booking was found after discharge.` };
  }

  const checks = postDischarge.map((booking) => matchesCareType(booking, decision.careType));

  if (checks.some((check) => check === true)) {
    return { status: 'ok', reason: `Booked community care matches the recommended ${decision.careType}.` };
  }

  if (checks.every((check) => check === false)) {
    return { status: 'flag', reason: `Booked community care does not appear to match the recommended ${decision.careType}.` };
  }

  return { status: 'review', reason: `Could not confidently match booked community care against the recommended ${decision.careType || 'care type'}; needs a human read.` };
}
