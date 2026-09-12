import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, bookingsToEvaluate, evaluateBookings, urgencyLabel } from './model.js';

const day = 24 * 3600000;
const dischargeAt = 100 * day;

function verdictMap(entries) {
  return new Map(entries.map(([id, verdict, reason = 'stub reason']) => [id, { verdict, reason }]));
}

test('an ambiguous decision always needs review, regardless of bookings', () => {
  const result = reconcile({ ambiguous: true, careNeeded: true, careType: 'home-visit' }, [], dischargeAt);
  assert.equal(result.status, 'review');
});

test('no care needed is ok even with no bookings', () => {
  const result = reconcile({ ambiguous: false, careNeeded: false, careType: null }, [], dischargeAt);
  assert.equal(result.status, 'ok');
});

test('care needed but nothing booked after discharge is flagged', () => {
  const priorBooking = { id: 'b1', title: 'Home visit review', kind: 'appointment', startsAt: dischargeAt - day };
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [priorBooking], dischargeAt);
  assert.equal(result.status, 'flag');
});

test('care needed and an agent-confirmed matching post-discharge booking is ok', () => {
  const booking = { id: 'b2', title: 'District nursing wound care', kind: 'appointment', startsAt: dischargeAt + day };
  const matchVerdicts = verdictMap([['b2', 'matches', 'Booking is a district nursing wound-care visit.']]);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'district-nursing' }, [booking], dischargeAt, matchVerdicts);
  assert.equal(result.status, 'ok');
});

test('care needed but the agent confirms the only booking is a different care type, so it is flagged', () => {
  const booking = { id: 'b3', title: 'Physiotherapy session', kind: 'appointment', startsAt: dischargeAt + day };
  const matchVerdicts = verdictMap([['b3', 'no-match', 'Booking is physiotherapy, not a home visit.']]);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt, matchVerdicts);
  assert.equal(result.status, 'flag');
});

test('an agent-ambiguous verdict on a too-terse booking needs review, not a claimed match or flag', () => {
  // "hi" is a real example of a bare NHS-SIM booking title (see AGENTS.md) —
  // too terse for the care-match agent to confidently say either way.
  const booking = { id: 'b4', title: 'hi', kind: 'appointment', startsAt: dischargeAt + day };
  const matchVerdicts = verdictMap([['b4', 'ambiguous', 'Title "hi" gives no detail on what care was delivered.']]);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt, matchVerdicts);
  assert.equal(result.status, 'review');
  assert.match(result.reason, /could not be confidently matched/);
});

test('a mix of a confirmed non-match and an ambiguous verdict (no confirmed match) needs review, not a flag', () => {
  const noMatch = { id: 'b5a', title: 'Physiotherapy session', kind: 'appointment', startsAt: dischargeAt + day };
  const ambiguous = { id: 'b5b', title: 'visit', kind: 'appointment', startsAt: dischargeAt + day };
  const matchVerdicts = verdictMap([
    ['b5a', 'no-match', 'Physiotherapy does not deliver a home visit.'],
    ['b5b', 'ambiguous', 'Title "visit" gives no detail.'],
  ]);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [noMatch, ambiguous], dischargeAt, matchVerdicts);
  assert.equal(result.status, 'review');
});

test('one confirmed match among other bookings is still ok, even with a non-match alongside it', () => {
  const matching = { id: 'b6a', title: 'Home visit follow-up', kind: 'appointment', startsAt: dischargeAt + day };
  const notMatching = { id: 'b6b', title: 'Physiotherapy session', kind: 'appointment', startsAt: dischargeAt + day };
  const matchVerdicts = verdictMap([
    ['b6a', 'matches', 'Booking is a home visit follow-up.'],
    ['b6b', 'no-match', 'Physiotherapy does not deliver a home visit.'],
  ]);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [matching, notMatching], dischargeAt, matchVerdicts);
  assert.equal(result.status, 'ok');
});

test('a booking with no recorded start time is treated as not provably before discharge', () => {
  const booking = { id: 'b7', title: 'Home visit', kind: 'appointment', startsAt: undefined };
  const matchVerdicts = verdictMap([['b7', 'matches', 'Booking is a home visit.']]);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt, matchVerdicts);
  assert.equal(result.status, 'ok');
});

