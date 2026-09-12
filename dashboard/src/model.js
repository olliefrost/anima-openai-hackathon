export const sites = ['gp', 'pharmacy', 'community'];
const closed = new Set(['completed', 'complete', 'dispensed', 'collected', 'cancelled', 'canceled', 'resolved', 'closed', 'discharged', 'fulfilled']);
export function aggregate(sources, now) {
  const records = new Map();
  for (const source of sources) for (const resource of source.resources || []) {
    const prior = records.get(resource.id);
    const seenIn = [...new Set([...(prior?.seenIn || []), source.site])];
    records.set(resource.id, { ...(prior && prior.version > resource.version ? prior : resource), seenIn });
  }
  return [...records.values()].filter(r => r.patientId).map(r => {
    const done = closed.has(String(r.status).toLowerCase());
    const overdue = !done && Number.isFinite(r.dueAt) && r.dueAt < now;
    const blocked = !done && /blocked|failed|rejected|on[-_ ]hold|awaiting[-_ ]stock/i.test(r.status);
    const ageHours = Math.max(0, (now - r.createdAt) / 3600000);
    const stale = !done && !r.dueAt && ageHours >= 48;
    return { ...r, done, overdue, blocked, ageHours, attention: overdue || blocked || stale,
      reason: done ? 'Recorded as complete' : overdue ? 'Past the recorded due time' : blocked ? `Source status: ${r.status}` : stale ? 'Open for 48+ hours; no due time recorded' : 'Awaiting completion',
      score: overdue ? 3 : blocked ? 2 : stale ? 1 : 0 };
  }).sort((a,b) => b.score-a.score || (a.dueAt ?? Infinity)-(b.dueAt ?? Infinity) || a.createdAt-b.createdAt);
}
