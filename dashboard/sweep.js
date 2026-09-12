import { createHash } from 'node:crypto';

export function createDecisionCache(evaluate, now = Date.now) {
  const entries = new Map();
  return async (teamKey, input) => {
    const key = createHash('sha256').update(JSON.stringify([teamKey, input])).digest('hex');
    const existing = entries.get(key);
    if (existing && existing.expiresAt > now()) return existing.promise;

    const entry = { expiresAt: now() + 5 * 60_000 };
    entry.promise = Promise.resolve().then(() => evaluate(input));
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > 500) entries.delete(entries.keys().next().value);
    try {
      return await entry.promise;
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  };
}

export async function checkSweep(patientIds, checkPatient, onProgress = () => {}) {
  const results = new Array(patientIds.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < patientIds.length) {
      const index = next++;
      const patientId = patientIds[index];
      try {
        results[index] = await checkPatient(patientId);
      } catch {
        results[index] = { patientId, status: 'check-failed', error: 'Patient check failed. Retry this patient individually.' };
      }
      onProgress(++done, patientIds.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(12, patientIds.length) }, worker));
  return results;
}
