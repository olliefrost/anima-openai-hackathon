import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, matchesCareType } from './model.js';

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
