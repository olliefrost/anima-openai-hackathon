import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, matchesCareType, urgencyLabel } from './model.js';

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
