import test from 'node:test';
import assert from 'node:assert/strict';
import { postAction, scheduleHomeVisit } from './server.js';

const visit = { id: 'demo-visit', kind: 'visit', patientId: 'DEMO-1', title: 'Home visit', createdAt: 1789200000000, dueAt: Date.UTC(2026, 8, 13, 13) };
const input = { patientId: 'DEMO-1', title: 'Home visit', text: '' };
// A created conversation as NHS-SIM returns it: the outgoing entry inside it is
// what the follow-up delivery command marks delivered.
const conversation = { id: 'demo-message', version: 1, data: { entries: [{ id: 'demo-message-1', direction: 'outgoing' }] } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('booking sends the confirmed London time and delivers the queued SMS', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), ...init, body: JSON.parse(init.body) });
    return response(calls.length === 1 ? visit : conversation);
  });
  const result = await scheduleHomeVisit('demo-team', input, 'demo-intent');
  assert.equal(result.notified, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.Authorization, 'Bearer demo-team');
  assert.equal(calls[1].headers.Authorization, 'Bearer demo-team');
  assert.equal(calls[0].body.text, undefined);
  assert.match(calls[0].url, /community\/actions$/);
  assert.match(calls[1].url, /gp\/actions$/);
  assert.equal(calls[1].headers['Idempotency-Key'], 'demo-intent-notify');
  assert.match(calls[1].body.messagingCommand.body, /13 September 2026.*14:00/);

  // Without this second command the message stays queued and the patient never sees it.
  assert.match(calls[2].url, /gp\/actions$/);
  assert.equal(calls[2].headers['Idempotency-Key'], 'demo-intent-deliver');
  assert.equal(calls[2].body.resourceId, conversation.id);
  assert.equal(calls[2].body.expectedVersion, conversation.version);
  assert.deepEqual(calls[2].body.messagingCommand, { kind: 'delivery', entryId: 'demo-message-1', status: 'delivered' });
});

test('missing dueAt never substitutes record creation time in the SMS', async (t) => {
  let message;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('/community/')) return response({ ...visit, dueAt: undefined });
    const body = JSON.parse(init.body);
    if (body.messagingCommand.kind === 'create') message = body.messagingCommand.body;
    return response(conversation);
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

test('an SMS that is created but never delivered is not reported as notified', async (t) => {
  const calls = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) return response(visit);
    if (calls.length === 2) return response(conversation);
    return response({ error: 'Conflict' }, 409);
  });
  const result = await scheduleHomeVisit('demo-team', input, 'demo-intent');
  assert.equal(result.booking.id, visit.id);
  assert.equal(result.notified, false);
  assert.equal(calls.length, 3);
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