test('urgency score ranks clinical urgency above confirmation certainty', () => {
  const urgentFlag = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit', urgency: 'urgent' }, [], dischargeAt);
  const urgentReview = reconcile({ ambiguous: true, careNeeded: true, careType: 'home-visit', urgency: 'urgent' }, [], dischargeAt);
  const routineFlag = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit', urgency: 'routine' }, [], dischargeAt);
  const routineReview = reconcile({ ambiguous: true, careNeeded: true, careType: 'home-visit', urgency: 'routine' }, [], dischargeAt);
  const ok = reconcile({ ambiguous: false, careNeeded: false, careType: null, urgency: null }, [], dischargeAt);

  // Both urgent outcomes outrank both routine outcomes, regardless of
  // whether the gap was confirmed ("flag") or only suspected ("review").
  assert.ok(urgentFlag.urgencyScore > urgentReview.urgencyScore);
  assert.ok(urgentReview.urgencyScore > routineFlag.urgencyScore);
  assert.ok(routineFlag.urgencyScore > routineReview.urgencyScore);
  assert.ok(routineReview.urgencyScore > ok.urgencyScore);
  assert.equal(ok.urgencyScore, 0);
});

test('a match has no urgency score even when the note itself was urgent', () => {
  const booking = { id: 'b8', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt + day };
  const matchVerdicts = verdictMap([['b8', 'matches', 'Booking is a home visit.']]);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit', urgency: 'urgent' }, [booking], dischargeAt, matchVerdicts);
  assert.equal(result.status, 'ok');
  assert.equal(result.urgencyScore, 0);
});

test('urgencyLabel describes the score band', () => {
  assert.equal(urgencyLabel(100), 'Urgent gap');
  assert.equal(urgencyLabel(80), 'Urgent — needs review');
  assert.equal(urgencyLabel(50), 'Needs follow-up');
  assert.equal(urgencyLabel(30), 'Needs review');
  assert.equal(urgencyLabel(0), 'None');
});

test('reconcile explains its urgency score, not just the number', () => {
  const flag = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit', urgency: 'urgent' }, [], dischargeAt);
  assert.match(flag.scoreExplanation, /confirmed gap/);
  assert.match(flag.scoreExplanation, /urgent/);
  const ok = reconcile({ ambiguous: false, careNeeded: false, careType: null }, [], dischargeAt);
  assert.match(ok.scoreExplanation, /nothing to triage/);
});

test('bookingsToEvaluate returns nothing when the decision is ambiguous or no care is needed', () => {
  const booking = { id: 'c1', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt + day };
  assert.deepEqual(bookingsToEvaluate({ ambiguous: true, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt), []);
  assert.deepEqual(bookingsToEvaluate({ ambiguous: false, careNeeded: false, careType: null }, [booking], dischargeAt), []);
});

test('bookingsToEvaluate excludes bookings made before discharge', () => {
  const before = { id: 'c2', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt - day };
  const after = { id: 'c3', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt + day };
  const decision = { ambiguous: false, careNeeded: true, careType: 'home-visit' };
  const result = bookingsToEvaluate(decision, [before, after], dischargeAt);
  assert.deepEqual(result.map((b) => b.id), ['c3']);
});

test('evaluateBookings gives every booking a verdict, including ones the outcome does not turn on', () => {
  const priorBooking = { id: 'p1', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt - day };
  const matchingBooking = { id: 'p2', title: 'Home visit follow-up', kind: 'appointment', startsAt: dischargeAt + day };
  const decision = { ambiguous: false, careNeeded: true, careType: 'home-visit' };
  const matchVerdicts = verdictMap([['p2', 'matches', 'Booking is a home visit follow-up.']]);
  const evaluations = evaluateBookings(decision, [priorBooking, matchingBooking], dischargeAt, matchVerdicts);

  const before = evaluations.find((e) => e.id === 'p1');
  assert.equal(before.afterDischarge, false);
  assert.equal(before.matches, null);
  assert.match(before.reason, /before discharge/);

  const after = evaluations.find((e) => e.id === 'p2');
  assert.equal(after.afterDischarge, true);
  assert.equal(after.matches, true);
});

test('evaluateBookings marks every booking unchecked when the decision was ambiguous', () => {
  const booking = { id: 'p3', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt + day };
  const evaluations = evaluateBookings({ ambiguous: true, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt);
  assert.equal(evaluations[0].matches, null);
  assert.match(evaluations[0].reason, /ambiguous/);
});
