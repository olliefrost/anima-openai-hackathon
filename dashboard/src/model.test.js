import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, matchesCareType, matchExplanation, evaluateBookings, urgencyLabel } from './model.js';

const day = 24 * 3600000;
const dischargeAt = 100 * day;

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

test('care needed and a matching post-discharge booking is ok', () => {
  const booking = { id: 'b2', title: 'District nursing wound care', kind: 'appointment', startsAt: dischargeAt + day };
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'district-nursing' }, [booking], dischargeAt);
  assert.equal(result.status, 'ok');
});

test('care needed but the only booking is a different care type is flagged', () => {
  const booking = { id: 'b3', title: 'Physiotherapy session', kind: 'appointment', startsAt: dischargeAt + day };
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt);
  assert.equal(result.status, 'flag');
});

test('an unverifiable care type ("other") with a booking present needs review, not a claimed match', () => {
  const booking = { id: 'b4', title: 'Community follow-up', kind: 'appointment', startsAt: dischargeAt + day };
  assert.equal(matchesCareType(booking, 'other'), null);
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'other' }, [booking], dischargeAt);
  assert.equal(result.status, 'review');
  // The reason itself must say *why*: "other" has no keyword set to check
  // against, not "the booking text didn't say enough" — those are different
  // causes and a reviewer shouldn't have to dig into bookingEvaluations to
  // tell them apart.
  assert.match(result.reason, /no defined keyword set/);
});

test('a checkable care type with too-terse booking text is a confirmed non-match, not "review"', () => {
  // "hi" is a real example of a bare NHS-SIM booking title (see AGENTS.md) —
  // it fails every keyword check, same as a genuinely unrelated booking. That
  // under-detection is a known precision limit of text matching, not a case
  // this tool can distinguish from "flag" without guessing.
  const booking = { id: 'b4b', title: 'hi', kind: 'appointment', startsAt: dischargeAt + day };
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt);
  assert.equal(result.status, 'flag');
});

test('a booking with no recorded start time is treated as not provably before discharge', () => {
  const booking = { id: 'b5', title: 'Home visit', kind: 'appointment', startsAt: undefined };
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit' }, [booking], dischargeAt);
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
  const booking = { id: 'b6', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt + day };
  const result = reconcile({ ambiguous: false, careNeeded: true, careType: 'home-visit', urgency: 'urgent' }, [booking], dischargeAt);
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

test('matchExplanation names the keyword that matched', () => {
  const booking = { id: 'b7', title: 'District nursing wound care', kind: 'appointment' };
  const result = matchExplanation(booking, 'district-nursing');
  assert.equal(result.matches, true);
  assert.match(result.reason, /district nurs/);
});

test('matchExplanation says why a booking did not match', () => {
  const booking = { id: 'b8', title: 'Physiotherapy session', kind: 'appointment' };
  const result = matchExplanation(booking, 'home-visit');
  assert.equal(result.matches, false);
  assert.match(result.reason, /home-visit/);
});

test('matchExplanation says why "other" cannot be verified', () => {
  const booking = { id: 'b9', title: 'Community follow-up', kind: 'appointment' };
  const result = matchExplanation(booking, 'other');
  assert.equal(result.matches, null);
  assert.match(result.reason, /no defined keyword set/);
});

test('evaluateBookings gives every booking a verdict, including ones the outcome does not turn on', () => {
  const priorBooking = { id: 'p1', title: 'Home visit', kind: 'appointment', startsAt: dischargeAt - day };
  const matchingBooking = { id: 'p2', title: 'Home visit follow-up', kind: 'appointment', startsAt: dischargeAt + day };
  const decision = { ambiguous: false, careNeeded: true, careType: 'home-visit' };
  const evaluations = evaluateBookings(decision, [priorBooking, matchingBooking], dischargeAt);

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
