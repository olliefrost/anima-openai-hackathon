import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSweep, createDecisionCache } from './sweep.js';

test('sweep checks 99 patients concurrently with a bounded worker pool and stable results', async () => {
  const ids = Array.from({ length: 99 }, (_, index) => `demo-${index}`);
  let active = 0;
  let peak = 0;
  const seen = [];
  const progress = [];
  const results = await checkSweep(ids, async (patientId) => {
    seen.push(patientId);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (patientId === 'demo-3') throw new Error('private upstream detail');
    return { patientId };
  }, (done, total) => progress.push({ done, total }));
  assert.equal(peak, 12);
  assert.equal(seen.length, 99);
  assert.equal(new Set(seen).size, 99);
  assert.deepEqual(results.map((result) => result.patientId), ids);
  assert.equal(results[3].status, 'check-failed');
  assert.ok(!results[3].error.includes('private'));
  assert.deepEqual(results[98], { patientId: 'demo-98' });
  assert.deepEqual(progress, ids.map((_, index) => ({ done: index + 1, total: ids.length })));
});

test('empty sweep performs no patient checks', async () => {
  assert.deepEqual(await checkSweep([], () => assert.fail('unexpected check')), []);
});

test('decision cache shares concurrent work and invalidates changed inputs, teams, and expired entries', async () => {
  let calls = 0;
  let time = 0;
  const evaluate = createDecisionCache(async () => ++calls, () => time);
  const input = { sections: { followUp: 'Demo note' }, patient: { id: 'demo-1' } };
  assert.deepEqual(await Promise.all([evaluate('demo-team', input), evaluate('demo-team', input)]), [1, 1]);
  assert.equal(await evaluate('demo-team', input), 1);
  assert.equal(await evaluate('other-demo-team', input), 2);
  assert.equal(await evaluate('demo-team', { ...input, sections: { followUp: 'Changed' } }), 3);
  assert.equal(await evaluate('demo-team', { ...input, patient: { id: 'demo-2' } }), 4);
  time = 300_000;
  assert.equal(await evaluate('demo-team', input), 5);
});

test('failed decisions are retried instead of cached', async () => {
  let calls = 0;
  const evaluate = createDecisionCache(async () => {
    if (++calls === 1) throw new Error('Demo failure');
    return 'success';
  });
  await assert.rejects(evaluate('demo-team', {}));
  assert.equal(await evaluate('demo-team', {}), 'success');
});

test('decision cache retains at most 500 entries', async () => {
  let calls = 0;
  const evaluate = createDecisionCache(async () => ++calls);
  for (let id = 0; id <= 500; id++) await evaluate('demo-team', { id });
  assert.equal(await evaluate('demo-team', { id: 0 }), 502);
});
