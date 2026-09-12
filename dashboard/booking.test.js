import test from 'node:test';
import assert from 'node:assert/strict';
import { postAction, scheduleHomeVisit } from './server.js';

const visit = { id: 'demo-visit', kind: 'visit', patientId: 'DEMO-1', title: 'Home visit', createdAt: 1789200000000, dueAt: Date.UTC(2026, 8, 13, 13) };
const input = { patientId: 'DEMO-1', title: 'Home visit', text: '' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('booking uses the connected team and queues SMS with the confirmed London time', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), ...init, body: JSON.parse(init.body) });
    return response(calls.length === 1 ? visit : { id: 'demo-message' });
  });
  const result = await scheduleHomeVisit('demo-team', input, 'demo-intent');
  assert.equal(result.notified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Bearer demo-team');
  assert.equal(calls[1].headers.Authorization, 'Bearer demo-team');
  assert.equal(calls[0].body.text, undefined);
  assert.match(calls[0].url, /community\/actions$/);
  assert.match(calls[1].url, /gp\/actions$/);
  assert.equal(calls[1].headers['Idempotency-Key'], 'demo-intent-notify');
  assert.match(calls[1].body.messagingCommand.body, /13 September 2026.*14:00/);
});

test('missing dueAt never substitutes record creation time in the SMS', async (t) => {
  let message;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('/community/')) return response({ ...visit, dueAt: undefined });
    message = JSON.parse(init.body).messagingCommand.body;
    return response({ id: 'demo-message' });
  });
  await scheduleHomeVisit('demo-team', input, 'demo-intent');
  assert.match(message, /confirm a time separately/);
  assert.doesNotMatch(message, /September/);
});

test('failed SMS preserves the successful booking without repeating it', async (t) => {
  const calls = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? response(visit) : response({ error: 'Denied' }, 403);
  });
  const result = await scheduleHomeVisit('demo-team', input, 'demo-intent');
  assert.equal(result.booking.id, visit.id);
  assert.equal(result.notified, false);
  assert.equal(calls.length, 2);
});

test('transient POST retries reuse the intent and get a fresh timeout signal', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(init);
    if (calls.length === 1) throw new Error('Network unavailable');
    return response(visit);
  });
  await postAction('demo-team', 'community', input, 'demo-intent');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].signal, calls[1].signal);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});

test('failed booking never triggers SMS', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return response({ error: 'Invalid key' }, 401);
  });
  await assert.rejects(scheduleHomeVisit('demo-team', input, 'demo-intent'), /Invalid simulator team key/);
  assert.equal(calls, 1);
});
