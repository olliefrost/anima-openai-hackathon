import test from 'node:test';
import assert from 'node:assert/strict';
import { latestFiledDischarges } from './server.js';

test('only filed discharge summaries are selected', () => {
  const latest = latestFiledDischarges([
    { id: 'filed', kind: 'discharge-summary', status: 'filed', patientId: 'p1', createdAt: 100 },
    { id: 'newer-sent', kind: 'discharge-summary', status: 'sent', patientId: 'p1', createdAt: 200 },
    { id: 'draft', kind: 'discharge-summary', status: 'draft', patientId: 'p2', createdAt: 300 },
    { id: 'other', kind: 'clinical-note', status: 'filed', patientId: 'p3', createdAt: 400 },
  ]);

  assert.equal(latest.get('p1')?.id, 'filed');
  assert.equal(latest.has('p2'), false);
  assert.equal(latest.has('p3'), false);
});

test('the newest filed discharge summary is selected by sent time', () => {
  const latest = latestFiledDischarges([
    { id: 'newer-created', kind: 'discharge-summary', status: 'filed', patientId: 'p1', createdAt: 300, data: { sentAt: 100 } },
    { id: 'newer-sent', kind: 'discharge-summary', status: 'filed', patientId: 'p1', createdAt: 200, data: { sentAt: 200 } },
  ]);

  assert.equal(latest.get('p1')?.id, 'newer-sent');
});
